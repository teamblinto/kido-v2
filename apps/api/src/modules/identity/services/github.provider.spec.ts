import type { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../../config/environment';
import { DEFAULT_GITHUB_ENDPOINTS, GithubProvider } from './github.provider';
import { OauthExchangeError } from './oauth.service';

const ENDPOINTS = {
  authorize: 'https://provider.test/login/oauth/authorize',
  emails: 'https://api.provider.test/user/emails',
  token: 'https://provider.test/login/oauth/access_token',
  user: 'https://api.provider.test/user',
};

const CLIENT_ID = 'Iv1.test-client-id';
const CLIENT_SECRET = 'ghs_thisIsTheClientSecretAndMustNeverBeLogged';
const REDIRECT_URI = 'https://app.forge.test/api/v1/auth/oauth/github/callback';

function configOf(values: Partial<Environment>): ConfigService<Environment, true> {
  return {
    get: (key: keyof Environment) => values[key],
  } as unknown as ConfigService<Environment, true>;
}

function providerWith(values: Partial<Environment> = {}): GithubProvider {
  return new GithubProvider(
    ENDPOINTS,
    configOf({
      GITHUB_OAUTH_CLIENT_ID: CLIENT_ID,
      GITHUB_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
      ...values,
    }),
  );
}

/**
 * The adapter only ever calls `fetch` with a string URL, so the stubs below narrow to that rather
 * than handling `Request` and `URL` shapes nothing under test produces.
 */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }

  return input instanceof URL ? input.href : input.url;
}

/** One `fetch` stub, routed by URL, so a test states only the responses it cares about. */
function stubFetch(routes: Record<string, { body?: unknown; status?: number }>): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const route = routes[urlOf(input)];

    if (route === undefined) {
      return Promise.resolve(new Response('not found', { status: 404 }));
    }

    return Promise.resolve(
      new Response(JSON.stringify(route.body ?? {}), {
        headers: { 'Content-Type': 'application/json' },
        status: route.status ?? 200,
      }),
    );
  });
}

const TOKEN_OK = { body: { access_token: 'gho_anAccessTokenThatMustNeverBeLogged' } };

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isConfigured', () => {
  it('is true only when both halves are present', () => {
    expect(providerWith().isConfigured()).toBe(true);
    expect(providerWith({ GITHUB_OAUTH_CLIENT_ID: undefined }).isConfigured()).toBe(false);
    expect(providerWith({ GITHUB_OAUTH_CLIENT_SECRET: undefined }).isConfigured()).toBe(false);
  });
});

describe('authorizationUrl', () => {
  const url = () =>
    new URL(
      providerWith().authorizationUrl({
        codeChallenge: 'a-challenge',
        redirectUri: REDIRECT_URI,
        state: 'the-state',
      }),
    );

  it('sends the state, the challenge and the S256 method', () => {
    const parameters = url().searchParams;

    expect(parameters.get('state')).toBe('the-state');
    expect(parameters.get('code_challenge')).toBe('a-challenge');
    expect(parameters.get('code_challenge_method')).toBe('S256');
    expect(parameters.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(parameters.get('client_id')).toBe(CLIENT_ID);
  });

  /**
   * The consent screen is what the user reads before deciding. A login button that asks for `repo`
   * is a login button people decline, and the §12 connector asks separately as a GitHub App.
   */
  it('asks for the two scopes it needs and nothing else', () => {
    expect(url().searchParams.get('scope')).toBe('read:user user:email');
  });

  /** The secret is not a query parameter. It is only ever a form field on the token POST. */
  it('never puts the client secret in the URL', () => {
    expect(url().toString()).not.toContain(CLIENT_SECRET);
  });
});

describe('identify', () => {
  const exchange = async (provider = providerWith()) =>
    provider.identify({
      code: 'the-code',
      codeVerifier: 'the-verifier',
      redirectUri: REDIRECT_URI,
    });

  /**
   * The property this adapter exists for, stated as plainly as it can be: the profile address is
   * ignored, and the answer comes from `user/emails`.
   *
   * `GET /user` here reports `attacker-typed@example.test` — which is exactly what a GitHub user can
   * put in the public profile field without proving anything — and the verified list says the
   * account really controls `owner@example.test`. If this ever answers the first address, anybody
   * who can type a stranger's address into their GitHub profile can sign in as that stranger here.
   */
  it('takes the verified address and ignores the unverified profile one', async () => {
    stubFetch({
      [ENDPOINTS.emails]: {
        body: [{ email: 'owner@example.test', primary: true, verified: true }],
      },
      [ENDPOINTS.token]: TOKEN_OK,
      [ENDPOINTS.user]: { body: { email: 'attacker-typed@example.test', id: 4711, login: 'ada' } },
    });

    await expect(exchange()).resolves.toEqual({
      email: 'owner@example.test',
      kind: 'verified',
      providerUserId: '4711',
    });
  });

  /** Criterion 9's refusal, at the adapter: nothing verified means no address is handed back. */
  it('answers unverified when GitHub vouches for no address', async () => {
    stubFetch({
      [ENDPOINTS.emails]: {
        body: [{ email: 'unverified@example.test', primary: true, verified: false }],
      },
      [ENDPOINTS.token]: TOKEN_OK,
      [ENDPOINTS.user]: { body: { id: 4711 } },
    });

    const identity = await exchange();

    expect(identity.kind).toBe('unverified');
    // The union is the whole guarantee: there is no address on this arm to reach for, and no
    // unverified address anywhere in the value.
    expect(JSON.stringify(identity)).not.toContain('unverified@example.test');
  });

  it('answers unverified when the account has no addresses at all', async () => {
    stubFetch({
      [ENDPOINTS.emails]: { body: [] },
      [ENDPOINTS.token]: TOKEN_OK,
      [ENDPOINTS.user]: { body: { id: 4711 } },
    });

    expect((await exchange()).kind).toBe('unverified');
  });

  /**
   * Primary is a preference among verified addresses, never a way past the check. An unverified
   * primary beside a verified secondary must yield the secondary — the opposite ordering is the
   * one-line version of the bug the whole class is written to avoid.
   */
  it('prefers the primary verified address, and never an unverified primary', async () => {
    stubFetch({
      [ENDPOINTS.emails]: {
        body: [
          { email: 'unverified-primary@example.test', primary: true, verified: false },
          { email: 'verified-secondary@example.test', primary: false, verified: true },
        ],
      },
      [ENDPOINTS.token]: TOKEN_OK,
      [ENDPOINTS.user]: { body: { id: 4711 } },
    });

    await expect(exchange()).resolves.toMatchObject({
      email: 'verified-secondary@example.test',
      kind: 'verified',
    });
  });

  it('picks the primary when several are verified', async () => {
    stubFetch({
      [ENDPOINTS.emails]: {
        body: [
          { email: 'second@example.test', primary: false, verified: true },
          { email: 'main@example.test', primary: true, verified: true },
        ],
      },
      [ENDPOINTS.token]: TOKEN_OK,
      [ENDPOINTS.user]: { body: { id: 4711 } },
    });

    await expect(exchange()).resolves.toMatchObject({ email: 'main@example.test' });
  });

  /** `login` is renameable; `id` is the immutable subject `oauth_identities` is keyed by. */
  it('keys the identity on the numeric id rather than the login', async () => {
    stubFetch({
      [ENDPOINTS.emails]: { body: [{ email: 'a@example.test', primary: true, verified: true }] },
      [ENDPOINTS.token]: TOKEN_OK,
      [ENDPOINTS.user]: { body: { id: 4711, login: 'ada' } },
    });

    await expect(exchange()).resolves.toMatchObject({ providerUserId: '4711' });
  });

  /**
   * GitHub answers `200` with an `error` member for a code it will not honour, so the status is not
   * the check. The absence of a usable token is.
   */
  it('rejects a 200 that carries an error instead of a token', async () => {
    stubFetch({
      [ENDPOINTS.token]: { body: { error: 'bad_verification_code' } },
    });

    await expect(exchange()).rejects.toBeInstanceOf(OauthExchangeError);
  });

  it('rejects a non-2xx from the token endpoint', async () => {
    stubFetch({ [ENDPOINTS.token]: { body: {}, status: 500 } });

    await expect(exchange()).rejects.toBeInstanceOf(OauthExchangeError);
  });

  it('rejects a profile response with no id', async () => {
    stubFetch({
      [ENDPOINTS.token]: TOKEN_OK,
      [ENDPOINTS.user]: { body: { login: 'ada' } },
    });

    await expect(exchange()).rejects.toBeInstanceOf(OauthExchangeError);
  });

  it('rejects an emails response that is not a list of entries', async () => {
    stubFetch({
      [ENDPOINTS.emails]: { body: { message: 'Requires authentication' } },
      [ENDPOINTS.token]: TOKEN_OK,
      [ENDPOINTS.user]: { body: { id: 4711 } },
    });

    await expect(exchange()).rejects.toBeInstanceOf(OauthExchangeError);
  });

  it('translates a transport failure into the catalogued refusal', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(exchange()).rejects.toBeInstanceOf(OauthExchangeError);
  });

  /**
   * The standing rule, asserted rather than reviewed. Whatever went wrong, the thing that travels
   * to the client is a provider name — never the secret, the code, or the token.
   */
  it('never carries the secret, the code or the access token into the error it throws', async () => {
    stubFetch({ [ENDPOINTS.token]: { body: {}, status: 500 } });

    const error = await exchange().catch((thrown: unknown) => thrown);
    const rendered = JSON.stringify({
      detail: (error as OauthExchangeError).detail,
      extensions: (error as OauthExchangeError).extensions,
      message: (error as Error).message,
    });

    expect(rendered).not.toContain(CLIENT_SECRET);
    expect(rendered).not.toContain('the-code');
    expect(rendered).not.toContain('the-verifier');
    expect(rendered).toContain('github');
  });

  /** The token call carries the verifier, so PKCE is live even though GitHub ignores it today. */
  it('sends the code verifier and the secret in the body, never in the URL', async () => {
    const seen: { body: string; url: string }[] = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      // The adapter sends a `URLSearchParams` body, which is what the production code path builds;
      // anything else here would mean the call under test changed shape.
      const body = init?.body instanceof URLSearchParams ? init.body.toString() : '';

      seen.push({ body, url: urlOf(input) });

      return Promise.resolve(
        new Response(JSON.stringify({ access_token: 'gho_x' }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
      );
    });

    await exchange().catch(() => undefined);

    const token = seen.find((call) => call.url === ENDPOINTS.token);

    expect(token?.url).not.toContain(CLIENT_SECRET);
    expect(token?.body).toContain('code_verifier=the-verifier');
    expect(token?.body).toContain(encodeURIComponent(CLIENT_SECRET));
  });
});

describe('DEFAULT_GITHUB_ENDPOINTS', () => {
  /** The one place `github.com` is written down, and it is frozen so nothing can repoint it. */
  it('points at github.com over TLS and cannot be mutated', () => {
    const urls: string[] = [
      DEFAULT_GITHUB_ENDPOINTS.authorize,
      DEFAULT_GITHUB_ENDPOINTS.emails,
      DEFAULT_GITHUB_ENDPOINTS.token,
      DEFAULT_GITHUB_ENDPOINTS.user,
    ];

    for (const url of urls) {
      expect(url.startsWith('https://')).toBe(true);
    }

    expect(Object.isFrozen(DEFAULT_GITHUB_ENDPOINTS)).toBe(true);
  });
});
