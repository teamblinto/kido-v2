import {
  createServer,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from 'node:http';
import { type AddressInfo, connect } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  BrokerDomainResult,
  BrokerGrantResult,
  BrokerRouteResult,
  BrokerSiteResult,
} from './broker-client.ts';
import { createEdgeOriginCheck } from './edge-origin.ts';
import type { Grant } from './grant-check.ts';
import { NOT_SERVING_PAGE, REFUSED_PAGE, SITE_UNAVAILABLE_PAGE, WAKING_PAGE } from './pages.ts';
import { BROKER_UNAVAILABLE_PAGE, createPipeline } from './pipeline.ts';
import type { DomainRecord, RouteRecord, SiteRecord } from './route-verify.ts';
import { createManifestCache } from './site-serve.ts';

const DOMAIN = 'forge-preview.localhost';
const LABEL = '0123456789abcdef0123';
const NOW = Math.floor(Date.now() / 1000);
const HOST = `${LABEL}-5173.${DOMAIN}`;
const PRODUCT = 'https://app.example.test';

const servers: Server[] = [];

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function route(upstreamPort: number, overrides: Partial<RouteRecord> = {}): RouteRecord {
  return {
    exp: NOW + 30,
    iat: NOW,
    label: LABEL,
    org: '00000000-0000-4000-8000-000000000000',
    ports: [5173],
    project: '00000000-0000-4000-8000-000000000001',
    sandbox: 'sb',
    state: 'active',
    upstream: `http://127.0.0.1:${String(upstreamPort)}`,
    upstreamToken: 'tok',
    visibility: 'public',
    ...overrides,
  };
}

/** A grant "verifier" that accepts exactly `good` for HOST, with 600 s left. */
const GOOD = 'good.grant.jws';
function verifyGrant(jws: string, host: string): Promise<Grant | undefined> {
  return Promise.resolve(
    jws === GOOD && host === HOST ? { aud: host, exp: NOW + 600, sub: 'u' } : undefined,
  );
}

async function gateway(
  answer: BrokerRouteResult,
  grantAnswer: BrokerGrantResult = { kind: 'refused' },
) {
  const getRoute = vi.fn(() => Promise.resolve(answer));
  const redeemGrant = vi.fn(() => Promise.resolve(grantAnswer));
  const pipeline = createPipeline({
    broker: { getRoute, redeemGrant },
    previewDomain: DOMAIN,
    productOrigin: PRODUCT,
    socketMaxMs: 60_000,
    upstreamTimeoutMs: 5000,
    verifyGrant,
    wakeBudgetMs: 90_000,
  });
  const server = createServer((req, res) => void pipeline.onRequest(req, res));
  server.on('upgrade', (req, socket, head) => void pipeline.onUpgrade(req, socket, head));
  return { getRoute, port: await listen(server), redeemGrant };
}

function get(
  port: number,
  host: string,
  path = '/',
  cookie?: string,
  extra: { headers?: Record<string, string>; method?: string } = {},
) {
  return new Promise<{ body: string; headers: IncomingMessage['headers']; status: number }>(
    (resolve, reject) => {
      const req = request(
        {
          headers: {
            ...extra.headers,
            connection: 'close',
            host,
            ...(cookie === undefined ? {} : { cookie }),
          },
          host: '127.0.0.1',
          method: extra.method ?? 'GET',
          path,
          port,
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            body += chunk;
          });
          res.on('end', () => resolve({ body, headers: res.headers, status: res.statusCode ?? 0 }));
        },
      );
      req.on('error', reject);
      req.end();
    },
  );
}

/** Sends a raw upgrade request and returns the status line the gateway answers with. */
function upgrade(port: number, host: string, path = '/', extraHeaders = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
          `Sec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n${extraHeaders}\r\n`,
      );
    });
    socket.once('data', (data) => {
      resolve(data.toString().split('\r\n')[0] ?? '');
      socket.destroy();
    });
    socket.on('error', reject);
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

describe('the gateway pipeline', () => {
  it('refuses a host that is not a preview host with 404 and never asks the broker', async () => {
    const { getRoute, port } = await gateway({ kind: 'refused' });

    const reply = await get(port, `evil.${DOMAIN}`);

    expect(reply.status).toBe(404);
    expect(reply.body).toBe(REFUSED_PAGE.body);
    expect(getRoute).not.toHaveBeenCalled();
  });

  it('refuses an unknown label with the same 404', async () => {
    const { getRoute, port } = await gateway({ kind: 'refused' });

    const reply = await get(port, `${LABEL}-5173.${DOMAIN}`);

    expect(reply.status).toBe(404);
    expect(reply.body).toBe(REFUSED_PAGE.body);
    expect(getRoute).toHaveBeenCalledWith(LABEL, { grant: undefined, host: HOST });
  });

  it('refuses an undeclared port with 404 before any dial', async () => {
    const dial = vi.fn();
    const upstreamPort = await listen(createServer(dial));
    const { port } = await gateway({ kind: 'route', route: route(upstreamPort) });

    const reply = await get(port, `${LABEL}-8080.${DOMAIN}`);

    expect(reply.status).toBe(404);
    expect(reply.body).toBe(REFUSED_PAGE.body);
    expect(dial).not.toHaveBeenCalled();
  });

  describe('a non-public route', () => {
    async function privateGateway(grantAnswer?: BrokerGrantResult) {
      const dial = vi.fn((req: IncomingMessage, res: ServerResponse) =>
        res.end(String(req.headers.cookie)),
      );
      const upstreamPort = await listen(createServer(dial));
      const gw = await gateway(
        { kind: 'route', route: route(upstreamPort, { visibility: 'private' }) },
        grantAnswer,
      );
      return { ...gw, dial };
    }

    it('redirects to the product origin without a grant, dialling nothing', async () => {
      const { dial, port, redeemGrant } = await privateGateway();

      const reply = await get(port, `${HOST}:3200`, '/x?y=1', 'other=1');

      expect(reply.status).toBe(302);
      expect(reply.headers.location).toBe(
        `${PRODUCT}/preview-authorize?label=${LABEL}&return=${encodeURIComponent(`${HOST}:3200`)}`,
      );
      expect(reply.headers['cache-control']).toBe('no-store');
      expect(dial).not.toHaveBeenCalled();
      expect(redeemGrant).not.toHaveBeenCalled();
    });

    it('falls back to the bare hostname when the Host header is not hostname[:port]', async () => {
      const { port } = await privateGateway();

      const reply = await get(port, `${HOST}:3200@evil.example`);

      expect(reply.status).toBe(302);
      expect(reply.headers.location).toBe(
        `${PRODUCT}/preview-authorize?label=${LABEL}&return=${HOST}`,
      );
    });

    it('redirects when the grant cookie does not verify', async () => {
      const { dial, port } = await privateGateway();

      const reply = await get(port, HOST, '/', '__Host-preview_grant=bad.grant.jws');

      expect(reply.status).toBe(302);
      expect(dial).not.toHaveBeenCalled();
    });

    it('proxies with a valid grant and strips the cookie on the way out', async () => {
      const { port } = await privateGateway();

      const reply = await get(port, HOST, '/', `a=1; __Host-preview_grant=${GOOD}; b=2`);

      expect(reply.status).toBe(200);
      expect(reply.body).toBe('a=1; b=2');
      expect(reply.headers['x-robots-tag']).toBeUndefined();
    });

    it('treats org visibility like private', async () => {
      const upstreamPort = await listen(createServer((_req, res) => res.end('ok')));
      const { port } = await gateway({
        kind: 'route',
        route: route(upstreamPort, { visibility: 'org' }),
      });

      expect((await get(port, HOST)).status).toBe(302);
      expect((await get(port, HOST, '/', `__Host-preview_grant=${GOOD}`)).status).toBe(200);
    });

    it('redeems a ?code= return into the cookie and redirects to the same path without it', async () => {
      const { dial, port, redeemGrant } = await privateGateway({ grant: GOOD, kind: 'grant' });

      const reply = await get(port, `${HOST}:3200`, '/a/b?code=c0de&k=v');

      expect(redeemGrant).toHaveBeenCalledWith({ code: 'c0de', host: HOST });
      expect(reply.status).toBe(302);
      expect(reply.headers.location).toBe('/a/b?k=v');
      const [cookie] = reply.headers['set-cookie'] ?? [];
      // NOW is captured at import; a second may tick before the request lands.
      expect(
        [599, 600].map(
          (age) =>
            `__Host-preview_grant=${GOOD}; Max-Age=${String(age)}; Path=/; Secure; HttpOnly; SameSite=Lax`,
        ),
      ).toContain(cookie);
      expect(dial).not.toHaveBeenCalled();
    });

    it('redeems a code inside a frame into a partitioned SameSite=None cookie', async () => {
      const { port } = await privateGateway({ grant: GOOD, kind: 'grant' });

      const reply = await get(port, HOST, '/?code=c0de', undefined, {
        headers: { 'sec-fetch-dest': 'iframe' },
      });

      expect(reply.status).toBe(302);
      const [cookie] = reply.headers['set-cookie'] ?? [];
      expect(cookie).toMatch(
        new RegExp(
          `^__Host-preview_grant=${GOOD}; Max-Age=(599|600); Path=/; Secure; HttpOnly; SameSite=None; Partitioned$`,
        ),
      );
    });

    it('refuses a code the broker refuses, and a grant the broker sent for another host', async () => {
      const refused = await privateGateway({ kind: 'refused' });
      expect((await get(refused.port, HOST, '/?code=x')).status).toBe(404);

      const wrong = await privateGateway({ grant: 'bad.grant.jws', kind: 'grant' });
      const reply = await get(wrong.port, HOST, '/?code=x');
      expect(reply.status).toBe(404);
      expect(reply.headers['set-cookie']).toBeUndefined();
    });

    it('answers 503 Retry-After when the broker is unreachable for a code', async () => {
      const { port } = await privateGateway({ kind: 'retryable', reason: 'down' });

      const reply = await get(port, HOST, '/?code=x');

      expect(reply.status).toBe(503);
      expect(reply.headers['retry-after']).toBe('2');
    });

    it('refuses an upgrade without a grant with 404, never a redirect', async () => {
      const { port } = await privateGateway();

      expect(await upgrade(port, HOST)).toBe('HTTP/1.1 404 Not Found');
    });

    it('never redeems a ?code= on an upgrade', async () => {
      const { port, redeemGrant } = await privateGateway({ grant: GOOD, kind: 'grant' });

      expect(await upgrade(port, HOST, '/?code=c0de')).toBe('HTTP/1.1 404 Not Found');
      expect(redeemGrant).not.toHaveBeenCalled();
    });
  });

  it('serves the waking page with Retry-After when the broker says waking', async () => {
    const { port } = await gateway({ kind: 'waking' });

    const reply = await get(port, `${LABEL}-5173.${DOMAIN}`);

    expect(reply.status).toBe(202);
    expect(reply.headers['retry-after']).toBe('2');
    expect(reply.body).toBe(WAKING_PAGE.body);
  });

  it('answers 503 Retry-After: 2 when the broker is unreachable on a miss', async () => {
    const { port } = await gateway({ kind: 'retryable', reason: 'ECONNREFUSED' });

    const reply = await get(port, `${LABEL}-5173.${DOMAIN}`);

    expect(reply.status).toBe(503);
    expect(reply.headers['retry-after']).toBe('2');
    expect(reply.headers['cache-control']).toBe('no-store');
  });

  it('proxies a verified public route on a declared port', async () => {
    const upstreamPort = await listen(
      createServer((req, res) => res.end(`hi ${String(req.headers['x-daytona-preview-token'])}`)),
    );
    const { port } = await gateway({ kind: 'route', route: route(upstreamPort) });

    const reply = await get(port, `${LABEL}-5173.${DOMAIN}`);

    expect(reply.status).toBe(200);
    expect(reply.body).toBe('hi tok');
    expect(reply.headers['x-robots-tag']).toBe('noindex');
  });

  it('serves the not-serving page when the sandbox refuses the connection', async () => {
    const closed = createServer();
    const closedPort = await listen(closed);
    await new Promise((r) => closed.close(r));
    const { port } = await gateway({ kind: 'route', route: route(closedPort) });

    const reply = await get(port, `${LABEL}-5173.${DOMAIN}`);

    expect(reply.status).toBe(503);
    expect(reply.body).toBe(NOT_SERVING_PAGE.body);
  });

  it('applies the same refusals to an upgrade on the raw socket', async () => {
    const { port } = await gateway({ kind: 'refused' });

    expect(await upgrade(port, `nope.${DOMAIN}`)).toBe('HTTP/1.1 404 Not Found');
    expect(await upgrade(port, `${LABEL}-5173.${DOMAIN}`)).toBe('HTTP/1.1 404 Not Found');
  });

  it('refuses an upgrade on an undeclared port with 404 before any dial', async () => {
    const dial = vi.fn();
    const upstream = createServer();
    upstream.on('upgrade', dial);
    const upstreamPort = await listen(upstream);
    const { port } = await gateway({ kind: 'route', route: route(upstreamPort) });

    expect(await upgrade(port, `${LABEL}-8080.${DOMAIN}`)).toBe('HTTP/1.1 404 Not Found');
    expect(dial).not.toHaveBeenCalled();
  });

  it('turns a throw on the request path into a 404 instead of an unhandled rejection', async () => {
    const { port } = await gateway({ kind: 'route', route: route(1, { upstream: 'not a url' }) });

    const reply = await get(port, `${LABEL}-5173.${DOMAIN}`);

    expect(reply.status).toBe(404);
    expect(reply.body).toBe(REFUSED_PAGE.body);
  });

  it('turns a throw on the upgrade path into a 404 on the raw socket', async () => {
    const { port } = await gateway({ kind: 'route', route: route(1, { upstream: 'not a url' }) });

    expect(await upgrade(port, `${LABEL}-5173.${DOMAIN}`)).toBe('HTTP/1.1 404 Not Found');
  });

  it('answers an upgrade 503 with Retry-After when the broker is unreachable', async () => {
    const { port } = await gateway({ kind: 'retryable', reason: 'down' });

    expect(await upgrade(port, `${LABEL}-5173.${DOMAIN}`)).toBe('HTTP/1.1 503 Service Unavailable');
  });
});

describe('the gateway pipeline: sites (contracts/site-serving.md)', () => {
  const SITE_DOMAIN = 'forge-site.localhost';
  const SITE_HOST = `my-site.${SITE_DOMAIN}`;
  const site: SiteRecord = {
    artifact: 'a'.repeat(64),
    deployment: '00000000-0000-4000-8000-000000000002',
    exp: NOW + 30,
    iat: NOW,
    kind: 'site',
    label: 'my-site',
    org: '00000000-0000-4000-8000-000000000000',
    project: '00000000-0000-4000-8000-000000000001',
  };

  async function siteGateway(answer: BrokerSiteResult, withSites = true) {
    const getRoute = vi.fn(() => Promise.resolve<BrokerRouteResult>({ kind: 'refused' }));
    const getSite = vi.fn((_label: string) => Promise.resolve(answer));
    const storeGet = vi.fn((_key: string) => Promise.reject(new Error('store down')));
    const redeemGrant = vi.fn(() => Promise.resolve<BrokerGrantResult>({ kind: 'refused' }));
    const checkGrant = vi.fn(verifyGrant);
    const pipeline = createPipeline({
      broker: { getRoute, redeemGrant },
      previewDomain: DOMAIN,
      productOrigin: PRODUCT,
      site: withSites
        ? {
            domain: SITE_DOMAIN,
            getSite,
            manifests: createManifestCache(),
            store: { get: storeGet },
          }
        : undefined,
      socketMaxMs: 60_000,
      upstreamTimeoutMs: 5000,
      verifyGrant: checkGrant,
      wakeBudgetMs: 90_000,
    });
    const server = createServer((req, res) => void pipeline.onRequest(req, res));
    server.on('upgrade', (req, socket, head) => void pipeline.onUpgrade(req, socket, head));
    return { checkGrant, getRoute, getSite, port: await listen(server), redeemGrant, storeGet };
  }

  it('asks the broker for the site label and serves from the store for that record', async () => {
    const gw = await siteGateway({ kind: 'site', site });

    const res = await get(gw.port, `${SITE_HOST}:3200`, '/');

    expect(gw.getSite).toHaveBeenCalledWith('my-site');
    expect(gw.getRoute).not.toHaveBeenCalled();
    expect(gw.storeGet).toHaveBeenCalledWith(
      `${site.org}/${site.project}/${site.artifact}/manifest.json`,
    );
    // The fake store is down: the site path answered, not the preview one.
    expect(res.status).toBe(503);
    expect(res.body).toBe(SITE_UNAVAILABLE_PAGE.body);
  });

  it('answers an unknown site label with the uniform 404 bytes', async () => {
    const gw = await siteGateway({ kind: 'refused' });

    const res = await get(gw.port, SITE_HOST);

    expect(res.status).toBe(404);
    expect(res.body).toBe(REFUSED_PAGE.body);
    expect(gw.storeGet).not.toHaveBeenCalled();
  });

  it('answers 503 Retry-After when the broker is unreachable for a site', async () => {
    const gw = await siteGateway({ kind: 'retryable', reason: 'down' });

    const res = await get(gw.port, SITE_HOST);

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('2');
  });

  it('refuses an upgrade on a site host without asking the broker', async () => {
    const gw = await siteGateway({ kind: 'site', site });

    await expect(upgrade(gw.port, SITE_HOST)).resolves.toContain('404');
    expect(gw.getSite).not.toHaveBeenCalled();
  });

  // T070: the site branch never reaches waking (the broker's route call), the grant check, the
  // grant redeem or the proxy, whatever preview credentials the request carries.
  it.each<[string, BrokerSiteResult]>([
    ['a live site', { kind: 'site', site }],
    ['a refused site', { kind: 'refused' }],
  ])(
    'never touches the preview path for %s, even with a grant cookie and ?code=',
    async (_n, a) => {
      const gw = await siteGateway(a);

      const res = await get(
        gw.port,
        SITE_HOST,
        '/?code=grant-code',
        `__Host-preview_grant=${GOOD}; __Host-session=product`,
      );

      expect(gw.getSite).toHaveBeenCalledOnce();
      expect(gw.getRoute).not.toHaveBeenCalled();
      expect(gw.checkGrant).not.toHaveBeenCalled();
      expect(gw.redeemGrant).not.toHaveBeenCalled();
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.headers.location).toBeUndefined();
      expect(res.status).toBe(a.kind === 'site' ? 503 : 404);
    },
  );

  it('treats a site host as unknown when the gateway serves no sites', async () => {
    const gw = await siteGateway({ kind: 'site', site }, false);

    const res = await get(gw.port, SITE_HOST);

    expect(res.status).toBe(404);
    expect(gw.getSite).not.toHaveBeenCalled();
  });
});

describe('the gateway pipeline: custom domains (contracts/domain-serving.md § 1)', () => {
  const SITE_DOMAIN = 'forge-site.localhost';
  const HOSTNAME = 'www.acme-example.com';
  const SECRET = 'edge-origin-secret-0123456789abcdef';
  const EDGE = { 'x-forge-edge': SECRET };
  const record: DomainRecord = {
    artifact: 'a'.repeat(64),
    deployment: '00000000-0000-4000-8000-000000000002',
    exp: NOW + 30,
    hostname: HOSTNAME,
    iat: NOW,
    kind: 'domain',
    org: '00000000-0000-4000-8000-000000000000',
    project: '00000000-0000-4000-8000-000000000001',
  };

  async function domainGateway(answer: BrokerDomainResult, withDomains = true) {
    const getRoute = vi.fn(() => Promise.resolve<BrokerRouteResult>({ kind: 'refused' }));
    const getSite = vi.fn(() => Promise.resolve<BrokerSiteResult>({ kind: 'refused' }));
    const getDomain = vi.fn((_hostname: string) => Promise.resolve(answer));
    const storeGet = vi.fn((_key: string) => Promise.reject(new Error('store down')));
    const redeemGrant = vi.fn(() => Promise.resolve<BrokerGrantResult>({ kind: 'refused' }));
    const checkGrant = vi.fn(verifyGrant);
    const pipeline = createPipeline({
      broker: { getRoute, redeemGrant },
      domain: withDomains ? { fromEdge: createEdgeOriginCheck(SECRET), getDomain } : undefined,
      previewDomain: DOMAIN,
      productOrigin: PRODUCT,
      site: {
        domain: SITE_DOMAIN,
        getSite,
        manifests: createManifestCache(),
        store: { get: storeGet },
      },
      socketMaxMs: 60_000,
      upstreamTimeoutMs: 5000,
      verifyGrant: checkGrant,
      wakeBudgetMs: 90_000,
    });
    const server = createServer((req, res) => void pipeline.onRequest(req, res));
    server.on('upgrade', (req, socket, head) => void pipeline.onUpgrade(req, socket, head));
    return {
      checkGrant,
      getDomain,
      getRoute,
      getSite,
      port: await listen(server),
      redeemGrant,
      storeGet,
    };
  }

  it('refuses a request without X-Forge-Edge with the preview refusal bytes, asking no one', async () => {
    const gw = await domainGateway({ domain: record, kind: 'domain' });

    const res = await get(gw.port, HOSTNAME);

    expect(res.status).toBe(REFUSED_PAGE.status);
    expect(res.body).toBe(REFUSED_PAGE.body);
    expect(gw.getDomain).not.toHaveBeenCalled();
    expect(gw.storeGet).not.toHaveBeenCalled();
  });

  it.each([
    ['a wrong secret', `${SECRET.slice(0, -1)}x`],
    ['a secret of another length', 'short'],
    ['an empty header', ''],
  ])('refuses %s with the refusal bytes, asking no one', async (_name, value) => {
    const gw = await domainGateway({ domain: record, kind: 'domain' });

    const res = await get(gw.port, HOSTNAME, '/', undefined, {
      headers: { 'x-forge-edge': value },
    });

    expect(res.status).toBe(404);
    expect(res.body).toBe(REFUSED_PAGE.body);
    expect(gw.getDomain).not.toHaveBeenCalled();
  });

  it('refuses an Upgrade request, even from the edge, asking no one', async () => {
    const gw = await domainGateway({ domain: record, kind: 'domain' });

    expect(await upgrade(gw.port, HOSTNAME, '/', `X-Forge-Edge: ${SECRET}\r\n`)).toBe(
      'HTTP/1.1 404 Not Found',
    );
    expect(await upgrade(gw.port, HOSTNAME)).toBe('HTTP/1.1 404 Not Found');
    expect(gw.getDomain).not.toHaveBeenCalled();
  });

  it('answers a method other than GET or HEAD with 405, as a site does', async () => {
    const gw = await domainGateway({ domain: record, kind: 'domain' });

    const res = await get(gw.port, HOSTNAME, '/', undefined, { headers: EDGE, method: 'POST' });

    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('GET, HEAD');
    expect(gw.storeGet).not.toHaveBeenCalled();
  });

  it('answers a broker refusal with the uniform site 404 page', async () => {
    const gw = await domainGateway({ kind: 'refused' });

    const res = await get(gw.port, `${HOSTNAME}:3200`, '/', undefined, { headers: EDGE });

    expect(gw.getDomain).toHaveBeenCalledWith(HOSTNAME);
    expect(res.status).toBe(404);
    expect(res.body).toBe(REFUSED_PAGE.body);
    expect(gw.storeGet).not.toHaveBeenCalled();
  });

  it('answers an unreachable broker with the broker-unavailable page and Retry-After: 2', async () => {
    const gw = await domainGateway({ kind: 'retryable', reason: 'down' });

    const res = await get(gw.port, HOSTNAME, '/', undefined, { headers: EDGE });

    expect(res.status).toBe(503);
    expect(res.body).toBe(BROKER_UNAVAILABLE_PAGE.body);
    expect(res.headers['retry-after']).toBe('2');
  });

  it("serves a verified record's release through serveSite, never the preview path", async () => {
    const gw = await domainGateway({ domain: record, kind: 'domain' });

    const res = await get(
      gw.port,
      HOSTNAME.toUpperCase(),
      '/?code=grant-code',
      `__Host-preview_grant=${GOOD}; __Host-session=product`,
      { headers: EDGE },
    );

    expect(gw.getDomain).toHaveBeenCalledExactlyOnceWith(HOSTNAME);
    expect(gw.storeGet).toHaveBeenCalledWith(
      `${record.org}/${record.project}/${record.artifact}/manifest.json`,
    );
    // The fake store is down: the site path answered.
    expect(res.status).toBe(503);
    expect(res.body).toBe(SITE_UNAVAILABLE_PAGE.body);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers.location).toBeUndefined();
    expect(gw.getRoute).not.toHaveBeenCalled();
    expect(gw.getSite).not.toHaveBeenCalled();
    expect(gw.checkGrant).not.toHaveBeenCalled();
    expect(gw.redeemGrant).not.toHaveBeenCalled();
    expect(JSON.stringify(res.headers)).not.toContain(SECRET);
  });

  it('keeps preview and site precedence with the edge header present', async () => {
    const gw = await domainGateway({ domain: record, kind: 'domain' });

    await get(gw.port, `my-site.${SITE_DOMAIN}`, '/', undefined, { headers: EDGE });
    await get(gw.port, HOST, '/', undefined, { headers: EDGE });

    expect(gw.getSite).toHaveBeenCalledWith('my-site');
    expect(gw.getRoute).toHaveBeenCalledWith(LABEL, { grant: undefined, host: HOST });
    expect(gw.getDomain).not.toHaveBeenCalled();
  });

  it('treats another host as unknown when custom domains are not configured', async () => {
    const gw = await domainGateway({ domain: record, kind: 'domain' }, false);

    const res = await get(gw.port, HOSTNAME, '/', undefined, { headers: EDGE });

    expect(res.status).toBe(404);
    expect(res.body).toBe(REFUSED_PAGE.body);
    expect(gw.getDomain).not.toHaveBeenCalled();
  });

  it('refuses a malformed host with the refusal bytes, asking no one', async () => {
    const gw = await domainGateway({ domain: record, kind: 'domain' });

    const res = await get(gw.port, '127.0.0.1', '/', undefined, { headers: EDGE });

    expect(res.status).toBe(404);
    expect(res.body).toBe(REFUSED_PAGE.body);
    expect(gw.getDomain).not.toHaveBeenCalled();
  });
});
