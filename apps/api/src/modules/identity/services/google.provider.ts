import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OauthProvider } from '@repo/contracts';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

import type { Environment } from '../../../config/environment';
import { OauthExchangeError } from './oauth.service';
import type {
  AuthorizationRequest,
  ExchangeRequest,
  OauthProviderPort,
  ProviderIdentity,
} from './oauth-provider.port';
import { fetchProviderJson } from './provider-fetch';

/**
 * The three Google endpoints, behind a DI token for the reasons {@link GITHUB_ENDPOINTS} gives: the
 * e2e suite points them at a local stub, and they are not a deployment's decision the way a client
 * id is — `accounts.google.com` is the answer everywhere, and three more optional
 * `GOOGLE_OAUTH_*_URL` variables would be three more ways for a misconfiguration to send an
 * authorization code, or trust a key set, from somewhere it should not.
 *
 * The issuer is deliberately **not** a member here. It is checked against the constant below, so
 * there is no configuration — and therefore no test override — that can relax it.
 */
export const GOOGLE_ENDPOINTS = Symbol('forge.identity.googleEndpoints');

export interface GoogleEndpoints {
  readonly authorize: string;
  /** Where the rotating public keys live. Google's OIDC discovery calls this `jwks_uri`. */
  readonly jwks: string;
  readonly token: string;
}

export const DEFAULT_GOOGLE_ENDPOINTS: GoogleEndpoints = Object.freeze({
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  jwks: 'https://www.googleapis.com/oauth2/v3/certs',
  token: 'https://oauth2.googleapis.com/token',
});

/**
 * Both spellings Google has ever put in an `iss`, and both are accepted by its own client
 * libraries. Anything else is somebody else's token.
 */
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/**
 * `openid` for an `id_token` at all, `email` for the address and its verification state.
 *
 * Not `profile`. Everything this adapter needs is the subject and the address, the consent screen
 * lists what we ask for, and a sign-in button that asks for a user's photograph and birthday to
 * create an account is one people read twice before pressing.
 */
const SCOPE = 'openid email';

/**
 * The only algorithm Google signs `id_token`s with, stated so that verification cannot be talked
 * into anything else.
 *
 * This is the classic JWT failure and it is worth being explicit about rather than trusting a
 * library default: a verifier that takes the algorithm from the token's own header will accept
 * `alg: none`, or an HMAC signed with the public key it was handed. `jose` refuses both on its own
 * — the key it gets from a JWKS is an asymmetric public key and it will not use one for HMAC — but
 * the allow-list is one line and makes the guarantee local rather than a fact about a dependency.
 */
const ALGORITHMS = ['RS256'];

/**
 * How long a fetched key set is used without asking again. Ten minutes: Google publishes a new key
 * long before it signs with one, so this is about *staleness*, not about rotation — the unknown-`kid`
 * path below is what handles rotation.
 */
const JWKS_CACHE_MAX_AGE_MS = 600_000;

/**
 * The floor between two refetches triggered by a `kid` the cached set does not hold.
 *
 * It exists so an unrecognised key cannot become a way to make us hammer Google's certs endpoint.
 * Thirty seconds is `jose`'s own default and is stated rather than inherited, because the value is
 * the difference between "rotation is picked up in seconds" and "rotation is an outage".
 */
const JWKS_COOLDOWN_MS = 30_000;

/** The certs endpoint serves a small static document; five seconds is already generous. */
const JWKS_TIMEOUT_MS = 5_000;

/**
 * A few seconds of slack on the time-based claims.
 *
 * Google stamps `nbf` as well as `exp`, and a host whose clock is a second or two behind Google's
 * would otherwise reject a token that is merely *young*. Measured against an `id_token` that lives
 * an hour, five seconds buys nothing an attacker can use and removes a class of sign-in failure
 * that reproduces on exactly one machine.
 */
const CLOCK_TOLERANCE_SECONDS = 5;

/**
 * The claims this adapter reads, and `loose` so a member Google adds does not fail a sign-in.
 *
 * Only `sub` is required, and only `sub` has a type. It is the immutable subject
 * `oauth_identities` is keyed by — never `email`, which users change — and without it there is no
 * identity to speak of, verified or otherwise.
 *
 * The other two are deliberately `unknown` rather than `boolean` and `string`, which is the
 * difference between two failure modes. Typed, a claim of an unexpected shape — Google sending the
 * string `'true'`, some future member arriving as a number — fails the parse, and a failed parse is
 * a `502` that refuses the sign-in outright. Untyped and checked below, the same token means
 * "nothing was proved", which is both more accurate and strictly safer: it still cannot link, and
 * an account that was linked years ago on proof still signs in, because the core resolves an
 * existing link before it ever asks about an address.
 *
 * The rule that survives either way is the one that matters: nothing but a JSON `true` beside a
 * non-empty string is ever treated as proof.
 */
const claimsSchema = z.looseObject({
  // `.optional()` and not merely `unknown`: a Zod 4 `unknown` still requires the key to be present,
  // and a token that omits `email` entirely — which is exactly what the `email` scope being refused
  // looks like — must reach the unverified arm rather than fail to parse.
  email: z.unknown().optional(),
  email_verified: z.unknown().optional(),
  sub: z.string().min(1),
});

/** The token response. The `access_token` beside it is never read: this flow wants the identity. */
const tokenSchema = z.looseObject({ id_token: z.string().min(1) });

/**
 * Google, as an {@link OauthProviderPort} (T23, criterion 9).
 *
 * The core in `OauthService` is untouched by this class: the `state`, PKCE, the single-use
 * consumption, and the rules about which local account a federated identity may become are the
 * same for both providers and are argued there. What is different about Google is only how an
 * identity is established, and it is the whole of this file.
 *
 * ## The `id_token`, and why the key set must not be pinned
 *
 * GitHub proves an address with a second authenticated REST call. Google proves one with a claim
 * inside a JWT it signed — so the proof is worth exactly what the signature check is worth, and the
 * signature check is worth exactly what the key material is worth.
 *
 * Google rotates its signing keys, frequently and without announcement; the certs endpoint holds a
 * handful at any moment and the set turns over on the order of days. So the key is fetched from
 * {@link GoogleEndpoints.jwks} and looked up by the token's `kid`, and **never** pinned to a
 * constant. A pinned key is not a security improvement that costs availability — it is an outage
 * with a date on it: every Google sign-in on the deployment fails, together, the first time Google
 * signs with a key minted after our release.
 *
 * `createRemoteJWKSet` is what makes that safe rather than merely dynamic, and the three properties
 * that matter are all in the constructor:
 *
 * - **It caches.** One key set per adapter instance, and the adapter is a singleton, so a sign-in
 *   costs no network call to the certs endpoint at all in the common case. Building the key set per
 *   request would fetch Google's certs on every sign-in — a cache that is rebuilt each time is not
 *   a cache, it is a hot loop with a dependency in it.
 * - **It refetches on an unrecognised `kid`.** That is rotation, handled: the first token signed
 *   with a new key misses the cache, the set is refetched, and the sign-in succeeds. No deploy, no
 *   restart, no expiry to wait out.
 * - **It cannot be made to refetch in a loop.** {@link JWKS_COOLDOWN_MS} is the floor between two
 *   miss-driven refetches.
 *
 * ## What is checked, and what each check is for
 *
 * The signature answers "Google wrote this". It is not sufficient on its own, and the other three
 * are not decoration:
 *
 * - **Issuer** — that it was Google and not another OIDC provider whose token happened to verify
 *   against a key set we were talked into fetching.
 * - **Audience** — that it was minted *for this client*. Without it, an `id_token` any other Google
 *   relying party obtained for the same user is a valid sign-in here: they are all signed by the
 *   same keys and they all name the same `sub`. `aud` is the only claim that distinguishes them.
 * - **Expiry** (and `nbf`) — that it is current. `exp` is checked by `jwtVerify` itself, which is
 *   why it is not a line of code below; {@link CLOCK_TOLERANCE_SECONDS} is the only local decision.
 *
 * A `nonce` is deliberately not minted. It defends the implicit and hybrid flows, where an
 * `id_token` arrives through the browser and could be swapped for another; here the token is read
 * out of the token endpoint's response body, over TLS, on a call authenticated with our client
 * secret and bound to a code that PKCE bound to this flow. There is no point in that path at which
 * a token from elsewhere can be injected, and `aud` refuses one issued for another client anyway.
 *
 * ## What never leaves this class
 *
 * The client secret, the authorization code and — the one this file adds — the `id_token`. It is a
 * bearer credential for the duration of its life and it carries the user's address in a form that
 * is trivially readable, so it is never logged, never stored, never attached to an error, and never
 * quoted in a message. When verification fails, what is logged is `jose`'s error *code*: it names
 * which check refused, which is what an operator needs, and contains nothing from the token.
 */
@Injectable()
export class GoogleProvider implements OauthProviderPort {
  readonly provider: OauthProvider = 'google';

  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly keys: ReturnType<typeof createRemoteJWKSet>;
  private readonly logger = new Logger(GoogleProvider.name);

  constructor(
    @Inject(GOOGLE_ENDPOINTS) private readonly endpoints: GoogleEndpoints,
    config: ConfigService<Environment, true>,
  ) {
    this.clientId = config.get('GOOGLE_OAUTH_CLIENT_ID', { infer: true });
    this.clientSecret = config.get('GOOGLE_OAUTH_CLIENT_SECRET', { infer: true });
    // Constructed once, here, because the cache lives on this object. It performs no I/O until the
    // first token is verified, so an unconfigured deployment never touches the network for it.
    this.keys = createRemoteJWKSet(new URL(endpoints.jwks), {
      cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
      cooldownDuration: JWKS_COOLDOWN_MS,
      timeoutDuration: JWKS_TIMEOUT_MS,
    });
  }

  /**
   * Both halves, because `environment.ts` validates them both-or-neither and this is the assertion
   * that the validation is what makes the narrowing below safe rather than an assumption about it.
   */
  isConfigured(): boolean {
    return this.clientId !== undefined && this.clientSecret !== undefined;
  }

  authorizationUrl(request: AuthorizationRequest): string {
    const url = new URL(this.endpoints.authorize);

    url.search = new URLSearchParams({
      client_id: this.clientId ?? '',
      code_challenge: request.codeChallenge,
      code_challenge_method: 'S256',
      redirect_uri: request.redirectUri,
      response_type: 'code',
      scope: SCOPE,
      state: request.state,
    }).toString();

    return url.toString();
  }

  async identify(request: ExchangeRequest): Promise<ProviderIdentity> {
    const claims = await this.verify(await this.exchange(request));

    // Criterion 9's refusal, at the adapter. Both halves are required and neither implies the
    // other: Google omits `email` entirely when the `email` scope was not granted, and sends
    // `email_verified: false` for an address on an unverified Workspace domain — an address whose
    // domain owner has not been proved, which is precisely a stranger's address on a domain
    // somebody else runs. Either way there is no address to hand back, and the union arm below has
    // nowhere to put one.
    if (claims.email_verified !== true || typeof claims.email !== 'string' || claims.email === '') {
      this.logger.warn('Google vouched for no verified address on this account');

      return { kind: 'unverified', providerUserId: claims.sub };
    }

    return { email: claims.email, kind: 'verified', providerUserId: claims.sub };
  }

  /**
   * The token call: `POST` with a form body, and `grant_type` — which Google requires and GitHub
   * does not — alongside the PKCE verifier and the redirect URI it will compare byte for byte.
   *
   * Unlike GitHub, a code Google will not honour is a `4xx`, so the shared helper's status check
   * catches most of it; the schema is what catches a `200` that carries no `id_token`, which is
   * what a deployment configured for the wrong response type would get.
   */
  private async exchange(request: ExchangeRequest): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.clientId ?? '',
      client_secret: this.clientSecret ?? '',
      code: request.code,
      code_verifier: request.codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: request.redirectUri,
    });
    const response = await this.fetchJson(this.endpoints.token, {
      body,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      method: 'POST',
    });
    const parsed = tokenSchema.safeParse(response);

    if (!parsed.success) {
      // The response is not quoted: on this arm it is a document from an upstream that may contain
      // anything, and on the success arm it contains an `id_token`. One log line cannot be written
      // that is safe on both.
      this.logger.warn('Google token exchange returned no id_token');

      throw new OauthExchangeError(this.provider);
    }

    return parsed.data.id_token;
  }

  /**
   * Signature, issuer, audience and expiry, against the rotating key set — then the claims.
   *
   * Every failure is one refusal. The token is not quoted, the failing claim's value is not
   * quoted, and the client is told `oauth-exchange-failed` whichever check refused: this route is
   * reachable only with a live `state` and the distinction is of no use to a caller, while the log
   * carries `jose`'s code so it is of every use to an operator.
   */
  private async verify(idToken: string): Promise<z.infer<typeof claimsSchema>> {
    try {
      const { payload } = await jwtVerify(idToken, this.keys, {
        algorithms: ALGORITHMS,
        // Never the empty string in practice: `isConfigured` gates both routes. If it somehow were,
        // it would match no token, which is the correct way for this line to be wrong.
        audience: this.clientId ?? '',
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        issuer: ISSUERS,
      });
      const parsed = claimsSchema.safeParse(payload);

      if (!parsed.success) {
        // A verified token with no `sub`. Google always sends one, so this is a fault rather than
        // an attack — but a subject we invented is a row in `oauth_identities` keyed on nothing.
        this.logger.warn('Google id_token verified but carried no usable subject');

        throw new OauthExchangeError(this.provider);
      }

      return parsed.data;
    } catch (cause) {
      if (cause instanceof OauthExchangeError) {
        throw cause;
      }

      this.logger.warn(`Google id_token rejected [reason=${codeOf(cause)}]`);

      throw new OauthExchangeError(this.provider);
    }
  }

  /** The shared network policy. See `provider-fetch.ts`; `jose` owns the JWKS fetch itself. */
  private fetchJson(url: string, init: RequestInit): Promise<unknown> {
    return fetchProviderJson(url, init, { logger: this.logger, provider: this.provider });
  }
}

/**
 * `jose` names its failures — `ERR_JWT_EXPIRED`, `ERR_JWT_CLAIM_VALIDATION_FAILED`,
 * `ERR_JWKS_NO_MATCHING_KEY`, `ERR_JWS_SIGNATURE_VERIFICATION_FAILED` — and the code is the one
 * part of a verification failure that is safe to write down: it says which check refused and
 * contains nothing from the token it refused.
 */
function codeOf(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const { code } = cause;

    if (typeof code === 'string') {
      return code;
    }
  }

  return 'unknown';
}
