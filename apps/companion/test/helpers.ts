import { mkdtempSync, realpathSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type CompanionRunEvent, companionRunEventBatchSchema } from '@repo/contracts';

import type { RunEventBody, RunHandle } from '../src/providers/types.ts';

export const FAKE_CLAUDE = fileURLToPath(new URL('fixtures/fake-claude.mjs', import.meta.url));
export const SELF_SCRIPT = fileURLToPath(new URL('../src/main.ts', import.meta.url));

export const DEVICE_ID = '0b6f6e5e-1c1a-4c55-9a8f-2b7a7f1d9e01';
export const DEVICE_TOKEN = `bld_${'A'.repeat(43)}`;

export function tempDir(prefix = 'baios-test-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Everything a run handle emits, until it completes. */
export async function collect(
  handle: RunHandle,
  onEvent?: (event: RunEventBody) => void,
): Promise<RunEventBody[]> {
  const events: RunEventBody[] = [];
  for await (const event of handle.events) {
    events.push(event);
    onEvent?.(event);
  }
  await handle.dispose();
  return events;
}

export const textOf = (events: { type: string; data?: unknown }[]) =>
  events
    .map((event) => (event.type === 'text.delta' ? (event.data as { text: string }).text : ''))
    .join('');

export const terminalOf = (events: RunEventBody[]) => {
  const last = events.at(-1);
  if (last?.type !== 'terminal') throw new Error('no terminal event');
  return last.data;
};

async function body(request: IncomingMessage, raw: string[]): Promise<unknown> {
  let text = '';
  for await (const chunk of request) text += String(chunk);
  raw.push(text);
  return text ? (JSON.parse(text) as unknown) : undefined;
}

export interface FakeServerOptions {
  /** Commands sent on every new connection before anything else (default: a `hello`). */
  hello?: Record<string, unknown> | null;
}

/** A minimal BAIOS: the SSE command stream, status, sign-in and run-event ingest. */
export class FakeServer {
  url = '';
  readonly connects: { authorization?: string; lastEventId?: string }[] = [];
  readonly statuses: unknown[] = [];
  /** `POST /local-agent/auth` bodies (hosted sign-in). */
  readonly authEvents: Record<string, unknown>[] = [];
  /** Every request body as sent, to check what never leaves the runner. */
  readonly bodies: string[] = [];
  readonly runEvents = new Map<string, CompanionRunEvent[]>();
  eventPosts = 0;
  failEventPosts = 0;
  revoked = false;
  private readonly history: { data: string; id: number }[] = [];
  private readonly streams = new Set<ServerResponse>();
  private readonly server = createServer((request, response) => void this.route(request, response));
  private readonly hello: Record<string, unknown> | null;

  constructor(options: FakeServerOptions = {}) {
    this.hello =
      options.hello === undefined
        ? {
            deviceId: DEVICE_ID,
            heartbeatSeconds: 15,
            policy: {
              claude: { allowedAuthMethods: ['subscription', 'api_key', 'cloud_provider'] },
            },
            type: 'hello',
          }
        : options.hello;
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async close(): Promise<void> {
    this.dropConnections();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Appends a command to the stream and writes it to every open connection. */
  send(command: Record<string, unknown>): void {
    const entry = { data: JSON.stringify(command), id: this.history.length + 1 };
    this.history.push(entry);
    for (const stream of this.streams) stream.write(`id: ${entry.id}\ndata: ${entry.data}\n\n`);
  }

  /** An ephemeral `event: auth` frame: no id, never replayed. */
  sendAuth(command: Record<string, unknown>): void {
    for (const stream of this.streams) {
      stream.write(`event: auth\ndata: ${JSON.stringify(command)}\n\n`);
    }
  }

  dropConnections(): void {
    for (const stream of this.streams) stream.destroy();
    this.streams.clear();
  }

  get openStreams(): number {
    return this.streams.size;
  }

  /** What was posted for one turn of a run; each turn's seqs are its own, as on the server. */
  events(runId: string, turn = 1): CompanionRunEvent[] {
    return this.runEvents.get(`${runId}#${String(turn)}`) ?? [];
  }

  private unauthorized(request: IncomingMessage, response: ServerResponse): boolean {
    if (!this.revoked && request.headers.authorization === `Bearer ${DEVICE_TOKEN}`) return false;
    response.writeHead(401, { 'content-type': 'application/problem+json' });
    response.end(
      JSON.stringify({ status: 401, title: 'Unauthorized', type: 'local-agent-revoked' }),
    );
    return true;
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = request.url ?? '';
    if (request.method === 'GET' && path === '/api/v1/local-agent/connect') {
      if (this.unauthorized(request, response)) return;
      const lastEventId = request.headers['last-event-id'];
      this.connects.push({
        authorization: request.headers.authorization,
        lastEventId: typeof lastEventId === 'string' ? lastEventId : undefined,
      });
      response.writeHead(200, { 'cache-control': 'no-cache', 'content-type': 'text/event-stream' });
      response.write(':ok\n\n');
      this.streams.add(response);
      response.on('close', () => this.streams.delete(response));
      // A fresh hello (not part of the replayable stream), then what this connection missed.
      if (this.hello) response.write(`data: ${JSON.stringify(this.hello)}\n\n`);
      const after = Number(lastEventId ?? 0);
      for (const entry of this.history.filter((item) => item.id > after)) {
        response.write(`id: ${entry.id}\ndata: ${entry.data}\n\n`);
      }
      return;
    }
    if (request.method === 'POST' && path === '/api/v1/local-agent/status') {
      if (this.unauthorized(request, response)) return;
      this.statuses.push(await body(request, this.bodies));
      response.writeHead(204).end();
      return;
    }
    if (request.method === 'POST' && path === '/api/v1/local-agent/auth') {
      if (this.unauthorized(request, response)) return;
      this.authEvents.push((await body(request, this.bodies)) as Record<string, unknown>);
      response.writeHead(202).end();
      return;
    }
    const match = /^\/api\/v1\/local-agent\/runs\/([^/]+)\/events$/.exec(path);
    if (request.method === 'POST' && match?.[1]) {
      if (this.unauthorized(request, response)) return;
      const parsed = companionRunEventBatchSchema.safeParse(await body(request, this.bodies));
      if (!parsed.success) {
        response.writeHead(422).end();
        return;
      }
      const payload = parsed.data;
      this.eventPosts += 1;
      if (this.failEventPosts > 0) {
        this.failEventPosts -= 1;
        response.writeHead(503).end();
        return;
      }
      const key = `${match[1]}#${String(payload.turn)}`;
      const list = this.runEvents.get(key) ?? [];
      for (const event of payload.events) {
        if (!list.some((held) => held.seq === event.seq)) list.push(event);
      }
      this.runEvents.set(key, list);
      response.writeHead(202).end();
      return;
    }
    response.writeHead(404).end();
  }
}
