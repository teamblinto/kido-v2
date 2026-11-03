import type { OauthProvider } from '@repo/contracts';

/**
 * The seam between the provider-agnostic core and the two provider adapters (T22, T23).
 *
 * The port exists so `OauthService` can own the parts that are the same for every provider — the
 * `state`, the PKCE pair, the single-use consumption, the account resolution, the session — and
 * know nothing about how an identity was established. GitHub proves an address with a second REST
 * call; Google proves one with a signed `id_token` verified against a rotating key set. Neither
 * difference is visible past {@link OauthProviderPort.identify}.
 */

/**
 * The result of a completed exchange: who the provider says this is, and whether it will vouch for
 * an address.
 *
 * A discriminated union rather than `{ email: string | null; emailVerified: boolean }`, and this is
 * the single most load-bearing decision in the module. Criterion 9 links an OAuth identity to an
 * existing local account **only after proof of email control**, and the failure that property
 * guards against is not exotic — it is one `if` written the wrong way round, after which anybody
 * who can get a provider to *display* an address they do not own can take over the local account
 * that holds it.
 *
 * With a boolean beside a nullable string, "did we check the flag?" is a question about every call
 * site forever. With this union there is no address to reach for on the arm where nothing was
 * proved: {@link UnverifiedIdentity} does not carry one, so the linking path cannot be written
 * incorrectly, only refused to compile.
 */
export type ProviderIdentity = UnverifiedIdentity | VerifiedIdentity;

/**
 * The provider asserted it has verified the user controls {@link VerifiedIdentity.email}.
 *
 * "Verified" means what each provider's own documentation means by it — GitHub's `user/emails`
 * entry with `verified: true`, Google's `email_verified` claim — and nothing weaker. It is the only
 * thing in this module that may be matched against `users.email`.
 */
export interface VerifiedIdentity {
  readonly email: string;
  readonly kind: 'verified';
  /** The provider's immutable subject. Never the address, which users change. */
  readonly providerUserId: string;
}

/**
 * The provider named no address, or named one it has not verified.
 *
 * It deliberately carries no email at all — not even for logging. An unverified address is an
 * unauthenticated string that reached us through two redirects, and the moment it is a field on
 * this type it is a field somebody reads "just for the audit trail" and then, three commits later,
 * matches on.
 *
 * An identity in this state is still a perfectly good *sign-in* for an account that has already
 * been linked: the link was made on proof, and the user later unverifying their GitHub address does
 * not unmake it. What it can never do is create a link.
 */
export interface UnverifiedIdentity {
  readonly kind: 'unverified';
  readonly providerUserId: string;
}

/** What the core hands a provider to build the URL the browser is bounced to. */
export interface AuthorizationRequest {
  /** The base64url SHA-256 of the verifier the core is holding. */
  readonly codeChallenge: string;
  readonly redirectUri: string;
  /** Opaque, single-use, minted and stored by the core. The provider only echoes it back. */
  readonly state: string;
}

/** What the core hands a provider to turn an authorization code into an identity. */
export interface ExchangeRequest {
  readonly code: string;
  /** The PKCE verifier the challenge was derived from, read back out of the state record. */
  readonly codeVerifier: string;
  /** Byte-for-byte the value sent to the authorization endpoint; providers check the match. */
  readonly redirectUri: string;
}

/**
 * One federated provider.
 *
 * Adapters are ordinary Nest providers rather than values in a map, because both of them need
 * configuration and a logger, and T23's Google adapter additionally needs a cached, rotating key
 * set — none of which a plain object literal could hold.
 */
export interface OauthProviderPort {
  /**
   * Where to send the browser. Called only after {@link isConfigured} answered true, so an adapter
   * may assume its client id exists rather than returning a URL with `undefined` in it.
   */
  authorizationUrl(request: AuthorizationRequest): string;

  /**
   * Exchange the code and establish who this is.
   *
   * Throws `OauthExchangeError` when the provider will not produce an identity at all — a refused
   * code, an unreachable host, a response that is not the documented shape. It does **not** throw
   * for an address the provider declined to vouch for: that is an ordinary answer with a
   * `kind: 'unverified'` in it, and what it means depends on whether the identity is already
   * linked, which is the core's question rather than the adapter's.
   */
  identify(request: ExchangeRequest): Promise<ProviderIdentity>;

  /**
   * Whether this deployment has credentials for the provider.
   *
   * `environment.ts` validates the id and the secret both-or-neither, so there is no half-configured
   * state for this to have an opinion about: it is the question "was this provider switched on?",
   * asked at the top of both routes.
   */
  isConfigured(): boolean;

  readonly provider: OauthProvider;
}

/**
 * The DI token the adapters are registered under, as a multi-provider list.
 *
 * A list the core indexes by `provider` rather than two injected classes, so adding a third
 * provider is one entry in `IdentityModule` and touches nothing in `OauthService`. `identity.module`
 * asserts every catalogued provider has exactly one adapter, which is what stops the list and the
 * `OAUTH_PROVIDERS` vocabulary drifting into a route that resolves to nothing.
 */
export const OAUTH_PROVIDERS_PORT = Symbol('forge.identity.oauthProviders');
