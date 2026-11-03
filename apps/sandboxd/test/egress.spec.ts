import { mkdtempSync } from 'node:fs';
import { createServer as httpServer, request, type Server } from 'node:http';
import { connect, createServer, type AddressInfo, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Config } from '../src/config.ts';
import { isPrivateAddress, matchesEntry, startEgressProxy } from '../src/egress.ts';
import { createIpMap } from '../src/ip-map.ts';
import { Store, type SandboxRow } from '../src/store.ts';
import { FakeDocker } from './fake-docker.ts';

describe('isPrivateAddress', () => {
  it.each([
    ['0.1.2.3', true],
    ['10.0.0.5', true],
    ['100.64.0.1', true],
    ['100.127.255.255', true],
    ['100.128.0.1', false],
    ['127.0.0.1', true],
    ['169.254.169.254', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['192.168.1.1', true],
    ['224.0.0.1', true],
    ['240.0.0.1', true],
    ['255.255.255.255', true],
    ['8.8.8.8', false],
    ['1.2.3.4', false],
    ['::1', true],
    ['::', true],
    ['fc00::1', true],
    ['fdff::1', true],
    ['fe80::1', true],
    ['febf::1', true],
    ['fec0::1', false],
    ['::ffff:10.0.0.1', true],
    ['::ffff:7f00:1', true],
    ['::ffff:8.8.8.8', false],
    ['2606:4700::1111', false],
    ['not-an-ip', true],
  ])('%s -> %s', (ip, want) => {
    expect(isPrivateAddress(ip)).toBe(want);
  });
});

describe('matchesEntry', () => {
  it('names', () => {
    expect(matchesEntry('api.anthropic.com', 'API.Anthropic.com.')).toBe(true);
    expect(matchesEntry('x.api.anthropic.com', 'api.anthropic.com')).toBe(false);
    expect(matchesEntry('x.anthropic.com', '.anthropic.com')).toBe(true);
    expect(matchesEntry('anthropic.com', '.anthropic.com')).toBe(false);
    expect(matchesEntry('evilanthropic.com', '.anthropic.com')).toBe(false);
  });
});

const row = (o: Partial<SandboxRow> = {}): SandboxRow => ({
  id: 's1',
  containerId: 'c1',
  image: 'i',
  class: 'agent',
  labels: {},
  desired: 'started',
  networkAllow: null,
  networkBlockAll: false,
  createdAt: 'x',
  queuedAt: null,
  ...o,
});
const cfg = {
  apiHost: 'api.baios.test',
  egressAgentDefault: ['api.anthropic.com', '.claude.com'],
} as Config;

const listen = (s: Server | NetServer) =>
  new Promise<number>((ok) =>
    s.listen(0, '127.0.0.1', () => {
      ok((s.address() as AddressInfo).port);
    }),
  );

let target: NetServer;
let targetPort: number;
let proxy: Server;
let proxyPort: number;
let current: SandboxRow | undefined;
let dns: Record<string, string[]>;
let dialed: { ip: string; port: number }[];

beforeEach(async () => {
  current = row();
  dns = {
    'api.anthropic.com': ['203.0.113.7'],
    'api.baios.test': ['10.0.0.9'],
    'evil.claude.com': ['10.0.0.5'],
    'meta.claude.com': ['169.254.169.254'],
    'cidr.example.com': ['1.2.3.4'],
  };
  dialed = [];
  target = createServer((s) => {
    s.on('data', (d) => s.write(`echo:${d.toString()}`));
  });
  targetPort = await listen(target);
  proxy = startEgressProxy(cfg, {
    sandboxForIp: (ip) => (ip === '127.0.0.1' ? current : undefined),
    resolve: (h) => (dns[h] ? Promise.resolve(dns[h]) : Promise.reject(new Error('nx'))),
    // Redirect every upstream dial to the local echo server.
    dial: (ip, port) => {
      dialed.push({ ip, port });
      return connect(targetPort, '127.0.0.1');
    },
  });
  proxyPort = await listen(proxy);
});
afterEach(() => {
  proxy.close();
  proxy.closeAllConnections();
  target.close();
});

/** Send CONNECT; resolves with the status and, when 200, the echo of `ping`. */
const doConnect = (hostPort: string) =>
  new Promise<{ status: number; echo: string }>((ok) => {
    const s = connect(proxyPort, '127.0.0.1');
    let buf = '';
    let sent = false;
    s.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n\r\n`);
    s.on('data', (d) => {
      buf += d.toString();
      const status = Number(buf.slice(9, 12));
      if (status === 200 && !sent) {
        sent = true;
        s.write('ping');
      }
      if (buf.includes('echo:ping') || (status !== 200 && buf.includes('\r\n\r\n'))) {
        s.destroy();
        ok({ status, echo: buf.includes('echo:') ? buf.slice(buf.indexOf('echo:')) : '' });
      }
    });
  });

describe('CONNECT', () => {
  it('tunnels an allowed host and dials the resolved ip', async () => {
    const r = await doConnect('api.anthropic.com:443');
    expect(r).toEqual({ status: 200, echo: 'echo:ping' });
    expect(dialed).toEqual([{ ip: '203.0.113.7', port: 443 }]);
  });
  it('matches suffix entries case-insensitively', async () => {
    dns['a.claude.com'] = ['203.0.113.8'];
    expect((await doConnect('A.Claude.com.:443')).status).toBe(200);
  });
  it('refuses unlisted host, port 22, private and metadata resolutions', async () => {
    dns['other.example.com'] = ['203.0.113.9'];
    expect((await doConnect('other.example.com:443')).status).toBe(403);
    expect((await doConnect('api.anthropic.com:22')).status).toBe(403);
    expect((await doConnect('evil.claude.com:443')).status).toBe(403);
    expect((await doConnect('meta.claude.com:443')).status).toBe(403);
    expect(dialed).toEqual([]);
  });
  it('refuses apex for a suffix-only entry', async () => {
    dns['claude.com'] = ['203.0.113.9'];
    expect((await doConnect('claude.com:443')).status).toBe(403);
  });
  it('allows apiHost even when it resolves to a private address', async () => {
    expect((await doConnect('api.baios.test:443')).status).toBe(200);
  });
  it('keeps apiHost allowed when networkAllow replaces the default', async () => {
    current = row({ networkAllow: ['only.example.com'] });
    expect((await doConnect('api.baios.test:443')).status).toBe(200);
    expect((await doConnect('api.anthropic.com:443')).status).toBe(403);
  });
  it('CIDR entry allows a host resolving inside it', async () => {
    current = row({ networkAllow: ['1.2.3.0/24'] });
    expect((await doConnect('cidr.example.com:443')).status).toBe(200);
    dns['out.example.com'] = ['1.2.4.4'];
    expect((await doConnect('out.example.com:443')).status).toBe(403);
  });
  it('networkBlockAll refuses everything, even apiHost', async () => {
    current = row({ networkBlockAll: true });
    expect((await doConnect('api.anthropic.com:443')).status).toBe(403);
    expect((await doConnect('api.baios.test:443')).status).toBe(403);
  });
  it('refuses unknown source and non-agent classes', async () => {
    current = undefined;
    expect((await doConnect('api.anthropic.com:443')).status).toBe(403);
    current = row({ class: 'project' });
    expect((await doConnect('api.anthropic.com:443')).status).toBe(403);
  });
  it('502 when DNS fails', async () => {
    current = row({ networkAllow: ['gone.example.com'] });
    expect((await doConnect('gone.example.com:443')).status).toBe(502);
  });
});

describe('plain HTTP', () => {
  let upstream: Server;
  let seen: { url?: string; headers: Record<string, string | string[] | undefined> } | undefined;
  beforeEach(async () => {
    upstream = httpServer((req, res) => {
      seen = { url: req.url, headers: req.headers };
      res.end('hello');
    });
    const p = await listen(upstream);
    // Re-point the proxy's dial at the http upstream.
    proxy.close();
    proxy = startEgressProxy(cfg, {
      sandboxForIp: () => current,
      resolve: (h) => Promise.resolve(dns[h] ?? []),
      dial: () => connect(p, '127.0.0.1'),
    });
    proxyPort = await listen(proxy);
  });
  afterEach(() => {
    upstream.close();
    upstream.closeAllConnections();
  });
  const get = (url: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string }>((ok, fail) => {
      const u = new URL(url);
      const r = request(
        { host: '127.0.0.1', port: proxyPort, path: url, headers: { host: u.host, ...headers } },
        (res) => {
          let body = '';
          res.on('data', (d: Buffer) => (body += d.toString()));
          res.on('end', () => {
            ok({ status: res.statusCode ?? 0, body });
          });
        },
      );
      r.on('error', fail);
      r.end();
    });

  it('forwards an allowed absolute-URI request without proxy/hop headers', async () => {
    const r = await get('http://api.anthropic.com/v1/x?a=1', {
      'proxy-authorization': 'Basic abc',
      'x-keep': '1',
    });
    expect(r).toEqual({ status: 200, body: 'hello' });
    expect(seen?.url).toBe('/v1/x?a=1');
    expect(seen?.headers['proxy-authorization']).toBeUndefined();
    expect(seen?.headers['x-keep']).toBe('1');
    expect(seen?.headers.host).toBe('api.anthropic.com');
  });
  it('refuses unlisted hosts and non-80 ports', async () => {
    expect((await get('http://other.example.com/')).status).toBe(403);
    expect((await get('http://api.anthropic.com:8080/')).status).toBe(403);
  });
});

describe('ip map', () => {
  it('boots from inspect and follows start/die/destroy events', async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), 'sbxd-')));
    const docker = new FakeDocker();
    docker.containers.set('c1', { spec: {} as never, status: 'running' });
    store.insert(row());
    const map = await createIpMap(store, docker);
    expect(map.sandboxForIp('172.31.0.2')?.id).toBe('s1');
    expect(map.sandboxForIp('172.31.0.9')).toBeUndefined();
    docker.emit({ action: 'die', cid: 'c1', labels: { 'sandboxd.id': 's1' } });
    expect(map.sandboxForIp('172.31.0.2')).toBeUndefined();
    docker.emit({ action: 'start', cid: 'c1', labels: { 'sandboxd.id': 's1' } });
    await new Promise((r) => setTimeout(r, 10));
    expect(map.sandboxForIp('172.31.0.2')?.id).toBe('s1');
    docker.emit({ action: 'destroy', cid: 'c1', labels: { 'sandboxd.id': 's1' } });
    expect(map.sandboxForIp('172.31.0.2')).toBeUndefined();
    map.stop();
    store.close();
  });
});
