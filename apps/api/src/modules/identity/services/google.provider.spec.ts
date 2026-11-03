import type { ConfigService } from '@nestjs/config';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../../config/environment';
import { DEFAULT_GOOGLE_ENDPOINTS, GoogleProvider } from './google.provider';
import { OauthExchangeError } from './oauth.service';

const ENDPOINTS = {
  authorize: 'https://accounts.provider.test/o/oauth2/v2/auth',
  jwks: 'https://certs.provider.test/oauth2/v3/certs',
  token: 'https://oauth2.provider.test/token',
};

const CLIENT_ID = '1234.apps.googleusercontent.com';
const CLIENT_SECRET = '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NeverBeLogged';
const REDIRECT_URI = 'https://app.forge.test/api/v1/auth/oauth/google/callback';
const ISSUER = 'https://accounts.google.com';
const SUBJECT = '117440192837465500001';

/**
 * A key pair generated here, in this process, for this run.
 *
 * Nothing about these tests reaches Google. The `id_token`s below are minted locally and served
 * through a locally minted key set, which is what makes it possible to assert the *rejections* —
 * an expired token, one minted for another audience, one signed by a key the set does not hold —
 * that a suite pointed at the real provider could never produce.
 */
let signing: { kid: string; privateKey: CryptoKey; publicJwk: Record<string, unknown> };
let rotated: { kid: string; privateKey: CryptoKey; publicJwk: Record<string, unknown> };

async function keyPair(kid: string): Promise<typeof signing> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });

  return {
    kid,
    privateKey,
    publicJwk: { ...(await exportJWK(publicKey)), alg: 'RS256', kid, use: 'sig' },
  };
}

interface TokenOverrides {
  audience?: string;
  claims?: Record<string, unknown>;
  expiresAt?: string;
  issuer?: string;
  key?: typeof signing;
}

/** One `id_token`, exactly as Google's token endpoint would return it, modulo whatever is varied. */
async function idToken(overrides: TokenOverrides = {}): Promise<string> {
  const key = overrides.key ?? signing;

  return new SignJWT({
    email: 'ada@example.test',
    email_verified: true,
    ...overrides.claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: key.kid })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? CLIENT_ID)
    .setSubject(SUBJECT)
    .setIssuedAt()
    .setExpirationTime(overrides.expiresAt ?? '1h')
    .sign(key.privateKey);
}

function configOf(values: Partial<Environment>): ConfigService<Environment, true> {
  return {
    get: (key: keyof Environment) => values[key],
  } as unknown as ConfigService<Environment, true>;
}

function providerWith(values: Partial<Environment> = {}): GoogleProvider {
  return new GoogleProvider(
    ENDPOINTS,
    configOf({
      GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
      GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
      ...values,
    }),
  );
}

/** The adapter and `jose` both call `fetch` with a string URL; nothing here produces other shapes. */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }

  return input instanceof URL ? input.href : input.url;
}

interface Stub {
  /** Which key set the certs endpoint is serving right now. Reassigned to rotate. */
  jwks: Record<string, unknown>[];
  jwksRequests: number;
  token: { body?: unknown; status?: number };
}

let stub: Stub;

/**
 * One `fetch` stub covering both the token endpoint and the certs endpoint.
 *
 * `jose` fetches the key set through the same global `fetch`, so routing it here is what lets these
 * tests count the requests — which is how "the key set is cached" and "the key set is refetched
 * when it has to be" are asserted as facts rather than as a reading of the constructor.
 */
function stubFetch(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = urlOf(input);

    if (url === ENDPOINTS.jwks) {
      stub.jwksRequests += 1;

      return Promise.resolve(
        new Response(JSON.stringify({ keys: stub.jwks }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
      );
    }

    if (url === ENDPOINTS.token) {
      return Promise.resolve(
        new Response(JSON.stringify(stub.token.body ?? {}), {
          headers: { 'Content-Type': 'application/json' },
          status: stub.token.status ?? 200,
        }),
      );
    }

    return Promise.resolve(new Response('not found', { status: 404 }));
  });
}

const exchange = (provider = providerWith()) =>
  provider.identify({
    code: 'the-code',
    codeVerifier: 'the-verifier',
    redirectUri: REDIRECT_URI,
  });

beforeAll(async () => {
  signing = await keyPair('key-in-use');
  rotated = await keyPair('key-minted-later');
});

beforeEach(() => {
  stub = { jwks: [signing.publicJwk], jwksRequests: 0, token: {} };
  stubFetch();
});

describe('isConfigured', () => {
  it('is true only when both halves are present', () => {
    expect(providerWith().isConfigured()).toBe(true);
    expect(providerWith({ GOOGLE_OAUTH_CLIENT_ID: undefined }).isConfigured()).toBe(false);
    expect(providerWith({ GOOGLE_OAUTH_CLIENT_SECRET: undefined }).isConfigured()).toBe(false);
  });

  /** Unconfigured is answered before any route runs, so nothing may be fetched to decide it. */
  it('reaches the network for none of that, including the key set', () => {
    providerWith({ GOOGLE_OAUTH_CLIENT_ID: undefined }).isConfigured();

    expect(stub.jwksRequests).toBe(0);
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
    expect(parameters.get('response_type')).toBe('code');
  });

  /** `openid` to get an `id_token` at all, `email` for the claim linking depends on. Nothing else. */
  it('asks for the two scopes it needs and nothing else', () => {
    expect(url().searchParams.get('scope')).toBe('openid email');
  });

  it('never puts the client secret in the URL', () => {
    expect(url().toString()).not.toContain(CLIENT_SECRET);
  });
});

describe('identify', () => {
  it('takes the subject and the verified address out of the id_token', async () => {
    stub.token = { body: { id_token: await idToken() } };

    await expect(exchange()).resolves.toEqual({
      email: 'ada@example.test',
      kind: 'verified',
      providerUserId: SUBJECT,
    });
  });

  /** `sub` is the immutable subject; the address is what users change, and is never the key. */
  it('keys the identity on sub rather than on the address', async () => {
    stub.token = {
      body: { id_token: await idToken({ claims: { email: 'renamed@example.test' } }) },
    };

    await expect(exchange()).resolves.toMatchObject({ providerUserId: SUBJECT });
  });

  /**
   * Criterion 9's refusal, at the adapter. `email_verified: false` is not a rare edge — it is what
   * Google sends for an address on a Workspace domain whose ownership was never proved, which is
   * exactly "a stranger's address on a domain somebody else runs".
   */
  it('answers unverified when the email_verified claim is false', async () => {
    stub.token = {
      body: { id_token: await idToken({ claims: { email_verified: false } }) },
    };

    const identity = await exchange();

    expect(identity.kind).toBe('unverified');
    // The union is the whole guarantee: no address on this arm for a linking path to reach for.
    expect(JSON.stringify(identity)).not.toContain('ada@example.test');
  });

  it('answers unverified when the claim is absent entirely', async () => {
    stub.token = {
      body: { id_token: await idToken({ claims: { email_verified: undefined } }) },
    };

    expect((await exchange()).kind).toBe('unverified');
  });

  /**
   * A string is not a boolean. Coercing `'true'` would mean inventing a claim shape and then
   * trusting it, on the one claim that decides whether an address may be matched against
   * `users.email`.
   *
   * And it answers *unverified* rather than refusing the token, which is the deliberate half. A
   * claim we do not recognise means nothing was proved — it does not mean the sign-in is broken —
   * so an account linked years ago on proof still signs in, while nothing new can link on a shape
   * nobody has verified.
   */
  it('does not accept the string "true" as proof, and does not fail the sign-in over it', async () => {
    stub.token = {
      body: { id_token: await idToken({ claims: { email_verified: 'true' } }) },
    };

    await expect(exchange()).resolves.toEqual({ kind: 'unverified', providerUserId: SUBJECT });
  });

  it('answers unverified when the token carries no address', async () => {
    stub.token = {
      body: { id_token: await idToken({ claims: { email: undefined } }) },
    };

    expect((await exchange()).kind).toBe('unverified');
  });

  /** Same rule from the other side: an address that is not a non-empty string is not an address. */
  it('answers unverified when the address claim is not a string', async () => {
    stub.token = {
      body: { id_token: await idToken({ claims: { email: 12_345 } }) },
    };

    await expect(exchange()).resolves.toEqual({ kind: 'unverified', providerUserId: SUBJECT });
  });
});

/**
 * ## Verification, which is the whole of what this adapter is trusted for
 *
 * GitHub proves an address with an authenticated REST call. Google proves one with a claim inside a
 * signed document — so every one of these refusals is the difference between a sign-in and somebody
 * else's sign-in.
 */
describe('id_token verification', () => {
  it('rejects a token minted for another audience', async () => {
    stub.token = { body: { id_token: await idToken({ audience: 'another-client.apps.test' }) } };

    await expect(exchange()).rejects.toBeInstanceOf(OauthExchangeError);
  });

  it('rejects an expired token', async () => {
    stub.token = { body: { id_token: await idToken({ expiresAt: '-1h' }) } };

    await expect(exchange()).rejects.toBeInstanceOf(OauthExchangeError);
  });

  it('rejects a token from another issuer', async () => {
    stub.token = { body: { id_token: await idToken({ issuer: 'https://accounts.evil.test' }) } };

    await expect(exchange()).rejects.toBeInstanceOf(OauthExchangeError);
  });

  /** A well-formed token signed by a key the published set does not hold is somebody else's. */
  it('rejects a token signed by a key the set does not publish', async () => {
    stub.token = { body: { id_token: await idToken({ key: rotated }) } };

    await expect(exchange()).rejects.toBeInstanceOf(OauthExchangeError);
  });

  /**
   * The classic JWT failure, asserted rather than assumed: a verifier that believes the token's own
   * header accepts a token that was never signed at all.
   */
  it('rejects an unsigned token that claims alg: none', async () => {
    const encode = (value: unknown): string =>
      Buffer.from(JSON.stringify(value)).toString('base64url');

    stub.token = {
      body: {
        id_token: `${encode({ alg: 'none' })}.${encode({
          aud: CLIENT_ID,
          email: 'ada@example.test',
          email_verified: true,
          exp: Math.floor(Date.now() / 1000) + 3600,
          iss: ISSUER,
          sub: SUBJECT,
        })}.`,
      },
    };

    await expect(exchange()).rejects.toBeInstanceOf(OauthExchangeError);
  });

  it('rejects a token whose signature does not match its payload', async () => {
    const [header, payload] = (await idToken()).split('.');
    const tampered = await idToken({ claims: { email: 'attacker@example.test' } });

    stub.token = {
      body: { id_token: `${header ?? ''}.${payload ?? ''}.${tampered.split('.')[2] ?? ''}` },
    };

    await expect(exchange()).rejects.toBeInstanceOf(OauthExchangeError);
  });

  it('rejects a verified token that carries no subject', async () => {
    stub.token = {
      body: {
        id_token: await new SignJWT({ email: 'ada@example.test', email_verified: true })
          .setProtectedHeader({ alg: 'RS256', kid: signing.kid })
          .setIssuer(ISSUER)
          .setAudience(CLIENT_ID)
          .setIssuedAt()
          .setExpirationTime('1h')
          .sign(signing.privateKey),
      },
    };

    await expect(exchange()).rejects.toBeInstanceOf(OauthExchangeError);
  });
});

/**
 * ## The rotating key set
 *
 * The acceptance criterion is "rotating JWKS, with the key set cached", and the two halves pull in
 * opposite directions: a cache that never refreshes is a pinned key, and a key set fetched per
 * request is not a cache. Both are asserted here by counting the requests the certs endpoint sees.
 */
describe('the key set', () => {
  it('is fetched once and reused across sign-ins', async () => {
    const provider = providerWith();

    stub.token = { body: { id_token: await idToken() } };
    await exchange(provider);

    stub.token = { body: { id_token: await idToken() } };
    await exchange(provider);

    expect(stub.jwksRequests).toBe(1);
  });

  /**
   * Rotation, which is the property the task is written around: Google mints a new signing key
   * without telling anyone, and the first token signed with it must still sign the user in.
   *
   * A pinned key fails this test. So does a cache with no unknown-`kid` path — which is why the
   * clock is moved past the refetch cooldown rather than the assertion being weakened: the cooldown
   * is a deliberate floor on how often an unrecognised key may cost us a request to Google, and a
   * test that could not tolerate it would be a test that argued for removing it.
   */
  it('is refetched when a key it has never seen signs a token', async () => {
    const provider = providerWith();

    stub.token = { body: { id_token: await idToken() } };
    await exchange(provider);
    expect(stub.jwksRequests).toBe(1);

    // Google rotates: the old key is withdrawn and a new one is published.
    stub.jwks = [rotated.publicJwk];
    stub.token = { body: { id_token: await idToken({ key: rotated }) } };

    vi.useFakeTimers({ toFake: ['Date'] });

    try {
      vi.setSystemTime(new Date(Date.now() + 60_000));

      await expect(exchange(provider)).resolves.toMatchObject({ kind: 'verified' });
    } finally {
      vi.useRealTimers();
    }

    expect(stub.jwksRequests).toBe(2);
  });

  /** A certs endpoint that is down is a refusal, not a token accepted on a stale assumption. */
  it('refuses the sign-in when the key set cannot be fetched', async () => {
    stub.token = { body: { id_token: await idToken() } };

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
      urlOf(input) === ENDPOINTS.jwks
        ? Promise.resolve(new Response('nope', { status: 500 }))
        : Promise.resolve(
            new Response(JSON.stringify(stub.token.body), {
              headers: { 'Content-Type': 'application/json' },
              status: 200,
            }),
          ),
    );

    await expect(exchange()).rejects.toBeInstanceOf(OauthExchangeError);
  });
});

describe('the token exchange', () => {
  it('rejects a 200 that carries no id_token', async () => {
    stub.token = { body: { access_token: 'ya29.an-access-token', token_type: 'Bearer' } };

    await expect(exchange()).rejects.toBeInstanceOf(OauthExchangeError);
  });

  it('rejects a non-2xx from the token endpoint', async () => {
    stub.token = { body: { error: 'invalid_grant' }, status: 400 };

    await expect(exchange()).rejects.toBeInstanceOf(OauthExchangeError);
  });

  it('translates a transport failure into the catalogued refusal', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(exchange()).rejects.toBeInstanceOf(OauthExchangeError);
  });

  /**
   * Google requires `grant_type`, which GitHub does not send — the one wire-level difference
   * between the two token calls, and the one that fails with an unhelpful `invalid_request` if it
   * is ever dropped. The verifier travels with it, so PKCE is live on the provider that checks it.
   */
  it('sends grant_type and the code verifier in the body, and the secret nowhere else', async () => {
    const seen: { body: string; url: string }[] = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const body = init?.body instanceof URLSearchParams ? init.body.toString() : '';

      seen.push({ body, url: urlOf(input) });

      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });

    await exchange().catch(() => undefined);

    const token = seen.find((call) => call.url === ENDPOINTS.token);

    expect(token?.url).not.toContain(CLIENT_SECRET);
    expect(token?.body).toContain('grant_type=authorization_code');
    expect(token?.body).toContain('code_verifier=the-verifier');
    expect(token?.body).toContain(encodeURIComponent(CLIENT_SECRET));
  });

  /**
   * The standing rule, asserted rather than reviewed — and with one more thing on the list than
   * T22 had. An `id_token` is a bearer credential that also carries the user's address in a form
   * anybody can read, and a failure is the moment it is most tempting to attach one to an error.
   */
  it('never carries the secret, the code or the id_token into the error it throws', async () => {
    const token = await idToken({ audience: 'another-client.apps.test' });

    stub.token = { body: { id_token: token } };

    const error = await exchange().catch((thrown: unknown) => thrown);
    const rendered = JSON.stringify({
      detail: (error as OauthExchangeError).detail,
      extensions: (error as OauthExchangeError).extensions,
      message: (error as Error).message,
    });

    expect(rendered).not.toContain(CLIENT_SECRET);
    expect(rendered).not.toContain(token);
    expect(rendered).not.toContain('the-code');
    expect(rendered).not.toContain('the-verifier');
    expect(rendered).toContain('google');
  });
});

describe('DEFAULT_GOOGLE_ENDPOINTS', () => {
  /**
   * The one place Google's hosts are written down, frozen so nothing can repoint them — and the
   * certs endpoint is the one that matters most: an attacker who could swap it could publish the
   * keys every `id_token` is then verified against.
   */
  it('points at Google over TLS and cannot be mutated', () => {
    const urls = [
      DEFAULT_GOOGLE_ENDPOINTS.authorize,
      DEFAULT_GOOGLE_ENDPOINTS.jwks,
      DEFAULT_GOOGLE_ENDPOINTS.token,
    ];

    for (const url of urls) {
      expect(url.startsWith('https://')).toBe(true);
    }

    expect(Object.isFrozen(DEFAULT_GOOGLE_ENDPOINTS)).toBe(true);
  });
});
