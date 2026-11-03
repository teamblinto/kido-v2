import { createServer, type IncomingMessage, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  dialTarget,
  GRANT_COOKIE,
  outboundHeaders,
  proxyRequest,
  setCookieWidensDomain,
  stripGrantCookie,
  stripHopByHop,
} from './proxy.ts';
import { NOT_SERVING_PAGE } from './pages.ts';
import type { RouteRecord } from './route-verify.ts';

interface Reply {
  body: string;
  headers: IncomingMessage['headers'];
  status: number;
}

type UpstreamHandler = Parameters<typeof createServer>[1];

const NOW_SECONDS = Math.floor(Date.now() / 1000);

let upstream: Server | undefined;
let gateway: Server | undefined;
let seen: IncomingMessage | undefined;

function port(server: Server): number {
  return (server.address() as AddressInfo).port;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function route(upstreamPort: number, overrides: Partial<RouteRecord> = {}): RouteRecord {
  return {
    exp: NOW_SECONDS + 30,
    iat: NOW_SECONDS,
    label: 'a'.repeat(20),
    org: '0f6c5f9e-3c1a-4c56-9a4e-4b8f8d3c1a11',
    ports: [5173],
    project: '6b1d1a7c-8a1b-4c3e-9e6f-2d3c4b5a6f70',
    sandbox: 'sbx_01',
    state: 'active',
    upstream: `http://127.0.0.1:${upstreamPort}`,
    upstreamToken: 'tok',
    visibility: 'private',
    ...overrides,
  };
}

/** Starts an upstream (recording the request it saw) and a gateway proxying every request to it. */
async function serve(
  handler: UpstreamHandler,
  overrides: Partial<RouteRecord> = {},
  upstreamTimeoutMs = 5000,
): Promise<number> {
  upstream = createServer((req, res) => {
    seen = req;
    handler?.(req, res);
  });
  await listen(upstream);
  const dialOrigin = `http://127.0.0.1:${port(upstream)}`;
  const record = route(port(upstream), overrides);
  gateway = createServer((req, res) => {
    void proxyRequest(req, res, record, { dialOrigin, upstreamTimeoutMs });
  });
  await listen(gateway);
  return port(gateway);
}

function get(gatewayPort: number, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        headers: { connection: 'close', ...headers },
        host: '127.0.0.1',
        method: 'GET',
        path: '/x?y=1',
        port: gatewayPort,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ body, headers: res.headers, status: res.statusCode ?? 0 }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

afterEach(async () => {
  for (const server of [gateway, upstream]) {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
    }
  }
  gateway = upstream = seen = undefined;
});

describe('dialTarget', () => {
  it('dials the scheme default port with the matching transport when none is given', () => {
    const https = dialTarget(route(0, { upstream: 'https://sb.example' }), undefined);
    const http = dialTarget(route(0, { upstream: 'http://sb.example' }), undefined);

    expect(https.port).toBe(443);
    expect(https.request).not.toBe(http.request);
    expect(http.port).toBe(80);
    expect(https.servername).toBe('sb.example');
  });
});

describe('outboundHeaders', () => {
  it('reads a repeated X-Forwarded-For, a TLS socket and a missing Host without throwing', () => {
    const req = {
      headers: { 'x-forwarded-for': ['1.1.1.1', '2.2.2.2'] },
      socket: { encrypted: true },
    } as unknown as IncomingMessage;

    const h = outboundHeaders(req, route(1));

    expect(h['x-forwarded-for']).toBe('2.2.2.2');
    expect(h['x-forwarded-proto']).toBe('https');
    expect(h['x-forwarded-host']).toBe('');
  });

  it('falls back to an empty X-Forwarded-For when the socket has no peer address', () => {
    const req = { headers: {}, socket: {} } as unknown as IncomingMessage;

    expect(outboundHeaders(req, route(1))['x-forwarded-for']).toBe('');
  });
});

describe('setCookieWidensDomain', () => {
  it('reads a single string as well as an array', () => {
    expect(setCookieWidensDomain('a=1; domain=x')).toBe(true);
    expect(setCookieWidensDomain('a=1; Path=/')).toBe(false);
    expect(setCookieWidensDomain(undefined)).toBe(false);
  });
});

describe('stripHopByHop', () => {
  it('keeps everything when there is no Connection header', () => {
    expect(stripHopByHop({ 'x-keep': '1' })).toEqual({ 'x-keep': '1' });
  });

  it('drops the fixed hop-by-hop set and every name the Connection header lists', () => {
    const out = stripHopByHop({
      connection: 'close, X-Custom-Hop',
      'content-type': 'text/plain',
      'keep-alive': 'timeout=5',
      'proxy-authenticate': 'Basic',
      'proxy-authorization': 'Basic x',
      te: 'trailers',
      trailer: 'Expires',
      'transfer-encoding': 'chunked',
      upgrade: 'websocket',
      'x-custom-hop': '1',
      'x-forge-user': 'admin',
    });
    expect(out).toEqual({ 'content-type': 'text/plain' });
  });
});

describe('stripGrantCookie', () => {
  it('removes only the grant cookie and keeps the rest', () => {
    expect(stripGrantCookie(`a=1; ${GRANT_COOKIE}=secret; b=2`)).toBe('a=1; b=2');
    expect(stripGrantCookie(`${GRANT_COOKIE}=secret`)).toBeUndefined();
    expect(stripGrantCookie('a=1')).toBe('a=1');
  });
});

describe('proxyRequest', () => {
  it('relays the upstream answer with hop-by-hop and X-Forge-* headers stripped', async () => {
    const gatewayPort = await serve((_req, res) => {
      res.writeHead(201, {
        connection: 'close, x-drop-me',
        'content-type': 'text/plain',
        'keep-alive': 'timeout=5',
        'transfer-encoding': 'chunked',
        'x-drop-me': '1',
        'x-forge-user': 'admin',
        'x-keep': 'yes',
      });
      res.end('hello');
    });

    const reply = await get(gatewayPort);

    expect(reply.status).toBe(201);
    expect(reply.body).toBe('hello');
    expect(reply.headers['x-keep']).toBe('yes');
    expect(reply.headers['content-type']).toBe('text/plain');
    for (const name of ['keep-alive', 'x-drop-me', 'x-forge-user', 'x-robots-tag']) {
      expect(reply.headers[name]).toBeUndefined();
    }
  });

  it('refuses the whole response with 502 when a Set-Cookie carries Domain', async () => {
    const gatewayPort = await serve((_req, res) => {
      res.writeHead(200, {
        'set-cookie': ['ok=1; Path=/', 'wide=1; Domain=forge-preview.net; Path=/'],
        'x-keep': 'yes',
      });
      res.end('secret body');
    });

    const reply = await get(gatewayPort);

    expect(reply.status).toBe(502);
    expect(reply.headers['set-cookie']).toBeUndefined();
    expect(reply.headers['x-keep']).toBeUndefined();
    expect(reply.body).not.toContain('secret body');
  });

  it('strips the provider auth cookie (Domain and all) and relays the rest', async () => {
    const gatewayPort = await serve((_req, res) => {
      res.writeHead(200, {
        'set-cookie': [
          'Daytona-Sandbox-Auth-abc123=tok; Path=/; Domain=5173-abc123.proxy.localhost; HttpOnly',
          'app=1; Path=/',
        ],
      });
      res.end('page');
    });

    const reply = await get(gatewayPort);

    expect(reply.status).toBe(200);
    expect(reply.body).toBe('page');
    expect(reply.headers['set-cookie']).toEqual(['app=1; Path=/']);
  });

  it('keeps an app cookie whose name merely contains the provider prefix', async () => {
    const gatewayPort = await serve((_req, res) => {
      res.writeHead(200, { 'set-cookie': 'x-daytona-sandbox-auth-y=1; Path=/' });
      res.end();
    });

    const reply = await get(gatewayPort);

    expect(reply.status).toBe(200);
    expect(reply.headers['set-cookie']).toEqual(['x-daytona-sandbox-auth-y=1; Path=/']);
  });

  it('drops a lone provider auth cookie entirely, leaving no Set-Cookie', async () => {
    const gatewayPort = await serve((_req, res) => {
      res.writeHead(200, {
        'set-cookie': 'daytona-sandbox-auth-x=tok; Domain=5173-x.proxy.localhost',
      });
      res.end();
    });

    const reply = await get(gatewayPort);

    expect(reply.status).toBe(200);
    expect(reply.headers['set-cookie']).toBeUndefined();
  });

  it('still refuses with 502 when an app cookie carries Domain beside the provider one', async () => {
    const gatewayPort = await serve((_req, res) => {
      res.writeHead(200, {
        'set-cookie': [
          'daytona-sandbox-auth-x=tok; Domain=5173-x.proxy.localhost',
          'wide=1; Domain=forge-preview.net; Path=/',
        ],
      });
      res.end('secret body');
    });

    const reply = await get(gatewayPort);

    expect(reply.status).toBe(502);
    expect(reply.headers['set-cookie']).toBeUndefined();
  });

  it('refuses with 502 when a Set-Cookie names the grant cookie', async () => {
    const gatewayPort = await serve((_req, res) => {
      res.writeHead(200, { 'set-cookie': `${GRANT_COOKIE}=forged; Path=/` });
      res.end();
    });

    const reply = await get(gatewayPort);

    expect(reply.status).toBe(502);
    expect(reply.headers['set-cookie']).toBeUndefined();
  });

  it('never echoes the provider token back to the client', async () => {
    const gatewayPort = await serve((req, res) => {
      res.writeHead(200, {
        'x-daytona-preview-token': String(req.headers['x-daytona-preview-token']),
      });
      res.end();
    });

    const reply = await get(gatewayPort);

    expect(reply.headers['x-daytona-preview-token']).toBeUndefined();
  });

  it('sends the upstream token and host, forwards from the connection, and drops the grant cookie', async () => {
    // The route's upstream host does not resolve here (R19 note): dial the recorded address.
    const gatewayPort = await serve((_req, res) => res.end(), {
      upstream: 'http://5173-tok.proxy.localhost:4000',
    });

    await get(gatewayPort, {
      connection: 'close, x-custom-hop',
      cookie: `a=1; ${GRANT_COOKIE}=grant-secret; b=2`,
      forwarded: 'for=9.9.9.9;proto=https',
      host: `${'a'.repeat(20)}-5173.forge-preview.localhost:3200`,
      'x-custom-hop': '1',
      'x-forge-user': 'admin',
    });

    const h = seen!.headers;
    expect(h.host).toBe('5173-tok.proxy.localhost:4000');
    expect(h['x-daytona-preview-token']).toBe('tok');
    expect(h.cookie).toBe('a=1; b=2');
    expect(h.cookie).not.toContain('grant-secret');
    expect(h['x-forwarded-for']).toBe('127.0.0.1');
    expect(h['x-forwarded-proto']).toBe('http');
    expect(h['x-forwarded-host']).toBe(`${'a'.repeat(20)}-5173.forge-preview.localhost:3200`);
    expect(h['x-forge-user']).toBeUndefined();
    expect(h['x-custom-hop']).toBeUndefined();
    expect(h.forwarded).toBeUndefined();
    expect(seen!.url).toBe('/x?y=1');
  });

  it('believes only the entry the one trusted edge hop appended, never appending to it', async () => {
    const gatewayPort = await serve((_req, res) => res.end());

    await get(gatewayPort, {
      'x-forwarded-for': '1.1.1.1, 203.0.113.9',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'http, https',
    });

    const h = seen!.headers;
    expect(h['x-forwarded-for']).toBe('203.0.113.9');
    expect(h['x-forwarded-proto']).toBe('https');
    expect(h['x-forwarded-host']).toBe('127.0.0.1:' + gatewayPort);
  });

  it('adds X-Robots-Tag: noindex only on public previews', async () => {
    const gatewayPort = await serve((_req, res) => res.end(), { visibility: 'public' });

    const reply = await get(gatewayPort);

    expect(reply.headers['x-robots-tag']).toBe('noindex');
  });

  it('answers 503 "nothing is serving yet" when the upstream refuses the connection', async () => {
    const gatewayPort = await serve((_req, res) => res.end());
    const closed = port(upstream!);
    await new Promise((resolve) => upstream!.close(resolve));
    upstream = undefined;
    gateway?.removeAllListeners('request');
    gateway?.on('request', (req, res) => {
      void proxyRequest(req, res, route(closed), { upstreamTimeoutMs: 5000 });
    });

    const reply = await get(gatewayPort);

    expect(reply.status).toBe(503);
    expect(reply.body).toBe(NOT_SERVING_PAGE.body);
  });

  it('answers 502 when the upstream drops the connection before answering', async () => {
    const gatewayPort = await serve((req) => req.socket.destroy());

    const reply = await get(gatewayPort);

    expect(reply.status).toBe(502);
  });

  it('bounds the upstream by GATEWAY_UPSTREAM_TIMEOUT_MS', async () => {
    const gatewayPort = await serve(
      () => {
        /* never answers */
      },
      {},
      50,
    );

    const reply = await get(gatewayPort);

    expect(reply.status).toBe(504);
  });

  it('cuts a body that stalls mid-stream at the same inactivity bound', async () => {
    const gatewayPort = await serve(
      (_req, res) => {
        res.writeHead(200);
        res.write('partial');
        // never ends
      },
      {},
      50,
    );

    await expect(get(gatewayPort)).rejects.toThrow();
  });
});
