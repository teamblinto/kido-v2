import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect, type Socket } from 'node:net';

import type { Config } from './config.ts';
import type { DockerPort } from './docker.ts';
import { HttpError, sendJson, type router } from './http.ts';
import { log } from './log.ts';
import type { Store } from './store.ts';

const HEADER = 'x-daytona-preview-token';
const CONNECT_TIMEOUT_MS = 30_000;

const sign = (secret: Buffer, payload: string) =>
  createHmac('sha256', secret).update(payload).digest();

export function mintPreviewToken(
  secret: Buffer,
  sandboxId: string,
  port: number,
  expiresAt: number,
): string {
  const payload = Buffer.from(JSON.stringify({ s: sandboxId, p: port, e: expiresAt })).toString(
    'base64url',
  );
  return `${payload}.${sign(secret, payload).toString('base64url')}`;
}

export function verifyPreviewToken(
  secret: Buffer,
  token: string,
  now: number,
): { sandboxId: string; port: number } | null {
  const [payload, sig, extra] = token.split('.');
  if (!payload || !sig || extra !== undefined) return null;
  const got = Buffer.from(sig, 'base64url');
  const want = sign(secret, payload);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const t = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      s?: unknown;
      p?: unknown;
      e?: unknown;
    };
    if (typeof t.s !== 'string' || typeof t.p !== 'number' || typeof t.e !== 'number') return null;
    return t.e < now ? null : { sandboxId: t.s, port: t.p };
  } catch {
    return null;
  }
}

export function registerPreviewRoutes(
  api: ReturnType<typeof router>,
  d: { cfg: Config; store: Store },
): void {
  api.route('GET', '/sandbox/:id/ports/:port/signed-preview-url', (_req, res, params, url) => {
    const port = Number(params.port);
    const ttl = Number(url.searchParams.get('expiresInSeconds') ?? 3600);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new HttpError(400, 'invalid port');
    }
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400) {
      throw new HttpError(400, 'expiresInSeconds must be 60-86400');
    }
    const id = params.id!;
    if (!d.store.get(id)) throw new HttpError(404, 'sandbox not found');
    const token = mintPreviewToken(
      d.cfg.previewSecret,
      id,
      port,
      Math.floor(Date.now() / 1000) + ttl,
    );
    sendJson(res, 200, { url: d.cfg.previewPublicUrl, token });
    return Promise.resolve();
  });
}

interface Target {
  sandboxId: string;
  port: number;
  ip: string;
}
interface Deps {
  cfg: Config;
  store: Store;
  docker: DockerPort;
}

/** Token is the only auth; it decides which sandbox and port are dialled. */
async function resolve(
  d: Deps,
  req: IncomingMessage,
  seen: { sandboxId?: string; port?: number },
): Promise<Target> {
  const raw = req.headers[HEADER];
  const t = verifyPreviewToken(
    d.cfg.previewSecret,
    (Array.isArray(raw) ? raw[0] : raw) ?? '',
    Math.floor(Date.now() / 1000),
  );
  if (!t) throw new HttpError(401, 'invalid preview token');
  seen.sandboxId = t.sandboxId;
  seen.port = t.port;
  const row = d.store.get(t.sandboxId);
  if (!row) throw new HttpError(404, 'sandbox not found');
  const c = row.containerId ? await d.docker.inspect(row.containerId) : null;
  if (c?.status !== 'running' || !c.ip) throw new HttpError(503, 'sandbox not running');
  return { ...t, ip: c.ip };
}

/** Request headers with the token removed and host pointed at the upstream. */
function upstreamHeaders(req: IncomingMessage, t: Target): IncomingHttpHeaders {
  const rest = { ...req.headers };
  delete rest[HEADER];
  return { ...rest, host: `${t.ip}:${t.port}` };
}

export function createPreviewServer(d: Deps): Server {
  const done = (t: { sandboxId?: string; port?: number }, status: number, t0: number) =>
    log('info', 'preview', {
      op: 'preview',
      sandboxId: t?.sandboxId,
      port: t?.port,
      status,
      durationMs: Math.round(performance.now() - t0),
    });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const t0 = performance.now();
    const target: { sandboxId?: string; port?: number } = {};
    const fail = (err: unknown) => {
      if (res.headersSent) return void res.destroy();
      const status = err instanceof HttpError ? err.status : 502;
      if ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
        res.setHeader('x-sandboxd-upstream', 'refused');
      }
      sendJson(res, status, { message: err instanceof HttpError ? err.message : 'bad gateway' });
      done(target, status, t0);
    };
    resolve(d, req, target)
      .then((t) => {
        // No total timeout (HMR/streaming); only the connect phase is bounded.
        const up = request({
          host: t.ip,
          port: t.port,
          method: req.method,
          path: req.url,
          headers: upstreamHeaders(req, t),
        });
        const timer = setTimeout(
          () => up.destroy(new Error('connect timeout')),
          CONNECT_TIMEOUT_MS,
        );
        up.once('socket', (s) => {
          if (s.connecting) s.once('connect', () => clearTimeout(timer));
          else clearTimeout(timer);
        });
        up.once('error', (e) => {
          clearTimeout(timer);
          fail(e);
        });
        up.once('response', (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
          r.once('error', () => res.destroy());
          res.once('close', () => {
            r.destroy();
            done(t, r.statusCode ?? 502, t0);
          });
        });
        res.once('close', () => up.destroy());
        req.pipe(up);
      })
      .catch(fail);
  });

  server.on('upgrade', (req: IncomingMessage, client: Socket, head: Buffer) => {
    const t0 = performance.now();
    client.on('error', () => client.destroy());
    const seen: { sandboxId?: string; port?: number } = {};
    resolve(d, req, seen)
      .then((t) => {
        const up = connect({ host: t.ip, port: t.port });
        const kill = () => {
          up.destroy();
          client.destroy();
        };
        up.setTimeout(CONNECT_TIMEOUT_MS, () => {
          if (up.connecting) kill();
        });
        up.on('error', kill);
        client.on('error', kill);
        client.on('close', kill);
        up.once('connect', () => {
          up.setTimeout(0);
          let msg = `${req.method} ${req.url} HTTP/1.1\r\n`;
          for (const [k, v] of Object.entries(upstreamHeaders(req, t))) {
            for (const x of [v ?? []].flat())
              msg += `${k}: ${x}\r\n`;
          }
          up.write(`${msg}\r\n`);
          if (head.length) up.write(head);
          up.pipe(client);
          client.pipe(up);
          done(t, 101, t0);
        });
      })
      .catch((err: unknown) => {
        done(seen, err instanceof HttpError ? err.status : 502, t0);
        client.destroy();
      });
  });
  return server;
}
