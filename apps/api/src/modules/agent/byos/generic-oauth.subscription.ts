import type { ByosClientConfig } from './byos-config';
import {
  type BeginLink,
  type ExchangePending,
  type GrantResult,
  type RefreshResult,
  type SubscriptionClient,
  SubscriptionFailure,
} from './subscription-client.port';

/** The token endpoint's JSON answer (RFC 6749 § 5.1), as far as this client reads it. */
export type TokenResponse = Readonly<Record<string, unknown>>;

export interface GenericOAuthOptions {
  readonly fetch?: typeof globalThis.fetch;
  /** `BYOS_REFRESH_TIMEOUT_MS`: every provider call is bounded by it. */
  readonly timeoutMs?: number;
  /**
   * Where the account label comes from. The default is the `id_token`'s `email` claim; the
   * provider's sheet (T057/T059) replaces or confirms it.
   */
  readonly accountLabel?: (response: TokenResponse) => string | undefined;
}

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** The `email` claim of an unverified-read `id_token`: a display label, never an identity proof. */
export function emailClaim(response: TokenResponse): string | undefined {
  const idToken = response.id_token;
  if (typeof idToken !== 'string') return undefined;
  try {
    const claims = JSON.parse(
      Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { email?: unknown };
    return typeof claims.email === 'string' && claims.email !== '' ? claims.email : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A spec-conformant OAuth 2.0 subscription client (spec 032 T011): RFC 6749 code grant, RFC 7636
 * PKCE S256, RFC 8628 device grant and RFC 7009 revocation, over `fetch`, reading only its
 * `BYOS_<P>_*` set. Failures are classified, never forwarded: `invalid_grant` (and every other
 * 4xx refusal) is `rejected`, `access_denied` is `denied`, a network error, a timeout or a 5xx is
 * `unreachable`. It is the stand-in until a provider-specific adapter replaces it.
 */
export class GenericOAuthSubscription implements SubscriptionClient {
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly label: (response: TokenResponse) => string | undefined;

  constructor(
    private readonly config: ByosClientConfig,
    options: GenericOAuthOptions = {},
  ) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.label = options.accountLabel ?? emailClaim;
  }

  async begin(input: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }): Promise<BeginLink> {
    const { authorizeUrl, clientId, deviceUrl, scopes } = this.config;

    if (authorizeUrl !== undefined) {
      const url = new URL(authorizeUrl);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', input.redirectUri);
      url.searchParams.set('scope', scopes.join(' '));
      url.searchParams.set('state', input.state);
      url.searchParams.set('code_challenge', input.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      return { kind: 'redirect', url: url.toString() };
    }

    const { body } = await this.post(deviceUrl!, { client_id: clientId, scope: scopes.join(' ') });
    const { device_code, user_code, verification_uri, expires_in, interval } = body;
    if (
      typeof device_code !== 'string' ||
      typeof user_code !== 'string' ||
      typeof verification_uri !== 'string'
    ) {
      throw new SubscriptionFailure('unreachable');
    }
    return {
      deviceCode: device_code,
      expiresAt: new Date(Date.now() + (typeof expires_in === 'number' ? expires_in : 600) * 1000),
      intervalSeconds: typeof interval === 'number' ? interval : 5,
      kind: 'device',
      userCode: user_code,
      verificationUri: verification_uri,
    };
  }

  async exchange(input: {
    code?: string;
    deviceCode?: string;
    state: string;
    verifier: string;
    redirectUri: string;
  }): Promise<GrantResult | ExchangePending> {
    if (input.code !== undefined) {
      return this.labelled(
        await this.token({
          code: input.code,
          code_verifier: input.verifier,
          grant_type: 'authorization_code',
          redirect_uri: input.redirectUri,
        }),
      );
    }
    if (input.deviceCode === undefined) throw new SubscriptionFailure('rejected');

    try {
      return this.labelled(
        await this.token({ device_code: input.deviceCode, grant_type: DEVICE_GRANT }),
      );
    } catch (error) {
      if (error instanceof Pending) return { pending: true, retryAfterSeconds: error.seconds };
      throw error;
    }
  }

  async refresh(refreshToken: string): Promise<RefreshResult> {
    return this.grant(
      await this.token({ grant_type: 'refresh_token', refresh_token: refreshToken }),
      refreshToken,
    );
  }

  async revoke(refreshToken: string): Promise<void> {
    if (this.config.revokeUrl === undefined) return;
    await this.post(this.config.revokeUrl, {
      ...this.clientFields(),
      token: refreshToken,
      token_type_hint: 'refresh_token',
    });
  }

  private clientFields(): Record<string, string> {
    return {
      client_id: this.config.clientId,
      ...(this.config.clientSecret === undefined
        ? {}
        : { client_secret: this.config.clientSecret }),
    };
  }

  private async token(fields: Record<string, string>): Promise<TokenResponse> {
    const { body } = await this.post(this.config.tokenUrl, { ...this.clientFields(), ...fields });
    return body;
  }

  /** A new link's grant, which must name its account: the label is shown from then on. */
  private labelled(response: TokenResponse): GrantResult {
    const { grant, accountLabel } = this.grant(response);
    if (accountLabel === undefined) throw new SubscriptionFailure('rejected');
    return { accountLabel, grant };
  }

  /** A token answer as a grant; a refresh that omits a new refresh token keeps the old one. */
  private grant(response: TokenResponse, previousRefresh?: string): RefreshResult {
    const accessToken = response.access_token;
    const refreshToken =
      typeof response.refresh_token === 'string' ? response.refresh_token : previousRefresh;
    const accountLabel = this.label(response);
    if (typeof accessToken !== 'string' || refreshToken === undefined) {
      throw new SubscriptionFailure('rejected');
    }
    const expiresIn = typeof response.expires_in === 'number' ? response.expires_in : 3600;
    return {
      accountLabel,
      grant: {
        accessExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
        accessToken,
        refreshToken,
        scopes:
          typeof response.scope === 'string'
            ? response.scope.split(/\s+/).filter((scope) => scope !== '')
            : this.config.scopes,
      },
    };
  }

  private async post(
    url: string,
    fields: Record<string, string>,
  ): Promise<{ body: TokenResponse }> {
    let response: Response;
    let text: string;
    try {
      response = await this.fetch(url, {
        body: new URLSearchParams(fields).toString(),
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        method: 'POST',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await response.text();
    } catch {
      throw new SubscriptionFailure('unreachable');
    }

    if (response.status >= 500 || response.status === 408 || response.status === 429) {
      throw new SubscriptionFailure('unreachable');
    }
    let body: TokenResponse;
    try {
      body = text === '' ? {} : (JSON.parse(text) as TokenResponse);
    } catch {
      // An OAuth refusal is JSON (RFC 6749 § 5.2); anything else is a proxy or a WAF talking, not
      // the grant being refused — except a bare 401, which is.
      if (response.status !== 401) throw new SubscriptionFailure('unreachable');
      body = {};
    }

    if (response.ok) return { body };
    if (response.status === 401) throw new SubscriptionFailure('rejected');
    switch (body.error) {
      case 'access_denied':
        throw new SubscriptionFailure('denied');
      case 'authorization_pending':
        throw new Pending(5);
      case 'slow_down':
        throw new Pending(10);
      default:
        throw new SubscriptionFailure('rejected');
    }
  }
}

/** RFC 8628 § 3.5: not yet — poll again after `seconds`. Internal to `exchange`. */
class Pending extends Error {
  constructor(readonly seconds: number) {
    super('authorization_pending');
  }
}
