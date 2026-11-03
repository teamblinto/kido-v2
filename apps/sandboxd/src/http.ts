import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { log } from './log.ts';

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  url: URL,
) => Promise<void>;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

export function requireBearer(req: IncomingMessage, key: string): void {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  const got = Buffer.from(m?.[1] ?? '');
  const want = Buffer.from(key);
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    throw new HttpError(401, 'unauthorized');
  }
}

export function router() {
  const routes: { method: string; re: RegExp; names: string[]; handler: Handler }[] = [];

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://sandboxd');
    for (const r of routes) {
      const m = r.method === req.method ? r.re.exec(url.pathname) : null;
      if (!m) continue;
      const params = Object.fromEntries(
        r.names.map((n, i) => [n, decodeURIComponent(m[i + 1] ?? '')]),
      );
      await r.handler(req, res, params, url);
      return;
    }
    throw new HttpError(404, 'not found');
  }

  return {
    route(this: void, method: string, pattern: string, handler: Handler): void {
      const names: string[] = [];
      const src = pattern
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/:(\w+)/g, (_, n: string) => {
          names.push(n);
          return '([^/]+)';
        });
      routes.push({ method, re: new RegExp(`^${src}$`), names, handler });
    },
    handle(this: void, req: IncomingMessage, res: ServerResponse): void {
      dispatch(req, res).catch((err: unknown) => {
        if (res.headersSent) {
          res.destroy();
        } else if (err instanceof HttpError) {
          sendJson(res, err.status, { message: err.message });
        } else {
          log('error', 'unhandled', { err: err instanceof Error ? err.message : String(err) });
          sendJson(res, 500, { message: 'internal error' });
        }
      });
    },
  };
}
