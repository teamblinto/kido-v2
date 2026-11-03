import { createHash } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createBrokerClient } from '../src/broker-client.ts';
import { createGrantVerifier } from '../src/grant-check.ts';
import { REFUSED_PAGE, WAKING_PAGE } from '../src/pages.ts';
import { createPipeline } from '../src/pipeline.ts';
import { RouteCache } from '../src/route-cache.ts';
import { createRouteVerifier, type RouteRecord } from '../src/route-verify.ts';

/**
 * End to end over real sockets: a `node:http` upstream (plain responses + a WebSocket echo on its
 * own `upgrade` event), a stub broker speaking contracts/preview.md § 3 behind `x-broker-secret`,
 * and the gateway wired exactly as `main.ts` wires it — the real broker client, cache and
 * verifier — against public routes signed with a throwaway Ed25519 key.
 */

const DOMAIN = 'forge-preview.localhost';
const SECRET = 'e2e-broker-secret';
const PUBLIC_LABEL = '0123456789abcdef0123';
const UNROUTABLE_LABEL = 'fedcba9876543210fedc';
const UNKNOWN_LABEL = 'aaaaaaaaaaaaaaaaaaaa';
const WAKING_LABEL = 'bbbbbbbbbbbbbbbbbbbb';
const ROTATED_LABEL = 'cccccccccccccccccccc';
const PRIVATE_LABEL = 'dddddddddddddddddddd';
const PRODUCT_ORIGIN = 'https://app.example.test';
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const servers: Server[] = [];
const dialled = vi.fn();
/** Every `GET /broker/routes/:label` the stub broker answered, by label. */
const brokered = vi.fn();
/**
 * What the stub broker knows; an unroutable state is a 404 {} like an unknown label (§ 3), and
 * `waking` is the `202` that means "resume enqueued, come back".
 */
const known = new Map([
  [PUBLIC_LABEL, 'routable'],
  [UNROUTABLE_LABEL, 'unroutable'],
  [WAKING_LABEL, 'waking'],
  [ROTATED_LABEL, 'routable'],
  [PRIVATE_LABEL, 'routable'],
]);

let gatewayPort: number;
let upstreamPort: number;
let mint: (route: RouteRecord) => Promise<string>;
let mintGrant: (host: string) => Promise<string>;
let cache: RouteCache;

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function publicRoute(label: string): RouteRecord {
  const now = Math.floor(Date.now() / 1000);
  return {
    exp: now + 30,
    iat: now,
    label,
    org: '00000000-0000-4000-8000-000000000000',
    ports: [5173],
    project: '00000000-0000-4000-8000-000000000001',
    sandbox: 'sb',
    state: 'active',
    upstream: `http://127.0.0.1:${String(upstreamPort)}`,
    upstreamToken: 'tok-e2e',
    visibility: label === PRIVATE_LABEL ? 'private' : 'public',
  };
}

/** The fixture sandbox: echoes what it saw, sets cookies on demand, speaks WebSocket on `/ws`. */
function createUpstream(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    dialled(req.url);
    req.resume();
    if (req.url === '/cookie-domain') {
      res.writeHead(200, { 'set-cookie': 'wide=1; Domain=forge-preview.localhost; Path=/' });
      res.end('leaked');
      return;
    }
    res.writeHead(201, {
      connection: 'close, x-custom-hop',
      'content-type': 'text/plain',
      'keep-alive': 'timeout=5',
      'x-custom-hop': '1',
      'x-daytona-preview-token': 'must-not-echo',
      'x-forge-upstream': 'forged',
      'x-seen-host': String(req.headers.host),
      'x-seen-token': String(req.headers['x-daytona-preview-token']),
    });
    res.end(`upstream saw ${req.method ?? ''} ${req.url ?? ''}`);
  });
  server.on('upgrade', (req, socket, head) => {
    dialled(req.url);
    const accept = createHash('sha1')
      .update(`${String(req.headers['sec-websocket-key'])}${WS_MAGIC}`)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    if (head.length) {
      socket.write(head);
    }
    socket.pipe(socket);
  });
  return server;
}

/**
 * The stub broker: `GET /broker/routes/:label` → 200 { route } | 202 {} | 404 {}, and
 * `POST /broker/grants` → 200 { grant } for any code; secret required on both.
 */
function createBroker(): Server {
  return createServer((req, res) => {
    if (req.headers['x-broker-secret'] !== SECRET) {
      req.resume();
      res.writeHead(401).end('{}');
      return;
    }
    if (req.method === 'POST' && req.url === '/broker/grants') {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        raw += chunk;
      });
      req.on('end', () => {
        const { host } = JSON.parse(raw) as { host: string };
        void mintGrant(host).then((grant) => {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ grant }));
        });
      });
      return;
    }
    req.resume();
    const label = /^\/broker\/routes\/([0-9a-f]+)$/.exec(req.url ?? '')?.[1];
    brokered(label);
    if (known.get(label ?? '') === 'waking') {
      // Held for a tick so concurrent misses arrive while this one is still in flight.
      setTimeout(() => res.writeHead(202, { 'content-type': 'application/json' }).end('{}'), 50);
      return;
    }
    if (label === undefined || known.get(label) !== 'routable') {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    void mint(publicRoute(label)).then((route) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ route }));
    });
  });
}

function get(host: string, path = '/', cookie?: string) {
  return new Promise<{ body: string; headers: IncomingMessage['headers']; status: number }>(
    (resolve, reject) => {
      const req = request(
        {
          headers: { connection: 'close', host, ...(cookie === undefined ? {} : { cookie }) },
          host: '127.0.0.1',
          path,
          port: gatewayPort,
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

function upgrade(host: string) {
  return new Promise<
    { kind: 'upgrade'; res: IncomingMessage; socket: Duplex } | { kind: 'response'; status: number }
  >((resolve, reject) => {
    const req = request({
      headers: {
        Connection: 'Upgrade',
        Host: host,
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
        Upgrade: 'websocket',
      },
      host: '127.0.0.1',
      path: '/ws',
      port: gatewayPort,
    });
    req.on('upgrade', (res, socket) => resolve({ kind: 'upgrade', res, socket }));
    req.on('response', (res) => {
      res.resume();
      resolve({ kind: 'response', status: res.statusCode ?? 0 });
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'e2e' }] };
  mint = (route) =>
    new SignJWT(route).setProtectedHeader({ alg: 'EdDSA', kid: 'e2e' }).sign(pair.privateKey);
  mintGrant = (host) =>
    new SignJWT({ sub: 'user-e2e' })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'e2e' })
      .setAudience(host)
      .setExpirationTime('5m')
      .sign(pair.privateKey);

  upstreamPort = await listen(createUpstream());
  const brokerPort = await listen(createBroker());

  cache = new RouteCache({ max: 100, ttlMs: 5000 });
  const broker = createBrokerClient({
    cache,
    origin: `http://127.0.0.1:${String(brokerPort)}`,
    sharedSecret: SECRET,
    transport: 'plain',
    verify: createRouteVerifier(jwks),
  });
  const pipeline = createPipeline({
    broker,
    previewDomain: DOMAIN,
    productOrigin: PRODUCT_ORIGIN,
    socketMaxMs: 60_000,
    upstreamTimeoutMs: 5000,
    verifyGrant: createGrantVerifier(jwks),
    wakeBudgetMs: 90_000,
  });
  const gateway = createServer((req, res) => void pipeline.onRequest(req, res));
  gateway.on('upgrade', (req, socket, head) => void pipeline.onUpgrade(req, socket, head));
  gatewayPort = await listen(gateway);
});

afterAll(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

describe('preview proxy end to end', () => {
  it('relays the upstream response intact with its status and body', async () => {
    const reply = await get(`${PUBLIC_LABEL}-5173.${DOMAIN}`, '/hello');

    expect(reply.status).toBe(201);
    expect(reply.body).toBe('upstream saw GET /hello');
    expect(reply.headers['x-seen-host']).toBe(`127.0.0.1:${String(upstreamPort)}`);
    expect(reply.headers['x-seen-token']).toBe('tok-e2e');
    expect(reply.headers['x-robots-tag']).toBe('noindex');
  });

  it('returns a warm first byte within the SC-001 budget of 1.5 s', async () => {
    await get(`${PUBLIC_LABEL}-5173.${DOMAIN}`); // warms the route cache
    const started = performance.now();
    await new Promise<void>((resolve, reject) => {
      const req = request(
        {
          headers: { connection: 'close', host: `${PUBLIC_LABEL}-5173.${DOMAIN}` },
          host: '127.0.0.1',
          path: '/',
          port: gatewayPort,
        },
        (res) => {
          res.once('data', () => {
            expect(performance.now() - started).toBeLessThan(1500);
            expect(res.statusCode).toBe(201);
            res.resume();
            resolve();
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  });

  it('completes a WebSocket upgrade and echoes through the piped socket', async () => {
    const result = await upgrade(`${PUBLIC_LABEL}-5173.${DOMAIN}`);

    expect(result.kind).toBe('upgrade');
    if (result.kind !== 'upgrade') {
      return;
    }
    expect(result.res.statusCode).toBe(101);
    const echoed = new Promise<string>((resolve) =>
      result.socket.once('data', (chunk: Buffer) => resolve(chunk.toString())),
    );
    result.socket.write('ping');
    expect(await echoed).toBe('ping');
    result.socket.destroy();
  });

  it('strips hop-by-hop and X-Forge-* headers and never echoes the provider token', async () => {
    const reply = await get(`${PUBLIC_LABEL}-5173.${DOMAIN}`);

    expect(reply.headers['keep-alive']).toBeUndefined();
    expect(reply.headers['x-custom-hop']).toBeUndefined();
    expect(reply.headers['x-forge-upstream']).toBeUndefined();
    expect(reply.headers['x-daytona-preview-token']).toBeUndefined();
    expect(reply.headers['content-type']).toBe('text/plain');
  });

  it('answers 502 when the upstream Set-Cookie carries Domain', async () => {
    const reply = await get(`${PUBLIC_LABEL}-5173.${DOMAIN}`, '/cookie-domain');

    expect(reply.status).toBe(502);
    expect(reply.headers['set-cookie']).toBeUndefined();
    expect(reply.body).not.toContain('leaked');
  });

  it('refuses an undeclared port with no connection opened to the upstream', async () => {
    dialled.mockClear();

    const reply = await get(`${PUBLIC_LABEL}-8080.${DOMAIN}`, '/undeclared');

    expect(reply.status).toBe(404);
    expect(reply.body).toBe(REFUSED_PAGE.body);
    expect(dialled).not.toHaveBeenCalled();
  });

  it('gives an unknown label and an unroutable state the same 404 body', async () => {
    const unknown = await get(`${UNKNOWN_LABEL}-5173.${DOMAIN}`);
    const unroutableReply = await get(`${UNROUTABLE_LABEL}-5173.${DOMAIN}`);

    expect(unknown.status).toBe(404);
    expect(unroutableReply.status).toBe(404);
    expect(unknown.body).toBe(REFUSED_PAGE.body);
    expect(unroutableReply.body).toBe(unknown.body);
    expect(unroutableReply.headers['content-length']).toBe(unknown.headers['content-length']);
  });

  it('marks a public preview response noindex', async () => {
    const reply = await get(`${PUBLIC_LABEL}-5173.${DOMAIN}`);

    expect(reply.status).toBe(201);
    expect(reply.headers['x-robots-tag']).toBe('noindex');
  });

  it('shows the waking page on 202, wakes once for concurrent requests, then proxies', async () => {
    brokered.mockClear();
    dialled.mockClear();
    const host = `${WAKING_LABEL}-5173.${DOMAIN}`;

    const replies = await Promise.all([get(host), get(host), get(host)]);

    for (const reply of replies) {
      expect(reply.status).toBe(WAKING_PAGE.status);
      expect(reply.body).toBe(WAKING_PAGE.body);
      expect(reply.headers['retry-after']).toBe('2');
    }
    expect(brokered).toHaveBeenCalledTimes(1);
    expect(dialled).not.toHaveBeenCalled();

    known.set(WAKING_LABEL, 'routable');
    const ready = await get(host, '/woken');

    expect(ready.status).toBe(201);
    expect(ready.body).toBe('upstream saw GET /woken');
    expect(brokered).toHaveBeenCalledTimes(2);
  });

  it('drains a socket open on the old label at rotation instead of tearing it down', async () => {
    const host = `${ROTATED_LABEL}-5173.${DOMAIN}`;
    const opened = await upgrade(host);
    expect(opened.kind).toBe('upgrade');
    if (opened.kind !== 'upgrade') {
      return;
    }

    // The rotation: the broker stops resolving the old label and the gateway's cache drops it.
    known.set(ROTATED_LABEL, 'unroutable');
    cache.delete(ROTATED_LABEL);

    for (const frame of ['still', 'open']) {
      const echoed = new Promise<string>((resolve) =>
        opened.socket.once('data', (chunk: Buffer) => resolve(chunk.toString())),
      );
      opened.socket.write(frame);
      expect(await echoed).toBe(frame);
    }

    const fresh = await upgrade(host);
    expect(fresh).toEqual({ kind: 'response', status: 404 });
    expect(opened.socket.destroyed).toBe(false);
    opened.socket.destroy();
  });

  it('sends a non-public preview without a grant to the product origin without dialling', async () => {
    dialled.mockClear();
    const host = `${PRIVATE_LABEL}-5173.${DOMAIN}`;

    const reply = await get(host, '/secret');

    expect(reply.status).toBe(302);
    expect(reply.headers.location).toBe(
      `${PRODUCT_ORIGIN}/preview-authorize?label=${PRIVATE_LABEL}&return=${host}`,
    );
    expect(reply.headers['set-cookie']).toBeUndefined();
    expect(dialled).not.toHaveBeenCalled();
  });

  it('turns a ?code= return into a host-only grant cookie and redirects without the code', async () => {
    const host = `${PRIVATE_LABEL}-5173.${DOMAIN}`;

    const reply = await get(host, '/secret?code=one-time&keep=1');

    expect(reply.status).toBe(302);
    expect(reply.headers.location).toBe('/secret?keep=1');
    const [setCookie] = reply.headers['set-cookie'] ?? [];
    expect(setCookie).toMatch(
      /^__Host-preview_grant=[^;]+; Max-Age=\d+; Path=\/; Secure; HttpOnly; SameSite=Lax$/,
    );
    expect(setCookie).not.toMatch(/domain/i);

    const cookie = setCookie?.split(';')[0] ?? '';
    const served = await get(host, '/secret', cookie);
    expect(served.status).toBe(201);
    expect(served.headers['x-robots-tag']).toBeUndefined();
  });
});
