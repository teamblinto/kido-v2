import type { ConfigService } from '@nestjs/config';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Environment } from '../../../config/environment';
import { RetryableFailure } from '../../outbox/consumer';
import { type FakeCloudflare, startFakeCloudflare } from '../../../../test/support/fake-cloudflare';
import { CloudflareForSaasAdapter, EDGE_REQUEST_TIMEOUT_MS } from './cloudflare-for-saas.adapter';
import { EdgeNotConfigured, EdgeRefused, type EdgeStatus } from './custom-hostname.port';

type CloudflareEnv = Partial<
  Record<
    'CLOUDFLARE_API_TOKEN' | 'CLOUDFLARE_API_URL' | 'CLOUDFLARE_ZONE_ID' | 'CUSTOM_HOSTNAME_CA',
    string
  >
>;

/** Whatever `fn` throws, or a failure of the spec when it does not. */
async function thrown(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

/**
 * The wire, against the loopback fake (research R2): the real `fetch`, headers, envelope parsing
 * and error mapping. The fake speaks the vendor's own state strings, so the R2 mapping is what is
 * exercised.
 */
describe('CloudflareForSaasAdapter', () => {
  let fake: FakeCloudflare;

  beforeEach(async () => {
    fake = await startFakeCloudflare();
  });

  afterEach(async () => {
    await fake.close();
  });

  function adapter(env?: CloudflareEnv, timeoutMs?: number): CloudflareForSaasAdapter {
    const values: CloudflareEnv = env ?? {
      CLOUDFLARE_API_TOKEN: fake.apiToken,
      CLOUDFLARE_API_URL: fake.apiUrl,
      CLOUDFLARE_ZONE_ID: fake.zoneId,
      CUSTOM_HOSTNAME_CA: 'lets_encrypt',
    };
    return new CloudflareForSaasAdapter(
      { get: (key: keyof CloudflareEnv) => values[key] } as unknown as ConfigService<
        Environment,
        true
      >,
      timeoutMs,
    );
  }

  it('register sends ssl.method http, the configured CA and min TLS 1.2, with the bearer token', async () => {
    const edge = adapter({
      CLOUDFLARE_API_TOKEN: fake.apiToken,
      CLOUDFLARE_API_URL: `${fake.apiUrl}/`,
      CLOUDFLARE_ZONE_ID: fake.zoneId,
      CUSTOM_HOSTNAME_CA: 'google',
    });

    const { edgeId } = await edge.register('shop.example.com');

    const record = fake.find('shop.example.com');
    expect(record?.id).toBe(edgeId);
    expect(record?.sslRequested).toEqual({
      certificate_authority: 'google',
      method: 'http',
      settings: { min_tls_version: '1.2' },
      type: 'dv',
    });
    const [request] = fake.requests;
    expect(request?.method).toBe('POST');
    expect(request?.path).toBe(`/client/v4/zones/${fake.zoneId}/custom_hostnames`);
    expect(request?.headers.authorization).toBe(`Bearer ${fake.apiToken}`);
    expect(request?.headers['content-type']).toBe('application/json');
  });

  it('adopts a duplicate-hostname answer through findByHostname', async () => {
    const existing = fake.seed('taken.example.com');

    expect(await adapter().register('taken.example.com')).toEqual({ edgeId: existing });
    expect(fake.requests.map((request) => request.method)).toEqual(['POST', 'GET']);
    expect(fake.requests[1]?.query).toEqual({ hostname: 'taken.example.com' });
    expect(fake.hostnames.size).toBe(1);
  });

  it('findByHostname answers the registration, or undefined when the edge has none', async () => {
    const id = fake.seed('one.example.com');
    fake.seed('other.example.com');
    const edge = adapter();

    expect(await edge.findByHostname('one.example.com')).toEqual({ edgeId: id });
    expect(await edge.findByHostname('none.example.com')).toBeUndefined();
  });

  describe('status maps every vendor state in R2', () => {
    const hostnameStates: readonly [string, EdgeStatus['hostname']][] = [
      ['active', 'active'],
      ['blocked', 'blocked'],
      ['moved', 'blocked'],
      ['deleted', 'gone'],
      ['pending_deletion', 'gone'],
      ['pending', 'pending'],
      ['pending_blocked', 'pending'],
      ['pending_migration', 'pending'],
      ['pending_provisioned', 'pending'],
      ['test_pending', 'pending'],
      ['something_new', 'pending'],
    ];
    const certificateStates: readonly [string, EdgeStatus['certificate']][] = [
      ['active', 'active'],
      ['validation_timed_out', 'failed'],
      ['issuance_timed_out', 'failed'],
      ['deployment_timed_out', 'failed'],
      ['deletion_timed_out', 'failed'],
      ['expired', 'failed'],
      ['deleted', 'gone'],
      ['initializing', 'pending'],
      ['pending_validation', 'pending'],
      ['pending_issuance', 'pending'],
      ['pending_deployment', 'pending'],
      ['pending_deletion', 'pending'],
      ['something_new', 'pending'],
    ];

    it.each(hostnameStates)('hostname %s → %s', async (vendor, ours) => {
      const id = fake.seed('h.example.com', { status: vendor });
      expect((await adapter().status(id)).hostname).toBe(ours);
    });

    it.each(certificateStates)('ssl %s → %s', async (vendor, ours) => {
      const id = fake.seed('c.example.com', { ssl: vendor });
      expect((await adapter().status(id)).certificate).toBe(ours);
    });
  });

  it('status carries TXT validation records, fully qualified without the dot, and the vendor messages', async () => {
    const edge = adapter();
    const { edgeId } = await edge.register('site.example.com');
    fake.scriptStatus('site.example.com', [
      {},
      {
        ssl: 'pending_validation',
        status: 'active',
        validationRecords: [
          { txt_name: '_acme-challenge.Site.Example.com.', txt_value: 'tok-123' },
        ],
        verificationErrors: ['custom hostname does not CNAME to this zone.'],
      },
    ]);

    expect(await edge.status(edgeId)).toEqual({
      certificate: 'pending',
      errors: [],
      hostname: 'pending',
      validationRecords: [],
    });
    expect(await edge.status(edgeId)).toEqual({
      certificate: 'pending',
      errors: ['custom hostname does not CNAME to this zone.'],
      hostname: 'active',
      validationRecords: [{ name: '_acme-challenge.site.example.com', value: 'tok-123' }],
    });
  });

  it('deregister removes the registration, and a 404 counts as done', async () => {
    const edge = adapter();
    const { edgeId } = await edge.register('bye.example.com');

    await edge.deregister(edgeId);
    expect(fake.hostnames.has(edgeId)).toBe(false);
    await expect(edge.deregister(edgeId)).resolves.toBeUndefined();
  });

  it('a 429 → RetryableFailure throttled', async () => {
    fake.failNext(429);
    const error = await thrown(() => adapter().register('a.example.com'));
    expect(error).toBeInstanceOf(RetryableFailure);
    expect((error as RetryableFailure).reason).toBe('throttled');
  });

  it('a 503 → RetryableFailure upstream-5xx', async () => {
    const id = fake.seed('b.example.com');
    fake.failNext(503);
    const error = await thrown(() => adapter().status(id));
    expect(error).toBeInstanceOf(RetryableFailure);
    expect((error as RetryableFailure).reason).toBe('upstream-5xx');
  });

  it('a hang past the request timeout → RetryableFailure timeout, and the default bound is 10 s', async () => {
    expect(EDGE_REQUEST_TIMEOUT_MS).toBe(10_000);
    fake.failNext('hang');
    const started = Date.now();
    const error = await thrown(() => adapter(undefined, 200).findByHostname('c.example.com'));
    expect(error).toBeInstanceOf(RetryableFailure);
    expect((error as RetryableFailure).reason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('a network error → RetryableFailure timeout', async () => {
    const edge = adapter();
    await fake.close();
    const error = await thrown(() => edge.register('d.example.com'));
    expect(error).toBeInstanceOf(RetryableFailure);
    expect((error as RetryableFailure).reason).toBe('timeout');
  });

  it('a 400 → EdgeRefused with the provider first message', async () => {
    fake.refuseNext(400, 'The hostname is not allowed.');
    const error = await thrown(() => adapter().register('e.example.com'));
    expect(error).toBeInstanceOf(EdgeRefused);
    expect((error as EdgeRefused).message).toBe('The hostname is not allowed.');
  });

  it('a 403 for a wrong token → EdgeRefused, and a 404 on status is a refusal too', async () => {
    const wrong = adapter({
      CLOUDFLARE_API_TOKEN: 'not-the-token',
      CLOUDFLARE_API_URL: fake.apiUrl,
      CLOUDFLARE_ZONE_ID: fake.zoneId,
    });
    await expect(wrong.register('f.example.com')).rejects.toThrow(EdgeRefused);
    await expect(adapter().status('no-such-id')).rejects.toThrow(EdgeRefused);
  });

  it('a 2xx body the adapter does not understand → RetryableFailure upstream-5xx', async () => {
    const id = fake.seed('g.example.com');
    // A `status` that is not a string: a vendor shape this version does not know.
    fake.hostnames.get(id)!.status = 42 as unknown as string;
    const error = await thrown(() => adapter().status(id));
    expect(error).toBeInstanceOf(RetryableFailure);
    expect((error as RetryableFailure).reason).toBe('upstream-5xx');
  });

  it('the bearer token appears in no thrown error message, cause or serialised form', async () => {
    const token = fake.apiToken;
    const edge = adapter();
    const errors: unknown[] = [];

    fake.failNext(429);
    errors.push(await thrown(() => edge.register('t1.example.com')));
    fake.failNext(503);
    errors.push(await thrown(() => edge.register('t2.example.com')));
    fake.refuseNext(400, 'refused');
    errors.push(await thrown(() => edge.register('t3.example.com')));
    fake.failNext('hang');
    errors.push(await thrown(() => adapter(undefined, 100).register('t4.example.com')));
    errors.push(await thrown(() => edge.status('missing')));
    await fake.close();
    errors.push(await thrown(() => edge.register('t5.example.com')));

    expect(errors).toHaveLength(6);
    for (const error of errors) {
      const e = error as Error;
      expect(e.message).not.toContain(token);
      expect(inspect(e.cause, { depth: 10 })).not.toContain(token);
      expect(inspect(e, { depth: 10, showHidden: true })).not.toContain(token);
      expect(JSON.stringify(e)).not.toContain(token);
      expect(String(e.stack)).not.toContain(token);
    }
  });

  it('with the CLOUDFLARE_* group absent every call answers not-configured, and nothing is sent', async () => {
    const edge = adapter({ CLOUDFLARE_API_URL: fake.apiUrl });

    await expect(edge.register('x.example.com')).rejects.toThrow(EdgeNotConfigured);
    await expect(edge.status('id')).rejects.toThrow(EdgeNotConfigured);
    await expect(edge.findByHostname('x.example.com')).rejects.toThrow(EdgeNotConfigured);
    await expect(edge.deregister('id')).rejects.toThrow(EdgeNotConfigured);
    expect(fake.requests).toEqual([]);
  });
});
