import { createHash } from 'node:crypto';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import type { RouteRecord } from './route-verify.ts';
import { proxyUpgrade } from './upgrade.ts';

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** A WebSocket echo on node:http's own `upgrade` event: handshake, greet, then echo raw bytes. */
function createEcho(extraHeaders = ''): Server {
  const server = createServer((_req, res) => {
    res.writeHead(200).end('plain');
  });
  server.on('upgrade', (req, socket, head) => {
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}${WS_MAGIC}`)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        `X-Seen-Host: ${req.headers.host}\r\n` +
        `X-Seen-Forge: ${String(req.headers['x-forge-user'] ?? 'absent')}\r\n` +
        `X-Seen-Token: ${String(req.headers['x-daytona-preview-token'])}\r\n` +
        `X-Seen-Proto: ${String(req.headers['x-forwarded-proto'])}\r\n` +
        `X-Forge-Upstream: forged\r\nX-Daytona-Preview-Token: leak\r\n${extraHeaders}\r\n`,
    );
    socket.write(`hello from upstream${head.length ? `:${head.toString()}` : ''}`);
    socket.pipe(socket);
  });
  return server;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function route(upstreamPort: number): RouteRecord {
  const now = Math.floor(Date.now() / 1000);
  return {
    exp: now + 30,
    iat: now,
    label: '0123456789abcdef0123',
    org: '00000000-0000-4000-8000-000000000000',
    ports: [5173],
    project: '00000000-0000-4000-8000-000000000001',
    sandbox: 'sb',
    state: 'active',
    upstream: `http://127.0.0.1:${upstreamPort}`,
    upstreamToken: 'tok-123',
    visibility: 'public',
  };
}

interface Upgraded {
  res: IncomingMessage;
  socket: Duplex;
  head: Buffer;
}

function connect(gatewayPort: number): Promise<Upgraded> {
  return new Promise((resolve, reject) => {
    const req = request({
      headers: {
        Connection: 'Upgrade',
        Host: '0123456789abcdef0123-5173.forge-preview.localhost',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
        Upgrade: 'websocket',
        'X-Forge-User': 'spoofed',
      },
      host: '127.0.0.1',
      path: '/ws',
      port: gatewayPort,
    });
    req.on('upgrade', (res, socket, head) => resolve({ res, socket, head }));
    req.on('response', (res) => {
      res.resume();
      reject(new Error(`no upgrade: ${res.statusCode}`));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Resolves once the bytes received after the call contain `needle`. */
function waitFor(socket: Duplex, needle: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let seen = '';
    const onData = (chunk: Buffer) => {
      seen += chunk.toString();
      if (seen.includes(needle)) {
        socket.off('data', onData);
        resolve(seen);
      }
    };
    socket.on('data', onData);
    socket.once('close', () => reject(new Error(`closed before ${JSON.stringify(needle)}`)));
  });
}

function closed(socket: Duplex): Promise<void> {
  return new Promise((resolve) => socket.once('close', () => resolve()));
}

describe('proxyUpgrade', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  async function setup(socketMaxMs = 60_000, extraHeaders = '', dialOrigin?: string) {
    const echo = createEcho(extraHeaders);
    const upstreamPort = await listen(echo);
    const current = route(upstreamPort);
    if (dialOrigin) {
      current.upstream = 'http://5173-tok.proxy.localhost:4000';
      dialOrigin = `http://127.0.0.1:${upstreamPort}`;
    }
    const gateway = createServer((_req, res) => {
      res.writeHead(404).end();
    });
    gateway.on('upgrade', (req, socket, head) => {
      proxyUpgrade(req, socket, head, current, { dialOrigin, socketMaxMs });
    });
    const gatewayPort = await listen(gateway);
    servers.push(echo, gateway);
    return { current, gatewayPort, upstreamPort };
  }

  it('proxies the Upgrade and relays messages both ways for the connection life', async () => {
    const { gatewayPort, upstreamPort } = await setup();
    const { res, socket, head } = await connect(gatewayPort);

    expect(res.statusCode).toBe(101);
    expect(res.headers.upgrade).toBe('websocket');
    expect(res.headers['sec-websocket-accept']).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    // The dial carried the upstream's own Host and the provider token, and dropped the spoofed
    // X-Forge-* header (contract § 5).
    expect(res.headers['x-seen-host']).toBe(`127.0.0.1:${upstreamPort}`);
    expect(res.headers['x-seen-token']).toBe('tok-123');
    expect(res.headers['x-seen-forge']).toBe('absent');
    expect(res.headers['x-seen-proto']).toBe('http');
    // The 101 is sanitised like any response: no X-Forge-*, no provider token echoed back.
    expect(res.headers['x-forge-upstream']).toBeUndefined();
    expect(res.headers['x-daytona-preview-token']).toBeUndefined();

    // Upstream → client: the greeting pushed right after the handshake (may ride in `head`).
    const greeting = head.includes('hello from upstream')
      ? head.toString()
      : await waitFor(socket, 'hello from upstream');
    expect(greeting).toContain('hello from upstream');

    // Client → upstream → client, repeatedly.
    for (const frame of ['one', 'two', 'three']) {
      const echoed = waitFor(socket, frame);
      socket.write(frame);
      await expect(echoed).resolves.toContain(frame);
    }
    socket.destroy();
  });

  it('closes the piped socket at GATEWAY_SOCKET_MAX_MS', async () => {
    const { gatewayPort } = await setup(100);
    const { socket } = await connect(gatewayPort);
    const start = Date.now();
    await closed(socket);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(2_000);
  });

  it('dials dialOrigin while presenting the upstream host (R19)', async () => {
    const { gatewayPort } = await setup(60_000, '', 'set');
    const { res, socket } = await connect(gatewayPort);

    expect(res.statusCode).toBe(101);
    expect(res.headers['x-seen-host']).toBe('5173-tok.proxy.localhost:4000');
    socket.destroy();
  });

  it('refuses a 101 whose Set-Cookie carries Domain', async () => {
    const { gatewayPort } = await setup(60_000, 'Set-Cookie: w=1; Domain=forge-preview.net\r\n');

    await expect(connect(gatewayPort)).rejects.toThrow('no upgrade: 502');
  });

  it('lets an established socket drain when the route is rotated mid-connection', async () => {
    const { current, gatewayPort } = await setup();
    const { socket } = await connect(gatewayPort);

    // A rotation: the record the handshake used is invalidated and gutted. The pipe holds no
    // reference to it, so frames keep flowing.
    current.exp = 0;
    current.upstream = 'http://127.0.0.1:1';
    for (const key of Object.keys(current)) {
      delete (current as Record<string, unknown>)[key];
    }
    await sleep(20);

    const echoed = waitFor(socket, 'still-here');
    socket.write('still-here');
    await expect(echoed).resolves.toContain('still-here');
    socket.destroy();
  });

  it('answers 502 when the upstream does not upgrade', async () => {
    const plain = createServer((_req, res) => {
      res.writeHead(200).end('no upgrade here');
    });
    const upstreamPort = await listen(plain);
    const gateway = createServer();
    gateway.on('upgrade', (req, socket, head) => {
      proxyUpgrade(req, socket, head, route(upstreamPort), { socketMaxMs: 60_000 });
    });
    const gatewayPort = await listen(gateway);
    servers.push(plain, gateway);

    await expect(connect(gatewayPort)).rejects.toThrow('no upgrade: 502');
  });

  it('answers 503 when the upstream refuses the connection', async () => {
    const gateway = createServer();
    gateway.on('upgrade', (req, socket, head) => {
      proxyUpgrade(req, socket, head, route(1), { socketMaxMs: 60_000 });
    });
    const gatewayPort = await listen(gateway);
    servers.push(gateway);

    await expect(connect(gatewayPort)).rejects.toThrow('no upgrade: 503');
  });
});
