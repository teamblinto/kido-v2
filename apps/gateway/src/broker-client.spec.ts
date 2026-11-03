import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { createBrokerClient } from './broker-client.ts';
import { RouteCache } from './route-cache.ts';
import {
  createDomainVerifier,
  createRouteVerifier,
  createSiteVerifier,
  type RouteRecord,
  type SiteRecord,
} from './route-verify.ts';

type Pair = Awaited<ReturnType<typeof generateKeyPair>>;

const LABEL = '8f14e45fceea167a5a36dedd4bea2543';
const SECRET = 'local-broker-secret';
const CTX = { host: `${LABEL}-5173.forge-preview.localhost` };

const claims: Omit<RouteRecord, 'exp' | 'iat'> = {
  label: LABEL,
  org: '0f6c5f9e-3c1a-4c56-9a4e-4b8f8d3c1a11',
  ports: [5173],
  project: '6b1d1a7c-8a1b-4c3e-9e6f-2d3c4b5a6f70',
  sandbox: 'sbx_01',
  state: 'active',
  upstream: 'https://5173-sbx.proxy.example.test',
  upstreamToken: 'tok',
  visibility: 'private',
};

interface Seen {
  body: string;
  headers: IncomingMessage['headers'];
  method: string | undefined;
  url: string | undefined;
}

/** A stub broker: every request is recorded and answered by the current `answer`. */
function stubBroker(): {
  answer: (res: ServerResponse) => void;
  close: () => Promise<void>;
  origin: () => string;
  seen: Seen[];
  server: Server;
} {
  const seen: Seen[] = [];
  const stub = {
    answer: (res: ServerResponse) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    },
    close: () => new Promise<void>((resolve) => stub.server.close(() => resolve())),
    origin: () => `http://127.0.0.1:${String((stub.server.address() as AddressInfo).port)}`,
    seen,
    server: createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        body += chunk;
      });
      req.on('end', () => {
        seen.push({ body, headers: req.headers, method: req.method, url: req.url });
        stub.answer(res);
      });
    }),
  };
  return stub;
}

function json(status: number, body: unknown): (res: ServerResponse) => void {
  return (res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

describe('createBrokerClient (plain transport)', () => {
  let pair: Pair;
  let jws: string;
  let broker: ReturnType<typeof stubBroker>;
  let cache: RouteCache;
  let client: ReturnType<typeof createBrokerClient>;

  beforeAll(async () => {
    pair = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    jws = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(pair.privateKey);
  });

  beforeEach(async () => {
    broker = stubBroker();
    await new Promise<void>((resolve) => broker.server.listen(0, '127.0.0.1', resolve));
    cache = new RouteCache({ max: 10, ttlMs: 5000 });
    client = createBrokerClient({
      cache,
      origin: broker.origin(),
      sharedSecret: SECRET,
      timeoutMs: 500,
      transport: 'plain',
      verify: createRouteVerifier({
        keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'k1', use: 'sig' }],
      }),
    });
  });

  afterEach(async () => {
    await broker.close();
  });

  it('on a miss fetches, verifies and caches the route; the hit never dials the broker', async () => {
    broker.answer = json(200, { route: jws });

    const first = await client.getRoute(LABEL, CTX);
    expect(first.kind).toBe('route');
    expect(first.kind === 'route' && first.route).toMatchObject(claims);
    expect(cache.get(LABEL)).toMatchObject(claims);

    expect(broker.seen).toHaveLength(1);
    expect(broker.seen[0]).toMatchObject({
      method: 'GET',
      url: `/broker/routes/${LABEL}`,
    });
    expect(broker.seen[0]?.headers['x-broker-secret']).toBe(SECRET);

    await expect(client.getRoute(LABEL, CTX)).resolves.toEqual(first);
    expect(broker.seen).toHaveLength(1);
  });

  it('keeps serving a cached route through a broker outage', async () => {
    broker.answer = json(200, { route: jws });
    await client.getRoute(LABEL, CTX);
    await broker.close();

    await expect(client.getRoute(LABEL, CTX)).resolves.toMatchObject({ kind: 'route' });
  });

  it('returns retryable, never throws, when the broker is unreachable', async () => {
    await broker.close();

    const result = await client.getRoute(LABEL, CTX);
    expect(result.kind).toBe('retryable');
    expect(cache.get(LABEL)).toBeUndefined();
  });

  it('returns retryable when the broker answers 5xx or garbage', async () => {
    broker.answer = json(500, {});
    await expect(client.getRoute(LABEL, CTX)).resolves.toMatchObject({ kind: 'retryable' });

    broker.answer = (res) => {
      res.writeHead(200);
      res.end('not json');
    };
    await expect(client.getRoute(LABEL, CTX)).resolves.toMatchObject({ kind: 'retryable' });
  });

  it('maps 404 {} to refused and caches nothing', async () => {
    await expect(client.getRoute(LABEL, CTX)).resolves.toEqual({ kind: 'refused' });
    expect(cache.size).toBe(0);
  });

  it('sends x-preview-host always and x-preview-grant only when the visitor carries one', async () => {
    await client.getRoute(LABEL, CTX);
    expect(broker.seen[0]?.headers['x-preview-host']).toBe(CTX.host);
    expect(broker.seen[0]?.headers['x-preview-grant']).toBeUndefined();

    await client.getRoute(LABEL, { ...CTX, grant: 'g.r.ant' });
    expect(broker.seen[1]?.headers['x-preview-host']).toBe(CTX.host);
    expect(broker.seen[1]?.headers['x-preview-grant']).toBe('g.r.ant');
  });

  it('maps 401 to unauthorised and caches nothing', async () => {
    broker.answer = json(401, {});
    await expect(client.getRoute(LABEL, CTX)).resolves.toEqual({ kind: 'unauthorised' });
    expect(cache.size).toBe(0);
  });

  it('passes 202 { waking: true } through untouched', async () => {
    broker.answer = json(202, { waking: true });
    await expect(client.getRoute(LABEL, CTX)).resolves.toEqual({ kind: 'waking' });
    expect(cache.size).toBe(0);
  });

  it('refuses a route that does not verify and caches nothing', async () => {
    broker.answer = json(200, { route: `${jws}x` });
    await expect(client.getRoute(LABEL, CTX)).resolves.toEqual({ kind: 'refused' });
    expect(cache.size).toBe(0);
  });

  it('redeems a grant with POST /broker/grants { code, host }', async () => {
    broker.answer = json(200, { grant: 'grant.jws' });

    await expect(client.redeemGrant({ code: 'c0de', host: 'x-5173.example' })).resolves.toEqual({
      grant: 'grant.jws',
      kind: 'grant',
    });
    expect(broker.seen[0]).toMatchObject({ method: 'POST', url: '/broker/grants' });
    expect(broker.seen[0]?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(broker.seen[0]?.body ?? '')).toEqual({
      code: 'c0de',
      host: 'x-5173.example',
    });

    broker.answer = json(404, {});
    await expect(client.redeemGrant({ code: 'c0de', host: 'h' })).resolves.toEqual({
      kind: 'refused',
    });

    await broker.close();
    await expect(client.redeemGrant({ code: 'c0de', host: 'h' })).resolves.toMatchObject({
      kind: 'retryable',
    });
  });
});

describe('createBrokerClient.getSite (contracts/site-serving.md § 2–3)', () => {
  const SITE_LABEL = 'my-site-7f3a';
  const siteClaims = {
    artifact: 'a'.repeat(64),
    deployment: '3c2b1a0f-9e8d-4c7b-8a6f-5e4d3c2b1a0f',
    kind: 'site',
    label: SITE_LABEL,
    org: '0f6c5f9e-3c1a-4c56-9a4e-4b8f8d3c1a11',
    project: '6b1d1a7c-8a1b-4c3e-9e6f-2d3c4b5a6f70',
  };
  let pair: Pair;
  let broker: ReturnType<typeof stubBroker>;
  let cache: RouteCache;
  let client: ReturnType<typeof createBrokerClient>;

  const sign = (payload: Record<string, unknown>) =>
    new SignJWT(payload)
      .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
      .setIssuedAt()
      .setExpirationTime('30s')
      .sign(pair.privateKey);

  beforeAll(async () => {
    pair = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  });

  beforeEach(async () => {
    broker = stubBroker();
    await new Promise<void>((resolve) => broker.server.listen(0, '127.0.0.1', resolve));
    cache = new RouteCache({ max: 10, ttlMs: 5000 });
    const jwks = {
      keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'k1', use: 'sig' }],
    };
    client = createBrokerClient({
      cache,
      origin: broker.origin(),
      sharedSecret: SECRET,
      timeoutMs: 500,
      transport: 'plain',
      verify: createRouteVerifier(jwks),
      verifySite: createSiteVerifier(jwks),
    });
  });

  afterEach(async () => {
    await broker.close();
  });

  it('fetches, verifies and caches under site:{label}; the hit never dials the broker', async () => {
    broker.answer = json(200, { site: await sign(siteClaims) });

    const first = await client.getSite(SITE_LABEL);
    expect(first.kind === 'site' && first.site).toMatchObject(siteClaims);
    expect(broker.seen[0]).toMatchObject({ method: 'GET', url: `/broker/sites/${SITE_LABEL}` });
    expect(broker.seen[0]?.headers['x-broker-secret']).toBe(SECRET);
    expect(broker.seen[0]?.headers['x-preview-host']).toBeUndefined();
    expect(cache.get(`site:${SITE_LABEL}`)).toMatchObject(siteClaims);
    expect(cache.get(SITE_LABEL)).toBeUndefined();

    await expect(client.getSite(SITE_LABEL)).resolves.toEqual(first);
    expect(broker.seen).toHaveLength(1);
  });

  it('maps 404 {} to refused and caches nothing', async () => {
    await expect(client.getSite(SITE_LABEL)).resolves.toEqual({ kind: 'refused' });
    expect(cache.size).toBe(0);
  });

  it('refuses a record for another label, a preview record, and one that does not verify', async () => {
    broker.answer = json(200, { site: await sign({ ...siteClaims, label: 'other' }) });
    await expect(client.getSite(SITE_LABEL)).resolves.toEqual({ kind: 'refused' });

    broker.answer = json(200, { site: await sign({ ...claims, label: SITE_LABEL }) });
    await expect(client.getSite(SITE_LABEL)).resolves.toEqual({ kind: 'refused' });

    broker.answer = json(200, { site: 'not.a.jws' });
    await expect(client.getSite(SITE_LABEL)).resolves.toEqual({ kind: 'refused' });
    expect(cache.size).toBe(0);
  });

  it('never serves a cached preview route as a site', async () => {
    const route = { ...claims, exp: Math.floor(Date.now() / 1000) + 30, iat: 0 };
    cache.set(route as RouteRecord, `site:${SITE_LABEL}`);

    await expect(client.getSite(SITE_LABEL)).resolves.toEqual({ kind: 'refused' });
    expect(broker.seen).toHaveLength(0);
  });

  it('returns retryable for 5xx, a 200 without a site, and an unreachable broker', async () => {
    broker.answer = json(500, {});
    await expect(client.getSite(SITE_LABEL)).resolves.toMatchObject({ kind: 'retryable' });

    broker.answer = json(200, {});
    await expect(client.getSite(SITE_LABEL)).resolves.toMatchObject({ kind: 'retryable' });

    await broker.close();
    await expect(client.getSite(SITE_LABEL)).resolves.toMatchObject({ kind: 'retryable' });
    broker.server = createServer();
    await new Promise<void>((resolve) => broker.server.listen(0, '127.0.0.1', resolve));
  });

  describe('cache expiry (T061): a pointer change is seen within ROUTE_CACHE_TTL_MS', () => {
    // Only `Date` is faked: the stub broker and the client still need real sockets and timers.
    const T0 = new Date('2026-09-22T10:00:00Z');
    const RELEASE_A = { ...siteClaims, artifact: 'a'.repeat(64) };
    const RELEASE_B = {
      ...siteClaims,
      artifact: 'b'.repeat(64),
      deployment: '7e6d5c4b-3a29-4817-9a6f-5e4d3c2b1a0f',
    };
    const signAt = (payload: Record<string, unknown>, expSeconds: number) =>
      new SignJWT(payload)
        .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + expSeconds)
        .sign(pair.privateKey);

    beforeEach(() => {
      vi.useFakeTimers({ now: T0, toFake: ['Date'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('expires at the TTL when the record outlives it', async () => {
      broker.answer = json(200, { site: await signAt(RELEASE_A, 30) });
      await expect(client.getSite(SITE_LABEL)).resolves.toMatchObject({ site: RELEASE_A });

      // The release pointer moves: the broker now signs B.
      broker.answer = json(200, { site: await signAt(RELEASE_B, 30) });
      vi.setSystemTime(T0.getTime() + 4_999);
      await expect(client.getSite(SITE_LABEL)).resolves.toMatchObject({ site: RELEASE_A });
      expect(broker.seen).toHaveLength(1);

      vi.setSystemTime(T0.getTime() + 5_000);
      await expect(client.getSite(SITE_LABEL)).resolves.toMatchObject({ site: RELEASE_B });
      expect(broker.seen).toHaveLength(2);
    });

    it('expires at the record exp when that comes before the TTL', async () => {
      const longTtl = createBrokerClient({
        cache: new RouteCache({ max: 10, ttlMs: 60_000 }),
        origin: broker.origin(),
        sharedSecret: SECRET,
        timeoutMs: 500,
        transport: 'plain',
        verify: () => Promise.resolve(undefined),
        verifySite: createSiteVerifier({
          keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'k1', use: 'sig' }],
        }),
      });
      broker.answer = json(200, { site: await signAt(RELEASE_A, 3) });
      await expect(longTtl.getSite(SITE_LABEL)).resolves.toMatchObject({ site: RELEASE_A });

      vi.setSystemTime(T0.getTime() + 2_999);
      broker.answer = json(200, { site: await signAt(RELEASE_B, 30) });
      await expect(longTtl.getSite(SITE_LABEL)).resolves.toMatchObject({ site: RELEASE_A });
      expect(broker.seen).toHaveLength(1);

      vi.setSystemTime(T0.getTime() + 3_000);
      await expect(longTtl.getSite(SITE_LABEL)).resolves.toMatchObject({ site: RELEASE_B });
      expect(broker.seen).toHaveLength(2);
    });
  });

  it('refuses every site when no site verifier is configured', async () => {
    const previewOnly = createBrokerClient({
      cache,
      origin: broker.origin(),
      sharedSecret: SECRET,
      transport: 'plain',
      verify: () => Promise.resolve(undefined),
    });

    await expect(previewOnly.getSite(SITE_LABEL)).resolves.toEqual({ kind: 'refused' });
    expect(broker.seen).toHaveLength(0);
  });
});

describe('createBrokerClient.getDomain (contracts/domain-serving.md § 2)', () => {
  const HOSTNAME = 'www.acme-example.com';
  const domainClaims = {
    artifact: 'a'.repeat(64),
    deployment: '3c2b1a0f-9e8d-4c7b-8a6f-5e4d3c2b1a0f',
    hostname: HOSTNAME,
    kind: 'domain',
    org: '0f6c5f9e-3c1a-4c56-9a4e-4b8f8d3c1a11',
    project: '6b1d1a7c-8a1b-4c3e-9e6f-2d3c4b5a6f70',
  };
  let pair: Pair;
  let broker: ReturnType<typeof stubBroker>;
  let cache: RouteCache;
  let client: ReturnType<typeof createBrokerClient>;

  const sign = (payload: Record<string, unknown>) =>
    new SignJWT(payload)
      .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
      .setIssuedAt()
      .setExpirationTime('30s')
      .sign(pair.privateKey);

  beforeAll(async () => {
    pair = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  });

  beforeEach(async () => {
    broker = stubBroker();
    await new Promise<void>((resolve) => broker.server.listen(0, '127.0.0.1', resolve));
    cache = new RouteCache({ max: 10, ttlMs: 5000 });
    const jwks = {
      keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'k1', use: 'sig' }],
    };
    client = createBrokerClient({
      cache,
      origin: broker.origin(),
      sharedSecret: SECRET,
      timeoutMs: 500,
      transport: 'plain',
      verify: createRouteVerifier(jwks),
      verifyDomain: createDomainVerifier(jwks),
      verifySite: createSiteVerifier(jwks),
    });
  });

  afterEach(async () => {
    await broker.close();
  });

  it('fetches, verifies and caches under domain:{hostname}; the hit never dials the broker', async () => {
    broker.answer = json(200, { domain: await sign(domainClaims) });

    const first = await client.getDomain(HOSTNAME);
    expect(first.kind === 'domain' && first.domain).toMatchObject(domainClaims);
    expect(broker.seen[0]).toMatchObject({ method: 'GET', url: `/broker/domains/${HOSTNAME}` });
    expect(broker.seen[0]?.headers['x-broker-secret']).toBe(SECRET);
    expect(cache.get(`domain:${HOSTNAME}`)).toMatchObject(domainClaims);

    await expect(client.getDomain(HOSTNAME)).resolves.toEqual(first);
    expect(broker.seen).toHaveLength(1);
  });

  it('maps 404 {} to refused and caches nothing', async () => {
    await expect(client.getDomain(HOSTNAME)).resolves.toEqual({ kind: 'refused' });
    expect(cache.size).toBe(0);
  });

  it('refuses a record for another hostname, a site record, and one that does not verify', async () => {
    broker.answer = json(200, { domain: await sign({ ...domainClaims, hostname: 'a.acme.com' }) });
    await expect(client.getDomain(HOSTNAME)).resolves.toEqual({ kind: 'refused' });

    broker.answer = json(200, { domain: await sign({ ...domainClaims, kind: 'site' }) });
    await expect(client.getDomain(HOSTNAME)).resolves.toEqual({ kind: 'refused' });

    broker.answer = json(200, { domain: 'not.a.jws' });
    await expect(client.getDomain(HOSTNAME)).resolves.toEqual({ kind: 'refused' });
    expect(cache.size).toBe(0);
  });

  it('never serves a cached site or preview record as a domain', async () => {
    const exp = Math.floor(Date.now() / 1000) + 30;
    cache.set(
      { ...domainClaims, exp, iat: 0, kind: 'site', label: 'x' } as unknown as SiteRecord,
      `domain:${HOSTNAME}`,
    );

    await expect(client.getDomain(HOSTNAME)).resolves.toEqual({ kind: 'refused' });
    expect(broker.seen).toHaveLength(0);
  });

  it('never serves a cached domain record as a preview route', async () => {
    broker.answer = json(200, { domain: await sign(domainClaims) });
    await client.getDomain(HOSTNAME);
    // A key collision is impossible by construction; this pins the kind check anyway.
    const cached = cache.get(`domain:${HOSTNAME}`)!;
    cache.set(cached as unknown as RouteRecord, LABEL);
    broker.answer = json(404, {});

    await expect(client.getRoute(LABEL, CTX)).resolves.toEqual({ kind: 'refused' });
  });

  it('returns retryable for 5xx, a 200 without a domain, and an unreachable broker', async () => {
    broker.answer = json(500, {});
    await expect(client.getDomain(HOSTNAME)).resolves.toMatchObject({ kind: 'retryable' });

    broker.answer = json(200, { site: 'x' });
    await expect(client.getDomain(HOSTNAME)).resolves.toMatchObject({ kind: 'retryable' });

    await broker.close();
    await expect(client.getDomain(HOSTNAME)).resolves.toMatchObject({ kind: 'retryable' });
    broker.server = createServer();
    await new Promise<void>((resolve) => broker.server.listen(0, '127.0.0.1', resolve));
  });

  it('refuses every domain when no domain verifier is configured', async () => {
    const withoutDomains = createBrokerClient({
      cache,
      origin: broker.origin(),
      sharedSecret: SECRET,
      transport: 'plain',
      verify: () => Promise.resolve(undefined),
    });

    await expect(withoutDomains.getDomain(HOSTNAME)).resolves.toEqual({ kind: 'refused' });
    expect(broker.seen).toHaveLength(0);
  });
});
