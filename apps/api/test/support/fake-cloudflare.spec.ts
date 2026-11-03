import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startFakeCloudflare, type FakeCloudflare } from './fake-cloudflare';

describe('startFakeCloudflare', () => {
  let edge: FakeCloudflare;
  let base: string;
  const call = (method: string, path = '', body?: unknown, token = edge.apiToken) =>
    fetch(`${base}${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      method,
    });

  beforeEach(async () => {
    edge = await startFakeCloudflare();
    base = `${edge.apiUrl}/zones/${edge.zoneId}/custom_hostnames`;
  });

  afterEach(async () => {
    await edge.close();
  });

  it('registers, reads, finds and deletes a custom hostname in the vendor envelope', async () => {
    const ssl = { certificate_authority: 'lets_encrypt', method: 'http', type: 'dv' };
    const created = await call('POST', '', { hostname: 'app.acme.com', ssl });
    expect(created.status).toBe(201);
    const { result, success } = (await created.json()) as {
      result: { id: string; status: string; ssl: { status: string } };
      success: boolean;
    };
    expect(success).toBe(true);
    expect(result).toMatchObject({ ssl: { status: 'pending_validation' }, status: 'pending' });
    expect(edge.find('app.acme.com')?.sslRequested).toEqual(ssl);

    expect((await (await call('GET', `/${result.id}`)).json()) as unknown).toMatchObject({
      result: { hostname: 'app.acme.com', id: result.id },
    });
    const found = (await (await call('GET', '?hostname=app.acme.com')).json()) as {
      result: unknown[];
    };
    expect(found.result).toHaveLength(1);
    const none = (await (await call('GET', '?hostname=other.acme.com')).json()) as {
      result: unknown[];
    };
    expect(none.result).toEqual([]);
    const all = (await (await call('GET')).json()) as { result: unknown[] };
    expect(all.result).toHaveLength(1);

    expect((await call('DELETE', `/${result.id}`)).status).toBe(200);
    expect((await call('DELETE', `/${result.id}`)).status).toBe(404);
    expect((await call('GET', `/${result.id}`)).status).toBe(404);
    expect(edge.hostnames.size).toBe(0);
  });

  it('keeps the Authorization header on every request, and refuses a wrong token', async () => {
    expect((await call('GET', '', undefined, 'wrong')).status).toBe(403);
    expect(edge.requests.map((request) => request.headers.authorization)).toEqual(['Bearer wrong']);
  });

  it('answers the duplicate-hostname error for a hostname already registered', async () => {
    edge.seed('app.acme.com');
    const duplicate = await call('POST', '', { hostname: 'app.acme.com' });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ errors: [{ code: 1406 }], success: false });
  });

  it('refuses a malformed POST, an unknown route, and a scripted refusal once', async () => {
    expect((await call('POST', '', {})).status).toBe(400);
    expect(
      (
        await fetch(base, {
          body: '{',
          headers: { authorization: `Bearer ${edge.apiToken}` },
          method: 'POST',
        })
      ).status,
    ).toBe(400);
    expect((await call('PUT', '/x')).status).toBe(404);
    edge.refuseNext(422, 'Hostname is prohibited.');
    const refused = await call('POST', '', { hostname: 'bad.acme.com' });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      errors: [{ message: 'Hostname is prohibited.' }],
    });
    expect((await call('POST', '', { hostname: 'bad.acme.com' })).status).toBe(201);
  });

  it('plays a scripted status sequence one GET at a time, repeating the last step', async () => {
    edge.scriptStatus('app.acme.com', [
      { ssl: 'pending_validation' },
      {
        ssl: 'active',
        status: 'active',
        validationRecords: [{ txt_name: '_acme-challenge.app.acme.com', txt_value: 'v' }],
      },
    ]);
    const id = edge.seed('app.acme.com', {
      verificationErrors: ['custom hostname does not CNAME'],
    });
    const status = async () =>
      (
        (await (await call('GET', `/${id}`)).json()) as {
          result: { status: string; ssl: { status: string } };
        }
      ).result;
    expect(await status()).toMatchObject({
      ssl: { status: 'pending_validation' },
      status: 'pending',
    });
    expect(await status()).toMatchObject({ ssl: { status: 'active' }, status: 'active' });
    expect(await status()).toMatchObject({
      ssl: { status: 'active', validation_records: [{ txt_value: 'v' }] },
      status: 'active',
      verification_errors: ['custom hostname does not CNAME'],
    });
    edge.scriptStatus('app.acme.com', []);
    expect(await status()).toMatchObject({ status: 'active' });
  });

  it('fails the next call once with 429 or 503', async () => {
    edge.failNext(429);
    expect((await call('GET')).status).toBe(429);
    edge.failNext(503);
    expect((await call('GET')).status).toBe(503);
    expect((await call('GET')).status).toBe(200);
  });

  it('hangs the next call once, until close releases it', async () => {
    edge.failNext('hang');
    const hung = call('GET').then(
      () => 'answered',
      () => 'dropped',
    );
    const raced = await Promise.race([
      hung,
      new Promise((resolve) => setTimeout(() => resolve('pending'), 100)),
    ]);
    expect(raced).toBe('pending');
    await edge.close();
    expect(await hung).toBe('dropped');
    await edge.close();
  });
});
