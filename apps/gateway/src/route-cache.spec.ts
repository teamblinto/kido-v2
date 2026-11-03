import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { createBrokerClient } from './broker-client.ts';
import { RouteCache } from './route-cache.ts';
import { createRouteVerifier, type RouteRecord } from './route-verify.ts';

const NOW = new Date('2026-09-18T10:00:00Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

function route(label: string, ttlSeconds = 30): RouteRecord {
  return {
    exp: NOW_SECONDS + ttlSeconds,
    iat: NOW_SECONDS,
    label,
    org: '0f6c5f9e-3c1a-4c56-9a4e-4b8f8d3c1a11',
    ports: [5173],
    project: '6b1d1a7c-8a1b-4c3e-9e6f-2d3c4b5a6f70',
    sandbox: 'sbx_01',
    state: 'active',
    upstream: 'https://5173-sbx.proxy.example.test',
    upstreamToken: 'tok',
    visibility: 'private',
  };
}

describe('RouteCache', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves an entry until the TTL and forgets it after', () => {
    const cache = new RouteCache({ max: 10, ttlMs: 5000 });
    cache.set(route('a'));

    vi.advanceTimersByTime(4999);
    expect(cache.get('a')).toEqual(route('a'));

    vi.advanceTimersByTime(1);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('floors the TTL at the route exp so a stale cache never outlives the route', () => {
    const cache = new RouteCache({ max: 10, ttlMs: 5000 });
    cache.set(route('a', 2));

    vi.advanceTimersByTime(1999);
    expect(cache.get('a')).toBeDefined();

    vi.advanceTimersByTime(1);
    expect(cache.get('a')).toBeUndefined();
  });

  it('uses the shorter of the TTL and exp', () => {
    const cache = new RouteCache({ max: 10, ttlMs: 5000 });
    cache.set(route('long', 60));
    cache.set(route('short', 1));

    vi.advanceTimersByTime(1000);
    expect(cache.get('short')).toBeUndefined();
    expect(cache.get('long')).toBeDefined();

    vi.advanceTimersByTime(4000);
    expect(cache.get('long')).toBeUndefined();
  });

  it('evicts the oldest entry once the bound is reached', () => {
    const cache = new RouteCache({ max: 2, ttlMs: 5000 });
    cache.set(route('a'));
    cache.set(route('b'));
    cache.set(route('c'));

    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('re-setting a label makes it the newest entry', () => {
    const cache = new RouteCache({ max: 2, ttlMs: 5000 });
    cache.set(route('a'));
    cache.set(route('b'));
    cache.set(route('a'));
    cache.set(route('c'));

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('drops a route by label', () => {
    const cache = new RouteCache({ max: 2, ttlMs: 5000 });
    cache.set(route('a'));
    cache.delete('a');

    expect(cache.get('a')).toBeUndefined();
  });

  it("stores a record under an explicit key, bounded by that record's own exp", () => {
    const cache = new RouteCache({ max: 10, ttlMs: 5000 });
    const site = {
      artifact: 'a'.repeat(64),
      deployment: '3c2b1a0f-9e8d-4c7b-8a6f-5e4d3c2b1a0f',
      exp: NOW_SECONDS + 2,
      iat: NOW_SECONDS,
      kind: 'site' as const,
      label: 'a',
      org: '0f6c5f9e-3c1a-4c56-9a4e-4b8f8d3c1a11',
      project: '6b1d1a7c-8a1b-4c3e-9e6f-2d3c4b5a6f70',
    };
    cache.set(route('a'));
    cache.set(site, 'site:a');

    expect(cache.get('a')).toEqual(route('a'));
    expect(cache.get('site:a')).toEqual(site);
    vi.advanceTimersByTime(2000);
    expect(cache.get('site:a')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
  });
});

/**
 * SC-006 through the broker client (T038): the cache is the only thing standing between a
 * rotated label and its refusal, and it never outlives `min(TTL, exp)` — with or without a broker.
 */
describe('RouteCache under rotation (SC-006)', () => {
  const LABEL = '8f14e45fceea167a5a36dedd4bea2543';
  const CTX = { host: `${LABEL}-5173.forge-preview.localhost` };
  const reply = { body: '{}', hits: 0, status: 404 };
  let server: Server;
  let cache: RouteCache;
  let client: ReturnType<typeof createBrokerClient>;

  beforeEach(async () => {
    vi.useRealTimers();
    Object.assign(reply, { body: '{}', hits: 0, status: 404 });
    server = createServer((_req, res) => {
      reply.hits += 1;
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(reply.body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));

    const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const { exp, iat, ...claims } = route(LABEL);
    void exp;
    void iat;
    const jws = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
      .setIssuedAt()
      .setExpirationTime('30s')
      .sign(pair.privateKey);
    Object.assign(reply, { body: JSON.stringify({ route: jws }), status: 200 });
    cache = new RouteCache({ max: 10, ttlMs: 5000 });
    client = createBrokerClient({
      cache,
      origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
      sharedSecret: 's',
      timeoutMs: 500,
      transport: 'plain',
      verify: createRouteVerifier({
        keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'k1', use: 'sig' }],
      }),
    });
    await expect(client.getRoute(LABEL, CTX)).resolves.toMatchObject({ kind: 'route' });
    expect(reply.hits).toBe(1);
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
  });

  it('a cached route stops resolving once the TTL elapses even with the broker unreachable', async () => {
    await new Promise((r) => server.close(r));

    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    vi.advanceTimersByTime(4000);
    await expect(client.getRoute(LABEL, CTX)).resolves.toMatchObject({ kind: 'route' });

    vi.advanceTimersByTime(1000);
    // Nothing cached, broker gone: retryable, never the stale route.
    await expect(client.getRoute(LABEL, CTX)).resolves.toMatchObject({ kind: 'retryable' });
    expect(cache.size).toBe(0);
  });

  it('a rotated label is refused at the broker on the very next miss regardless of cache state', async () => {
    // Rotation: the broker now answers 404 {} for the old label. A cold cache asks at once …
    Object.assign(reply, { body: '{}', status: 404 });
    cache.delete(LABEL);
    await expect(client.getRoute(LABEL, CTX)).resolves.toEqual({ kind: 'refused' });
    expect(reply.hits).toBe(2);

    // … and a warm one asks on its first miss after the TTL, with nothing re-cached in between.
    cache.set(route(LABEL));
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    vi.advanceTimersByTime(5000);
    await expect(client.getRoute(LABEL, CTX)).resolves.toEqual({ kind: 'refused' });
    expect(reply.hits).toBe(3);
    expect(cache.size).toBe(0);
  });
});
