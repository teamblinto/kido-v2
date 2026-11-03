import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OauthProvider } from '@repo/contracts';
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
 * The four GitHub endpoints, behind a DI token so a test can point them at a local stub and so
 * GitHub Enterprise Server — which serves the same API under a customer's own host — is a
 * configuration change rather than a fork of this adapter.
 *
 * A token rather than environment variables, deliberately. These are not a deployment's decision in
 * the way a client id is: `github.com` is the answer for every deployment we run, and four more
 * optional `GITHUB_OAUTH_*_URL` variables would be four more ways for a misconfiguration to send an
 * authorization code somewhere it should not go.
 */
export const GITHUB_ENDPOINTS = Symbol('forge.identity.githubEndpoints');

export interface GithubEndpoints {
  readonly authorize: string;
  readonly emails: string;
  readonly token: string;
  readonly user: string;
}

export const DEFAULT_GITHUB_ENDPOINTS: GithubEndpoints = Object.freeze({
  authorize: 'https://github.com/login/oauth/authorize',
  emails: 'https://api.github.com/user/emails',
  token: 'https://github.com/login/oauth/access_token',
  user: 'https://api.github.com/user',
});

/**
 * `read:user` for the subject, `user:email` for the addresses and their verification state.
 *
 * Deliberately nothing else. GitHub's consent screen lists what we ask for, and a login button that
 * asks for `repo` is a login button people decline — the connector in §12 is a GitHub *App* with
 * fine-grained per-repository permissions and asks separately, when there is something to ask about.
 */
const SCOPE = 'read:user user:email';

/** GitHub asks for this and pins the REST schema; without it the response shape is unversioned. */
const API_VERSION = '2022-11-28';

/**
 * Only the members this adapter reads, and `loose` so a field GitHub adds does not fail a sign-in.
 * `id` is a JSON number and is the immutable subject — `login` is not, because users rename.
 */
const userSchema = z.looseObject({ id: z.union([z.number().int(), z.string().min(1)]) });

const emailsSchema = z.array(
  z.looseObject({
    email: z.string().min(1),
    primary: z.boolean(),
    verified: z.boolean(),
  }),
);

/** The token response, in the JSON form `Accept: application/json` asks for. */
const tokenSchema = z.looseObject({ access_token: z.string().min(1) });

/**
 * GitHub, as an {@link OauthProviderPort} (T22, criterion 9).
 *
 * ## The property this class exists for
 *
 * `GET /user` answers with a profile whose `email` member is **the user's public profile address**.
 * It is not necessarily verified, it is not necessarily one GitHub has ever sent mail to, and it is
 * settable to any string in the account settings. Treating it as proof of control is the single
 * mistake that turns "sign in with GitHub" into an account takeover: register a GitHub account,
 * type a stranger's address into the public profile field, sign in here, and the flow links to
 * whoever holds that address.
 *
 * So this adapter never reads it. Proof comes from `GET /user/emails`, which returns one entry per
 * address with `verified` and `primary` beside it, and only an entry GitHub itself marks
 * `verified: true` is ever handed back — as a {@link VerifiedIdentity}, which is the only shape
 * `OauthService` can link on.
 *
 * The primary verified address is preferred and any other verified one is the fallback. Preferring
 * primary matters because it is the address the user thinks of as theirs and therefore the one most
 * likely to match an account already here; falling back matters because a user whose primary is a
 * `@users.noreply.github.com` alias would otherwise be unable to link an account they own.
 *
 * ## PKCE, on a provider that does not require it
 *
 * The challenge and verifier are sent anyway. GitHub's OAuth Apps do not document PKCE support and
 * ignore both parameters today; they are extra query and body members that cost nothing, they are
 * already correct on the day GitHub honours them, and — more usefully — they mean this adapter and
 * the Google one are exercised through the same code path in {@link OauthService} rather than
 * through two that only look alike. The defence that is actually load-bearing for GitHub is the
 * server-side single-use `state`, which is not the provider's to ignore.
 *
 * ## What never leaves this class
 *
 * The client secret, the authorization code and the access token. None is logged, none is stored,
 * none reaches a `DomainError`'s `detail` or `extensions`, and none is included in the message when
 * a call fails: {@link OauthExchangeError} carries the provider name and nothing else, and every
 * failure here is logged by *status*, never by body.
 */
@Injectable()
export class GithubProvider implements OauthProviderPort {
  readonly provider: OauthProvider = 'github';

  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly logger = new Logger(GithubProvider.name);

  constructor(
    @Inject(GITHUB_ENDPOINTS) private readonly endpoints: GithubEndpoints,
    config: ConfigService<Environment, true>,
  ) {
    this.clientId = config.get('GITHUB_OAUTH_CLIENT_ID', { infer: true });
    this.clientSecret = config.get('GITHUB_OAUTH_CLIENT_SECRET', { infer: true });
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
    const accessToken = await this.exchange(request);
    const providerUserId = String(
      (await this.call(this.endpoints.user, accessToken, userSchema)).id,
    );
    const email = pickVerified(await this.call(this.endpoints.emails, accessToken, emailsSchema));

    if (email === undefined) {
      // No address in the log. The point of this branch is that GitHub would not vouch for the one
      // it holds, and writing an unverified address into our own logs is the smaller version of the
      // mistake this whole class is shaped to avoid.
      this.logger.warn('GitHub vouched for no verified address on this account');

      return { kind: 'unverified', providerUserId };
    }

    return { email, kind: 'verified', providerUserId };
  }

  /**
   * The token call. `POST` with a form body and `Accept: application/json`, because GitHub's default
   * for this endpoint is a URL-encoded response body rather than JSON.
   *
   * GitHub answers `200` with `{ "error": "bad_verification_code" }` for a code it will not honour,
   * so the status is not the check — the presence of a usable `access_token` is, which is what the
   * schema makes structural.
   */
  private async exchange(request: ExchangeRequest): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.clientId ?? '',
      client_secret: this.clientSecret ?? '',
      code: request.code,
      code_verifier: request.codeVerifier,
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
      // The response is not quoted, and that is not squeamishness: on the failure arm it is a
      // document from an upstream that may contain anything, and on the success arm it contains an
      // access token. One log line cannot be written that is safe on both.
      this.logger.warn('GitHub token exchange returned no usable access token');

      throw new OauthExchangeError(this.provider);
    }

    return parsed.data.access_token;
  }

  /** An authenticated REST call, parsed against the members this adapter actually reads. */
  private async call<T>(url: string, accessToken: string, shape: z.ZodType<T>): Promise<T> {
    const body = await this.fetchJson(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        // Never logged: `redaction.ts` lists `req.headers.authorization`, and the transport scrubber
        // in `scrubber.ts` censors `Bearer …` wherever it appears in a rendered line.
        Authorization: `Bearer ${accessToken}`,
        'X-GitHub-Api-Version': API_VERSION,
      },
      method: 'GET',
    });
    const parsed = shape.safeParse(body);

    if (!parsed.success) {
      this.logger.warn(`GitHub answered ${url} with an unexpected shape`);

      throw new OauthExchangeError(this.provider);
    }

    return parsed.data;
  }

  /**
   * The network policy — timeout, refusal, and what may be logged — lives in `provider-fetch.ts`
   * and is shared with the Google adapter (T23) rather than written once per provider. Both talk to
   * a third party we do not control, on a path an unauthenticated caller can drive, and holding
   * that in one place is what stops the two from acquiring different timeouts by accident.
   */
  private fetchJson(url: string, init: RequestInit): Promise<unknown> {
    return fetchProviderJson(url, init, { logger: this.logger, provider: this.provider });
  }
}

/**
 * The primary verified address, or any verified one, or nothing.
 *
 * `verified` is checked on every candidate — including the primary — so there is no ordering of
 * this list that yields an unverified address. That is the whole function: it is written as two
 * `find`s over a filtered list rather than one pass with a preference, because a single pass is
 * where "primary wins" quietly outranks "verified is required".
 */
function pickVerified(
  emails: readonly { email: string; primary: boolean; verified: boolean }[],
): string | undefined {
  const verified = emails.filter((candidate) => candidate.verified);

  return (verified.find((candidate) => candidate.primary) ?? verified[0])?.email;
}
