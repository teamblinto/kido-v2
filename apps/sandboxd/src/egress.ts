import { lookup } from 'node:dns/promises';
import {
  createServer,
  request,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect, isIP, type Socket } from 'node:net';

import type { Config } from './config.ts';
import { log } from './log.ts';
import type { SandboxRow } from './store.ts';

export interface EgressDeps {
  /** Source IP -> sandbox row, read fresh so network-settings changes apply to new connections. */
  sandboxForIp(ip: string): SandboxRow | undefined;
  resolve?: (host: string) => Promise<string[]>;
  /** Open the upstream connection; overridable for tests. */
  dial?: (ip: string, port: number) => Socket;
}

const CONNECT_TIMEOUT_MS = 10_000;
const DNS_TIMEOUT_MS = 5_000;
const IDLE_TIMEOUT_MS = 300_000;

/** `host:port` or `[v6]:port`; the port is mandatory. */
function parseTarget(s: string): { host: string; port: number } | null {
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([^:[\]\s/]+)):(\d{1,5})$/.exec(s);
  const host = m?.[1] ?? m?.[2];
  const port = Number(m?.[3]);
  return host === undefined || port > 65535 ? null : { host, port };
}

const v4 = (ip: string): number[] | null => {
  const p = ip.split('.');
  if (p.length !== 4 || !p.every((x) => /^\d{1,3}$/.test(x) && Number(x) < 256)) return null;
  return p.map(Number);
};

/** Eight 16-bit groups of an IPv6 literal (embedded dotted v4 tail supported), or null. */
function v6groups(ip: string): number[] | null {
  const s = ip.split('%')[0] ?? '';
  if (isIP(s) !== 6) return null;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  let str = s;
  if (tail) {
    const q = v4(tail[1]!);
    if (!q) return null;
    str =
      s.slice(0, -tail[1]!.length) +
      ((q[0]! << 8) | q[1]!).toString(16) +
      ':' +
      ((q[2]! << 8) | q[3]!).toString(16);
  }
  const [head = '', rest] = str.split('::');
  const h = head ? head.split(':') : [];
  const t = rest ? rest.split(':') : [];
  const mid = rest === undefined ? [] : Array<string>(8 - h.length - t.length).fill('0');
  return [...h, ...mid, ...t].map((x) => parseInt(x, 16));
}

const inV4 = (q: number[], base: string, bits: number): boolean => {
  const a = v4(base)!;
  const n = (x: number[]) => ((x[0]! << 24) | (x[1]! << 16) | (x[2]! << 8) | x[3]!) >>> 0;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (n(q) & mask) === (n(a) & mask);
};

const PRIVATE_V4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/** True for addresses an agent must never reach; anything unparseable counts as private. */
export function isPrivateAddress(ip: string): boolean {
  const q = v4(ip);
  if (q) return PRIVATE_V4.some(([b, n]) => inV4(q, b, n));
  const g = v6groups(ip);
  if (!g) return true;
  // Only global unicast 2000::/3 is public, minus tunnelling/documentation prefixes that
  // can embed or alias private IPv4 space (this also refuses v4-mapped, NAT64, multicast, ULA).
  const [a = 0, b = 0] = g;
  if (a < 0x2000 || a > 0x3fff) return true;
  if (a === 0x2001 && (b === 0 || b === 0x0db8)) return true; // Teredo, documentation
  if (a === 0x2002) return true; // 6to4
  return a === 0x3fff && b < 0x1000; // documentation
}

const norm = (h: string) => h.toLowerCase().replace(/\.$/, '');

/** Does allow-list entry `entry` admit hostname `host`? Names only; IP/CIDR entries match resolved addresses. */
export function matchesEntry(host: string, entry: string): boolean {
  const h = norm(host);
  const e = norm(entry);
  return e.startsWith('.') ? h.endsWith(e) && h.length > e.length : h === e;
}

const isIpEntry = (e: string) => /\/\d+$/.test(e) || isIP(e) !== 0;

function matchesIp(ip: string, entry: string): boolean {
  const [base = '', bits] = entry.split('/');
  const q = v4(ip);
  if (bits !== undefined) {
    const b = Number(bits);
    return q !== null && v4(base) !== null && b <= 32 && inV4(q, base, b);
  }
  if (q) return ip === base;
  const a = v6groups(ip);
  const c = v6groups(base);
  return a !== null && c !== null && a.join(':') === c.join(':');
}

const HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

function stripHop(h: IncomingMessage['headers']): OutgoingHttpHeaders {
  const drop = new Set([
    ...HOP,
    ...String(h.connection ?? '')
      .split(',')
      .map((x) => x.trim().toLowerCase()),
  ]);
  return Object.fromEntries(Object.entries(h).filter(([k]) => !drop.has(k)));
}

type Decision =
  | { ok: true; row: SandboxRow; ip: string }
  | { ok: false; status: number; reason: string; row?: SandboxRow };

export function startEgressProxy(cfg: Config, deps: EgressDeps): Server {
  const rawResolve =
    deps.resolve ?? (async (h: string) => (await lookup(h, { all: true })).map((a) => a.address));
  const resolve = (h: string) => {
    let t: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, no) => {
      t = setTimeout(() => no(new Error('dns timeout')), DNS_TIMEOUT_MS);
    });
    return Promise.race([rawResolve(h), timeout]).finally(() => clearTimeout(t));
  };
  const dial =
    deps.dial ??
    ((ip: string, port: number) => {
      const s = connect({ host: ip, port });
      s.setTimeout(CONNECT_TIMEOUT_MS, () => s.destroy(new Error('connect timeout')));
      s.once('connect', () => s.setTimeout(0));
      return s;
    });
  const apiHost = norm(cfg.apiHost);

  async function decide(
    remote: string | undefined,
    rawHost: string,
    port: number,
  ): Promise<Decision> {
    const row = deps.sandboxForIp((remote ?? '').replace(/^::ffff:/, ''));
    if (row?.class !== 'agent') return { ok: false, status: 403, reason: 'unknown-source' };
    const fail = (status: number, reason: string): Decision => ({ ok: false, status, reason, row });
    if (row.networkBlockAll) return fail(403, 'block-all');
    if (port !== 443 && port !== 80) return fail(403, 'port');

    const host = norm(rawHost.replace(/^\[|\]$/g, ''));
    const isApi = apiHost !== '' && host === apiHost;
    const entries = row.networkAllow ?? cfg.egressAgentDefault;
    const nameOk = isApi || entries.some((e) => !isIpEntry(e) && matchesEntry(host, e));
    const ipEntries = entries.filter(isIpEntry);
    // shortcut: with CIDR/IP entries the name is resolved before refusal (needed to match them).
    if (!nameOk && ipEntries.length === 0) return fail(403, 'not-allowed');

    let addrs: string[];
    try {
      addrs = await resolve(host);
    } catch {
      return fail(502, 'dns');
    }
    if (addrs.length === 0) return fail(502, 'dns');
    if (!isApi && addrs.some(isPrivateAddress)) return fail(403, 'private-address');
    const ip = nameOk ? addrs[0] : addrs.find((a) => ipEntries.some((e) => matchesIp(a, e)));
    return ip === undefined ? fail(403, 'not-allowed') : { ok: true, row, ip };
  }

  const refusal = (d: Extract<Decision, { ok: false }>, host: string, port: number) =>
    log('warn', 'egress refused', {
      op: 'egress',
      sandboxId: d.row?.id ?? null,
      host,
      port,
      reason: d.reason,
    });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const fail502 = (e: unknown) => {
      log('error', 'egress internal error', { op: 'egress', err: String(e) });
      if (!res.headersSent) res.writeHead(502);
      res.end();
    };
    void (async () => {
      let u: URL;
      try {
        u = new URL(req.url ?? '');
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (u.protocol !== 'http:') {
        res.writeHead(400).end();
        return;
      }
      const port = u.port === '' ? 80 : Number(u.port);
      const d = await decide(req.socket.remoteAddress, u.hostname, port === 80 ? 80 : -1);
      if (!d.ok) {
        refusal(d, u.hostname, port);
        res.writeHead(d.status).end();
        return;
      }
      const t0 = Date.now();
      const up = request({
        createConnection: () => dial(d.ip, 80),
        method: req.method,
        path: u.pathname + u.search,
        headers: { ...stripHop(req.headers), host: u.host },
      });
      up.on('response', (r) => {
        res.writeHead(r.statusCode ?? 502, stripHop(r.headers));
        r.pipe(res);
        r.on('end', () => {
          log('info', 'egress http', {
            op: 'egress',
            sandboxId: d.row.id,
            host: u.hostname,
            port,
            durationMs: Date.now() - t0,
          });
        });
      });
      up.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      up.setTimeout(IDLE_TIMEOUT_MS, () => up.destroy());
      res.on('close', () => {
        if (!res.writableFinished) up.destroy();
      });
      req.pipe(up);
    })().catch(fail502);
  });

  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    client.on('error', () => client.destroy());
    void (async () => {
      const target = parseTarget(req.url ?? '');
      if (!target) {
        client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      const { host, port } = target;
      const d = await decide(client.remoteAddress, host, port);
      if (!d.ok) {
        refusal(d, host, port);
        client.end(
          `HTTP/1.1 ${d.status} ${d.status === 403 ? 'Forbidden' : 'Bad Gateway'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
        return;
      }
      const t0 = Date.now();
      const up = dial(d.ip, port);
      let bytesUp = 0;
      let bytesDown = 0;
      up.once('connect', () => {
        client.setTimeout(IDLE_TIMEOUT_MS, done);
        up.setTimeout(IDLE_TIMEOUT_MS, done);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) up.write(head);
        client.on('data', (b: Buffer) => (bytesUp += b.length));
        up.on('data', (b: Buffer) => (bytesDown += b.length));
        client.pipe(up);
        up.pipe(client);
        log('info', 'egress tunnel open', { op: 'egress', sandboxId: d.row.id, host, port });
      });
      let closed = false;
      const done = () => {
        if (closed) return;
        closed = true;
        client.destroy();
        up.destroy();
        log('info', 'egress tunnel closed', {
          op: 'egress',
          sandboxId: d.row.id,
          host,
          port,
          bytesUp,
          bytesDown,
          durationMs: Date.now() - t0,
        });
      };
      up.on('error', () => {
        if (!up.connecting && up.bytesWritten === 0 && bytesDown === 0 && !client.destroyed) {
          client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        }
        done();
      });
      up.on('close', done);
      client.on('close', done);
    })().catch((e: unknown) => {
      log('error', 'egress internal error', { op: 'egress', err: String(e) });
      client.destroy();
    });
  });

  return server;
}
