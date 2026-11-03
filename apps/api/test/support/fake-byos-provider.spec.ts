import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type FakeByosProvider, startFakeByosProvider } from './fake-byos-provider';

const REDIRECT = 'http://app.local/account/connected-accounts/anthropic/callback';

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function form(url: string, fields: Record<string, string>) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('fake-byos-provider (032 R16)', () => {
  let fake: FakeByosProvider;

  beforeEach(async () => {
    fake = startFakeByosProvider();
    await fake.start();
  });

  afterEach(() => fake.close());

  async function authorise(challenge: string, state = 'st'): Promise<URL> {
    const url = new URL(fake.authorizeURL);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: fake.clientId,
      redirect_uri: REDIRECT,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    const response = await fetch(url, { redirect: 'manual' });
    expect(response.status).toBe(302);
    return new URL(response.headers.get('location')!);
  }

  async function link() {
    const { verifier, challenge } = pkce();
    const code = (await authorise(challenge)).searchParams.get('code')!;
    return form(fake.tokenURL, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: fake.clientId,
    });
  }

  it('redirects with code and state, and exchanges the code under PKCE S256', async () => {
    const { verifier, challenge } = pkce();
    const back = await authorise(challenge, 'the-state');

    expect(back.searchParams.get('state')).toBe('the-state');
    const code = back.searchParams.get('code')!;
    const good = await form(fake.tokenURL, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: fake.clientId,
    });

    expect(good.status).toBe(200);
    expect(good.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    const claims = JSON.parse(
      Buffer.from(String(good.body.id_token).split('.')[1]!, 'base64url').toString(),
    ) as { email: string };
    expect(claims.email).toBe('ada@example.com');

    // The code is single use.
    const again = await form(fake.tokenURL, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: fake.clientId,
    });
    expect(again).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
  });

  it('refuses a code redeemed with the wrong verifier', async () => {
    const { challenge } = pkce();
    const code = (await authorise(challenge)).searchParams.get('code')!;

    const bad = await form(fake.tokenURL, {
      grant_type: 'authorization_code',
      code,
      code_verifier: pkce().verifier,
      redirect_uri: REDIRECT,
      client_id: fake.clientId,
    });

    expect(bad).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
  });

  it('redirects with error=access_denied when told to deny', async () => {
    fake.deny();
    const back = await authorise(pkce().challenge, 's2');

    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe('s2');
    expect(back.searchParams.has('code')).toBe(false);
  });

  it('rotates refresh tokens: the previous one is invalid, and redeeming it revokes the family', async () => {
    const first = await link();
    const r1 = String(first.body.refresh_token);

    const second = await form(fake.tokenURL, { grant_type: 'refresh_token', refresh_token: r1 });
    expect(second.status).toBe(200);
    const r2 = String(second.body.refresh_token);
    expect(r2).not.toBe(r1);
    expect(fake.refreshCount()).toBe(1);

    const replay = await form(fake.tokenURL, { grant_type: 'refresh_token', refresh_token: r1 });
    expect(replay).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });

    // The family is gone: the current refresh token and its access token no longer work.
    const after = await form(fake.tokenURL, { grant_type: 'refresh_token', refresh_token: r2 });
    expect(after).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
    const call = await fetch(`${fake.apiBaseURL}/v1/models`, {
      headers: { authorization: `Bearer ${String(second.body.access_token)}` },
    });
    expect(call.status).toBe(401);
  });

  it('serves model calls to a live bearer and logs the token used', async () => {
    const { body } = await link();
    const token = String(body.access_token);

    const models = await fetch(`${fake.apiBaseURL}/v1/models?limit=1`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(models.status).toBe(200);
    const message = await fetch(`${fake.apiBaseURL}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-fake', stream: true }),
    });
    expect(message.status).toBe(200);
    expect(await message.text()).toContain('message_stop');
    const missing = await fetch(`${fake.apiBaseURL}/v1/models`, {
      headers: { 'x-api-key': token },
    });
    expect(missing.status).toBe(401);

    expect(fake.callLog()).toEqual([token, token, null]);
  });

  it('revoke(user) and RFC 7009 /revoke both end the grant', async () => {
    const a = await link();
    fake.revoke('ada@example.com');
    const refused = await form(fake.tokenURL, {
      grant_type: 'refresh_token',
      refresh_token: String(a.body.refresh_token),
    });
    expect(refused.body.error).toBe('invalid_grant');

    const b = await link();
    const revoked = await fetch(fake.revokeURL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: String(b.body.refresh_token) }).toString(),
    });
    expect(revoked.status).toBe(200);
    expect(fake.revocations()).toEqual([String(b.body.refresh_token)]);
    const call = await fetch(`${fake.apiBaseURL}/v1/models`, {
      headers: { authorization: `Bearer ${String(b.body.access_token)}` },
    });
    expect(call.status).toBe(401);
  });

  it('expires access tokens after setAccessLifetime', async () => {
    fake.setAccessLifetime(0);
    const { body } = await link();

    expect(body.expires_in).toBe(0);
    const call = await fetch(`${fake.apiBaseURL}/v1/models`, {
      headers: { authorization: `Bearer ${String(body.access_token)}` },
    });
    expect(call.status).toBe(401);
  });

  it('answers 429 with a reset while rate limited', async () => {
    const { body } = await link();
    fake.rateLimit({ resetInSeconds: 3600 });

    const call = await fetch(`${fake.apiBaseURL}/v1/models`, {
      headers: { authorization: `Bearer ${String(body.access_token)}` },
    });

    expect(call.status).toBe(429);
    expect(call.headers.get('retry-after')).toBe('3600');
  });

  it('runs the device flow: pending until approved, then tokens', async () => {
    const device = await form(fake.deviceURL, { client_id: fake.clientId, scope: 'x' });
    expect(typeof device.body.user_code).toBe('string');
    expect(device.body.interval).toBe(5);
    const poll = () =>
      form(fake.tokenURL, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: String(device.body.device_code),
        client_id: fake.clientId,
      });

    expect(await poll()).toMatchObject({ status: 400, body: { error: 'authorization_pending' } });
    fake.approveDevice();
    const done = await poll();
    expect(done.status).toBe(200);
    expect(done.body.refresh_token).toEqual(expect.any(String));
  });
});
