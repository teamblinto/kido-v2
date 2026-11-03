import { createServer, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * A loopback webhook receiver for spec 029 (research R14): one `node:http` listener that records
 * every request and answers from a per-path script.
 *
 * - Each request is recorded with its method, path (with query), headers and exact body bytes.
 * - `script(path, ...steps)` sets the answers for `path`, consumed one per request; the last step
 *   repeats. An unscripted path answers `200` with an empty body.
 * - The steps: `respond(status, {body, headers})`, `hang()` (never answers), `redirect(to)` (a
 *   `302`), `unboundedBody()` (a `200` that streams until the client goes away), and
 *   `retryAfter(seconds, status)` (a `503` or `429` with `Retry-After`).
 * - `url(path, {host})` builds the URL; `host` defaults to the bound address, and a test that pins
 *   through `FakeResolver` passes a name instead.
 */
export interface ReceivedRequest {
  readonly body: Buffer;
  readonly headers: IncomingHttpHeaders;
  readonly method: string;
  readonly path: string;
}

export type ReceiverStep =
  | {
      readonly kind: 'respond';
      readonly status: number;
      readonly body?: string;
      readonly headers?: Readonly<Record<string, string | readonly string[]>>;
    }
  | { readonly kind: 'hang' }
  | { readonly kind: 'unbounded' };

export const respond = (
  status: number,
  options: {
    readonly body?: string;
    readonly headers?: Readonly<Record<string, string | readonly string[]>>;
  } = {},
): ReceiverStep => ({ kind: 'respond', status, ...options });

export const hang = (): ReceiverStep => ({ kind: 'hang' });

export const redirect = (to: string): ReceiverStep => respond(302, { headers: { location: to } });

export const unboundedBody = (): ReceiverStep => ({ kind: 'unbounded' });

export const retryAfter = (seconds: number, status: 429 | 503 = 503): ReceiverStep =>
  respond(status, { headers: { 'retry-after': String(seconds) } });

export interface FakeReceiver {
  readonly host: string;
  readonly port: number;
  /** Every request so far, in arrival order. */
  readonly all: readonly ReceivedRequest[];
  url(path: string, options?: { readonly host?: string }): string;
  /** The requests for `path` (compared without the query), in arrival order. */
  requests(path: string): readonly ReceivedRequest[];
  script(path: string, ...steps: readonly ReceiverStep[]): void;
  reset(): void;
  close(): Promise<void>;
}

const CHUNK = Buffer.alloc(16 * 1024, 'x');

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

const pathOnly = (path: string) => path.split('?')[0] ?? path;

export async function startFakeReceiver(
  options: { readonly host?: string; readonly port?: number } = {},
): Promise<FakeReceiver> {
  const host = options.host ?? '127.0.0.1';
  const received: ReceivedRequest[] = [];
  const scripts = new Map<string, { steps: readonly ReceiverStep[]; next: number }>();
  const sockets = new Set<Socket>();

  const server = createServer((request, response) => {
    void (async () => {
      const path = request.url ?? '/';
      const body = await readBody(request).catch(() => Buffer.alloc(0));
      received.push({ body, headers: request.headers, method: request.method ?? '', path });

      const script = scripts.get(pathOnly(path));
      const step: ReceiverStep =
        script === undefined
          ? respond(200)
          : script.steps[Math.min(script.next++, script.steps.length - 1)]!;

      switch (step.kind) {
        case 'hang':
          return;
        case 'unbounded': {
          response.writeHead(200, { 'content-type': 'application/octet-stream' });
          const pump = () => {
            while (!response.destroyed && response.write(CHUNK));
            if (!response.destroyed) response.once('drain', pump);
          };
          pump();
          return;
        }
        case 'respond':
          response.writeHead(step.status, step.headers as Record<string, string | string[]>);
          response.end(step.body ?? '');
      }
    })();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  return {
    all: received,
    host,
    port,
    url: (path, urlOptions = {}) => {
      const name = urlOptions.host ?? (host.includes(':') ? `[${host}]` : host);
      return `http://${name}:${port}${path}`;
    },
    requests: (path) => received.filter((request) => pathOnly(request.path) === pathOnly(path)),
    script: (path, ...steps) => {
      if (steps.length === 0) throw new Error('FakeReceiver.script needs at least one step');
      scripts.set(pathOnly(path), { next: 0, steps });
    },
    reset: () => {
      received.length = 0;
      scripts.clear();
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
