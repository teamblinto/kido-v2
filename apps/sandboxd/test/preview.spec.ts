import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { createServer as netServer, type AddressInfo, type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Config } from '../src/config.ts';
import { router } from '../src/http.ts';
import {
  createPreviewServer,
  mintPreviewToken,
  registerPreviewRoutes,
  verifyPreviewToken,
} from '../src/preview.ts';
import { Store } from '../src/store.ts';
import { FakeDocker } from './fake-docker.ts';

const secret = Buffer.alloc(32, 7);
const now = 1_000_000;

describe('token', () => {
  it('round-trips', () => {
    const t = mintPreviewToken(secret, 'sa', 3000, now + 60);
    expect(verifyPreviewToken(secret, t, now)).toEqual({ sandboxId: 'sa', port: 3000 });
  });
  it('rejects tampered, expired, malformed, wrong secret', () => {
    const t = mintPreviewToken(secret, 'sa', 3000, now + 60);
    const [p, s] = t.split('.') as [string, string];
    const other = Buffer.from(JSON.stringify({ s: 'sb', p: 3000, e: now + 60 })).toString(
      'base64url',
    );
    expect(verifyPreviewToken(secret, `${other}.${s}`, now)).toBeNull();
    expect(verifyPreviewToken(secret, `${p}.${s.slice(0, -2)}AA`, now)).toBeNull();
    expect(verifyPreviewToken(secret, t, now + 61)).toBeNull();
    expect(verifyPreviewToken(secret, 'garbage', now)).toBeNull();
    expect(verifyPreviewToken(secret, '', now)).toBeNull();
    expect(verifyPreviewToken(Buffer.alloc(32, 8), t, now)).toBeNull();
  });
});

let dir: string;
let store: Store;
let docker: FakeDocker;
let api: Server;
let preview: Server;
let upstream: Server;
let upPort: number;
let apiBase: string;
let previewPort: number;
const cfg = { apiKey: 'key', previewSecret: secret, previewPublicUrl: 'http://pv.test' } as Config;
const upSeen: { url?: string; headers?: Record<string, unknown> }[] = [];
let wsHits = 0;
const tok = (id: string, port = upPort) =>
  mintPreviewToken(secret, id, port, Math.floor(Date.now() / 1000) + 600);
const listen = (s: Server | NetServer) =>
  new Promise<number>((ok) =>
    s.listen(0, '127.0.0.1', () => {
      ok((s.address() as AddressInfo).port);
    }),
  );

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sbxd-'));
  store = new Store(dir);
  docker = new FakeDocker();
  docker.containers.set('cA', { spec: {} as never, status: 'running' });
  docker.containers.set('cB', { spec: {} as never, status: 'exited' });
  const orig = docker.inspect.bind(docker);
  // cA is "reachable" on loopback; any other container gets a dead address.
  docker.inspect = async (cid: string) => {
    const r = await orig(cid);
    return r && { ...r, ip: cid === 'cA' ? '127.0.0.1' : '203.0.113.1' };
  };
  const row = {
    image: 'i',
    class: 'project',
    labels: {},
    networkAllow: null,
    networkBlockAll: false,
    createdAt: 'x',
    queuedAt: null,
  } as const;
  store.insert({ ...row, id: 'sA', containerId: 'cA', desired: 'started' });
  store.insert({ ...row, id: 'sB', containerId: 'cB', desired: 'stopped' });

  upSeen.length = 0;
  wsHits = 0;
  upstream = createServer((req, res) => {
    upSeen.push({ url: req.url, headers: req.headers });
    res.end('hello');
  });
  upstream.on('upgrade', (_req, sock: Socket) => {
    wsHits++;
    sock.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    sock.on('data', (d) => sock.write(`echo:${d.toString()}`));
  });
  upPort = await listen(upstream);

  const a = router('key');
  registerPreviewRoutes(a, { cfg, store });
  api = createServer(a.handle);
  apiBase = `http://127.0.0.1:${await listen(api)}`;
  preview = createPreviewServer({ cfg, store, docker });
  previewPort = await listen(preview);
});
afterEach(() => {
  for (const s of [api, preview, upstream]) {
    s.closeAllConnections();
    s.close();
  }
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (path: string, token?: string) =>
  fetch(`http://127.0.0.1:${previewPort}${path}`, {
    headers: token ? { 'x-daytona-preview-token': token } : {},
  });

describe('signed-preview-url route', () => {
  const url = (q = '', id = 'sA', port = '3000') =>
    `${apiBase}/sandbox/${id}/ports/${port}/signed-preview-url${q}`;
  const auth = { authorization: 'Bearer key' };
  it('returns url and a token for the sandbox/port', async () => {
    const res = await fetch(url('?expiresInSeconds=120'), { headers: auth });
    const body = (await res.json()) as { url: string; token: string };
    expect(body.url).toBe('http://pv.test');
    expect(verifyPreviewToken(secret, body.token, Math.floor(Date.now() / 1000))).toEqual({
      sandboxId: 'sA',
      port: 3000,
    });
  });
  it('validates port and expiry, auth, and sandbox', async () => {
    expect((await fetch(url('', 'sA', '0'), { headers: auth })).status).toBe(400);
    expect((await fetch(url('', 'sA', '65536'), { headers: auth })).status).toBe(400);
    expect((await fetch(url('?expiresInSeconds=59'), { headers: auth })).status).toBe(400);
    expect((await fetch(url('?expiresInSeconds=86401'), { headers: auth })).status).toBe(400);
    expect((await fetch(url())).status).toBe(401);
    expect((await fetch(url('', 'nope'), { headers: auth })).status).toBe(404);
  });
});

describe('preview proxy', () => {
  it('proxies path/query, strips token, sets host', async () => {
    const res = await fetch(`http://127.0.0.1:${previewPort}/a/b?x=1&y=2`, {
      headers: {
        'x-daytona-preview-token': tok('sA'),
        'x-forwarded-for': '9.9.9.9',
        cookie: 'c=1',
      },
    });
    expect(await res.text()).toBe('hello');
    expect(upSeen[0]?.url).toBe('/a/b?x=1&y=2');
    expect(upSeen[0]?.headers).toMatchObject({
      host: `127.0.0.1:${upPort}`,
      'x-forwarded-for': '9.9.9.9',
      cookie: 'c=1',
    });
    expect(upSeen[0]?.headers).not.toHaveProperty('x-daytona-preview-token');
  });
  it('401 on missing/bad token', async () => {
    expect((await get('/')).status).toBe(401);
    expect((await get('/', 'x.y')).status).toBe(401);
    expect(upSeen).toHaveLength(0);
  });
  it('404 unknown, 503 not running, 502 refused', async () => {
    expect((await get('/', tok('zz'))).status).toBe(404);
    const r = await get('/', tok('sB'));
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ message: 'sandbox not running' });
    const dead = netServer();
    const p = await listen(dead);
    dead.close();
    expect((await get('/', tok('sA', p))).status).toBe(502);
  });
  it('routes by token sandbox: B token never reaches A', async () => {
    await get('/', tok('sB'));
    expect(upSeen).toHaveLength(0);
  });

  const upgrade = (token?: string) =>
    new Promise<{ sock?: Socket; closed: boolean }>((ok) => {
      const req = request({
        port: previewPort,
        host: '127.0.0.1',
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          ...(token ? { 'x-daytona-preview-token': token } : {}),
        },
      });
      req.on('upgrade', (_r, sock) => {
        ok({ sock, closed: false });
      });
      req.on('error', () => {
        ok({ closed: true });
      });
      req.on('response', () => {
        ok({ closed: true });
      });
      req.end();
    });
  it('pipes websocket frames both ways', async () => {
    const { sock } = await upgrade(tok('sA'));
    const got = await new Promise<string>((ok) => {
      sock!.once('data', (d) => {
        ok(d.toString());
      });
      sock!.write('ping');
    });
    expect(got).toBe('echo:ping');
    sock!.destroy();
  });
  it('bad token on upgrade closes socket without contacting upstream', async () => {
    expect((await upgrade('x.y')).closed).toBe(true);
    expect((await upgrade()).closed).toBe(true);
    expect(wsHits).toBe(0);
  });
});
