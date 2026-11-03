import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type FakeByosProvider,
  startFakeByosProvider,
} from '../../../../test/support/fake-byos-provider';
import { anthropicSubscription } from './anthropic.subscription';
import type { ByosClientConfig } from './byos-config';
import { SubscriptionFailure } from './subscription-client.port';

const REDIRECT = 'http://app.local/account/connected-accounts/anthropic/callback';

async function failure(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SubscriptionFailure);
  return (error as SubscriptionFailure).kind;
}

/** Anthropic's subscription client (032 T057) against the double configured to its shapes. */
describe('anthropicSubscription', () => {
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

  it('links with PKCE, falling back to the id_token email claim for the label', async () => {
    fake.signInAs('ada@example.com');
    const client = anthropicSubscription(config);
    const verifier = randomBytes(32).toString('base64url');
    const begun = await client.begin({
      state: 'st',
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      redirectUri: REDIRECT,
    });
    if (begun.kind !== 'redirect') throw new Error('expected a redirect');
    expect(new URL(begun.url).searchParams.get('scope')).toBe('user:inference user:profile');

    const back = await fetch(begun.url, { redirect: 'manual' });
    const code = new URL(back.headers.get('location')!).searchParams.get('code')!;
    const result = await client.exchange({ code, state: 'st', verifier, redirectUri: REDIRECT });
    if ('pending' in result) throw new Error('expected a grant');

    expect(result.accountLabel).toBe('ada@example.com');
  });

  it("labels the account from the token response's own account first", async () => {
    const fetch: typeof globalThis.fetch = () =>
      Promise.resolve(
        Response.json({
          access_token: 'at',
          account: { email_address: 'owner@example.com', uuid: 'u-1' },
          expires_in: 3600,
          refresh_token: 'rt2',
        }),
      );

    const { accountLabel } = await anthropicSubscription(config, { fetch }).refresh('rt');

    expect(accountLabel).toBe('owner@example.com');
  });

  it('maps invalid_grant and a 401 to rejected', async () => {
    expect(await failure(anthropicSubscription(config).refresh('unknown'))).toBe('rejected');

    const unauthorised: typeof globalThis.fetch = () =>
      Promise.resolve(new Response('<html>Unauthorized</html>', { status: 401 }));
    expect(
      await failure(anthropicSubscription(config, { fetch: unauthorised }).refresh('rt')),
    ).toBe('rejected');
  });
});
