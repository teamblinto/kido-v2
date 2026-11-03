import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type FakeByosProvider,
  startFakeByosProvider,
} from '../../../../test/support/fake-byos-provider';
import type { ByosClientConfig } from './byos-config';
import { GenericOAuthSubscription } from './generic-oauth.subscription';
import { type GrantResult, SubscriptionFailure } from './subscription-client.port';

const REDIRECT = 'http://app.local/account/connected-accounts/anthropic/callback';

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function failure(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SubscriptionFailure);
  return (error as SubscriptionFailure).kind;
}

/** The generic RFC 6749/7636/8628/7009 client against the provider double (032 R16). */
describe('GenericOAuthSubscription', () => {
  let fake: FakeByosProvider;
  let config: ByosClientConfig;

  beforeEach(async () => {
    fake = startFakeByosProvider();
    await fake.start();
    config = {
      apiBaseUrl: fake.apiBaseURL,
      authorizeUrl: fake.authorizeURL,
      clientId: fake.clientId,
      revokeUrl: fake.revokeURL,
      scopes: ['user:inference', 'user:profile'],
      tokenUrl: fake.tokenURL,
    };
  });

  afterEach(() => fake.close());

  async function linked(client = new GenericOAuthSubscription(config)): Promise<GrantResult> {
    const { verifier, challenge } = pkce();
    const begun = await client.begin({
      state: 'st',
      codeChallenge: challenge,
      redirectUri: REDIRECT,
    });
    if (begun.kind !== 'redirect') throw new Error('expected a redirect');
    const back = await fetch(begun.url, { redirect: 'manual' });
    const code = new URL(back.headers.get('location')!).searchParams.get('code')!;
    const result = await client.exchange({ code, state: 'st', verifier, redirectUri: REDIRECT });
    if ('pending' in result) throw new Error('expected a grant');
    return result;
  }

  it('begin builds an RFC 6749 + PKCE S256 authorisation URL', async () => {
    const begun = await new GenericOAuthSubscription(config).begin({
      state: 'the-state',
      codeChallenge: 'challenge-value',
      redirectUri: REDIRECT,
    });

    expect(begun.kind).toBe('redirect');
    const url = new URL((begun as { url: string }).url);
    expect(`${url.origin}${url.pathname}`).toBe(fake.authorizeURL);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: fake.clientId,
      code_challenge: 'challenge-value',
      code_challenge_method: 'S256',
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'user:inference user:profile',
      state: 'the-state',
    });
  });

  it('exchanges a code for a grant, labelled from the id_token email claim', async () => {
    const before = Date.now();
    const { grant, accountLabel } = await linked();

    expect(accountLabel).toBe('ada@example.com');
    expect(grant.accessToken).toMatch(/^fake_at_/);
    expect(grant.refreshToken).toMatch(/^fake_rt_/);
    expect(grant.scopes).toEqual(['user:inference']);
    const expires = Date.parse(grant.accessExpiresAt);
    expect(expires).toBeGreaterThanOrEqual(before + 3_600_000 - 1_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 3_600_000);
  });

  it('takes the label from a configured source instead', async () => {
    const client = new GenericOAuthSubscription(config, {
      accountLabel: (response) => `sub:${String(response.scope)}`,
    });

    expect((await linked(client)).accountLabel).toBe('sub:user:inference');
  });

  it('maps invalid_grant on the code exchange to rejected', async () => {
    const client = new GenericOAuthSubscription(config);

    expect(
      await failure(
        client.exchange({ code: 'nope', state: 'st', verifier: 'v', redirectUri: REDIRECT }),
      ),
    ).toBe('rejected');
  });

  it('refreshes with rotation; the previous refresh token is then rejected', async () => {
    const client = new GenericOAuthSubscription(config);
    const { grant } = await linked(client);

    const next = await client.refresh(grant.refreshToken);

    expect(next.grant.refreshToken).not.toBe(grant.refreshToken);
    expect(next.accountLabel).toBe('ada@example.com');
    expect(fake.refreshCount()).toBe(1);
    expect(await failure(client.refresh(grant.refreshToken))).toBe('rejected');
  });

  it('a provider-side revocation reads as rejected on refresh', async () => {
    const client = new GenericOAuthSubscription(config);
    const { grant } = await linked(client);
    fake.revoke('ada@example.com');

    expect(await failure(client.refresh(grant.refreshToken))).toBe('rejected');
  });

  it('revokes per RFC 7009', async () => {
    const client = new GenericOAuthSubscription(config);
    const { grant } = await linked(client);

    await client.revoke(grant.refreshToken);

    expect(fake.revocations()).toEqual([grant.refreshToken]);
    expect(await failure(client.refresh(grant.refreshToken))).toBe('rejected');
  });

  it('maps 5xx, a refused connection and a timeout to unreachable', async () => {
    const answer500: typeof fetch = () =>
      Promise.resolve(Response.json({ error: 'server_error' }, { status: 503 }));
    const refused: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    const hangs: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      );

    for (const fetch of [answer500, refused, hangs]) {
      const client = new GenericOAuthSubscription(config, { fetch, timeoutMs: 50 });
      expect(await failure(client.refresh('rt'))).toBe('unreachable');
    }
  });

  it('a refresh answer with no account label still refreshes; an exchange without one does not', async () => {
    const fetch: typeof globalThis.fetch = () =>
      Promise.resolve(Response.json({ access_token: 'at2', expires_in: 3600 }));
    const client = new GenericOAuthSubscription(config, { fetch });

    const refreshed = await client.refresh('rt');

    expect(refreshed.grant).toMatchObject({ accessToken: 'at2', refreshToken: 'rt' });
    expect(
      await failure(
        client.exchange({ code: 'c', state: 'st', verifier: 'v', redirectUri: REDIRECT }),
      ),
    ).toBe('rejected');
  });

  it('a non-JSON refusal other than a 401 (a WAF page) is unreachable, not rejected', async () => {
    for (const status of [400, 403, 408]) {
      const fetch: typeof globalThis.fetch = () =>
        Promise.resolve(new Response('<html>Just a moment…</html>', { status }));
      const client = new GenericOAuthSubscription(config, { fetch });
      expect(await failure(client.refresh('rt'))).toBe('unreachable');
    }
  });

  it('maps access_denied from the token endpoint to denied', async () => {
    const fetch: typeof globalThis.fetch = () =>
      Promise.resolve(Response.json({ error: 'access_denied' }, { status: 400 }));
    const client = new GenericOAuthSubscription(
      { ...config, authorizeUrl: undefined, deviceUrl: fake.deviceURL },
      { fetch },
    );

    expect(
      await failure(
        client.exchange({ deviceCode: 'dc', state: 'st', verifier: 'v', redirectUri: REDIRECT }),
      ),
    ).toBe('denied');
  });

  it('runs the RFC 8628 device flow when only DEVICE_URL is configured', async () => {
    const client = new GenericOAuthSubscription({
      ...config,
      authorizeUrl: undefined,
      deviceUrl: fake.deviceURL,
    });

    const begun = await client.begin({ state: 'st', codeChallenge: 'c', redirectUri: REDIRECT });
    if (begun.kind !== 'device') throw new Error('expected the device flow');
    expect(begun.userCode).toBe('WDJB-MJHT');
    expect(begun.intervalSeconds).toBe(5);
    expect(begun.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const input = {
      deviceCode: begun.deviceCode,
      state: 'st',
      verifier: 'v',
      redirectUri: REDIRECT,
    };
    expect(await client.exchange(input)).toEqual({ pending: true, retryAfterSeconds: 5 });
    fake.approveDevice();
    const done = await client.exchange(input);
    expect('grant' in done && done.accountLabel).toBe('ada@example.com');
  });
});
