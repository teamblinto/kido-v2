import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type FakeByosProvider,
  startFakeByosProvider,
} from '../../../../test/support/fake-byos-provider';
import type { ByosClientConfig } from './byos-config';
import { openAiSubscription } from './openai.subscription';
import { SubscriptionFailure } from './subscription-client.port';

const REDIRECT = 'http://app.local/account/connected-accounts/openai/callback';

async function failure(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SubscriptionFailure);
  return (error as SubscriptionFailure).kind;
}

/** OpenAI's subscription client (032 T059) against the double configured to OpenAI's shapes. */
describe('openAiSubscription', () => {
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
      scopes: ['openid', 'email', 'offline_access'],
      tokenUrl: fake.tokenURL,
    };
  });

  afterEach(() => fake.close());

  it('links with PKCE and labels the account from the id_token email claim', async () => {
    fake.signInAs('grace@example.com');
    const client = openAiSubscription(config);
    const verifier = randomBytes(32).toString('base64url');
    const begun = await client.begin({
      state: 'st',
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      redirectUri: REDIRECT,
    });
    if (begun.kind !== 'redirect') throw new Error('expected a redirect');
    expect(new URL(begun.url).searchParams.get('scope')).toBe('openid email offline_access');

    const back = await fetch(begun.url, { redirect: 'manual' });
    const code = new URL(back.headers.get('location')!).searchParams.get('code')!;
    const result = await client.exchange({ code, state: 'st', verifier, redirectUri: REDIRECT });
    if ('pending' in result) throw new Error('expected a grant');

    expect(result.accountLabel).toBe('grace@example.com');
    expect((await client.refresh(result.grant.refreshToken)).accountLabel).toBe(
      'grace@example.com',
    );
  });

  it('maps invalid_grant to rejected', async () => {
    expect(await failure(openAiSubscription(config).refresh('unknown'))).toBe('rejected');
  });

  it('maps a 401 to rejected, even when its body is not JSON', async () => {
    const answers: (() => Response)[] = [
      () => new Response('<html>Unauthorized</html>', { status: 401 }),
      () => Response.json({ error: 'invalid_client' }, { status: 401 }),
      () => new Response('', { status: 401 }),
    ];
    for (const answer of answers) {
      const client = openAiSubscription(config, { fetch: () => Promise.resolve(answer()) });
      expect(await failure(client.refresh('rt'))).toBe('rejected');
    }
  });

  it('still maps a 5xx with an HTML body, and a garbled success, to unreachable', async () => {
    const answers: (() => Response)[] = [
      () => new Response('<html>Bad gateway</html>', { status: 502 }),
      () => new Response('not json', { status: 200 }),
    ];
    for (const answer of answers) {
      const client = openAiSubscription(config, { fetch: () => Promise.resolve(answer()) });
      expect(await failure(client.refresh('rt'))).toBe('unreachable');
    }
  });
});
