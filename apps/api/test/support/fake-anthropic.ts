import { createServer, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * A loopback fake of the Anthropic Messages API (spec 011, research R2/R3), in the
 * `fake-daytona.ts` shape: one `node:http` listener, a per-request script queue, and a
 * `requests` log. Only `POST /v1/messages` is served — the SSE wire format matches exactly what
 * `@anthropic-ai/sdk`'s stream parser expects (`event: <type>\ndata: <json>\n\n`), so the adapter
 * spec exercises the real SDK stream-assembly path over a real socket.
 */
export interface FakeRequest {
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface ScriptedToolUse {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface ScriptedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
}

export interface ScriptedReply {
  /** One `thinking` block, one `thinking_delta` per entry (`''` is the omitted-display shape). */
  readonly thinking?: readonly string[];
  /** One `text` block; an array is one `text_delta` per entry, a string is a single delta. */
  readonly text?: string | readonly string[];
  readonly toolUse?: readonly ScriptedToolUse[];
  readonly usage: ScriptedUsage;
  readonly stopReason: string;
}

export type Script =
  | { readonly reply: ScriptedReply }
  | { readonly status: number; readonly body: unknown; readonly headers?: Record<string, string> }
  | { readonly hang: true }
  | { readonly dropMidStream: true };

export interface FakeAnthropic {
  readonly baseURL: string;
  readonly requests: FakeRequest[];
  /** Queues the next reply to `POST /v1/messages`; consumed one script per request, FIFO. */
  script(next: Script): void;
  start(): Promise<void>;
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function sseEvent(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Splits a string into `n` non-empty fragments (n >= 2), each a fraction of the whole. */
function splitFragments(value: string, n: number): string[] {
  const size = Math.max(1, Math.ceil(value.length / n));
  const parts: string[] = [];
  for (let i = 0; i < value.length; i += size) parts.push(value.slice(i, i + size));
  return parts.length > 0 ? parts : [''];
}

function usageBlock(usage: ScriptedUsage): Record<string, number> {
  const block: Record<string, number> = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
  };
  if (usage.cacheReadInputTokens !== undefined) {
    block.cache_read_input_tokens = usage.cacheReadInputTokens;
  }
  if (usage.cacheCreationInputTokens !== undefined) {
    block.cache_creation_input_tokens = usage.cacheCreationInputTokens;
  }
  return block;
}

/** Builds the full SSE event sequence for a scripted reply, in order. */
export function buildEvents(reply: ScriptedReply): string[] {
  const events: string[] = [];
  events.push(
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_fake',
        type: 'message',
        role: 'assistant',
        model: 'claude-fake',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: usageBlock(reply.usage),
      },
    }),
  );

  let index = 0;

  if (reply.thinking !== undefined) {
    const blockIndex = index++;
    events.push(
      sseEvent('content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      }),
    );
    for (const thinking of reply.thinking) {
      events.push(
        sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'thinking_delta', thinking },
        }),
      );
    }
    events.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex }));
  }

  if (reply.text !== undefined) {
    const blockIndex = index++;
    events.push(
      sseEvent('content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'text', text: '' },
      }),
    );
    const deltas = typeof reply.text === 'string' ? [reply.text] : reply.text;
    for (const text of deltas) {
      events.push(
        sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'text_delta', text },
        }),
      );
    }
    events.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex }));
  }

  for (const toolUse of reply.toolUse ?? []) {
    const blockIndex = index++;
    events.push(
      sseEvent('content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'tool_use', id: toolUse.id, name: toolUse.name, input: {} },
      }),
    );
    const fragments = splitFragments(JSON.stringify(toolUse.input), 2);
    for (const fragment of fragments) {
      events.push(
        sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'input_json_delta', partial_json: fragment },
        }),
      );
    }
    events.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex }));
  }

  events.push(
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: reply.stopReason, stop_sequence: null },
      usage: { output_tokens: reply.usage.outputTokens },
    }),
  );
  events.push(sseEvent('message_stop', { type: 'message_stop' }));

  return events;
}

export function startFakeAnthropic(): FakeAnthropic {
  const requests: FakeRequest[] = [];
  const scripts: Script[] = [];
  const sockets = new Set<Socket>();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const body = await readBody(request);
    requests.push({ headers: request.headers, body: body.toString('utf8') });

    if (request.method !== 'POST' || url.pathname !== '/v1/messages') {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end(`fake anthropic: no route ${request.method} ${url.pathname}`);
      return;
    }

    const next = scripts.shift();
    if (next === undefined) {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('fake anthropic: no script queued for this request');
      return;
    }

    if ('hang' in next) {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      // Node buffers `writeHead` until the first write: flush so the client sees 200 and then
      // waits on the body. Never written to again; close() destroys the socket.
      response.flushHeaders();
      return;
    }

    if ('status' in next) {
      response.writeHead(next.status, {
        'content-type': 'application/json',
        ...(next.headers ?? {}),
      });
      response.end(JSON.stringify(next.body));
      return;
    }

    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });

    if ('dropMidStream' in next) {
      // scripted as a bare reply with a fixed stop, so the event sequence is deterministic
      const events = buildEvents({
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: 'end_turn',
      });
      const half = Math.ceil(events.length / 2);
      for (const event of events.slice(0, half - 1)) response.write(event);
      // Destroy once the last event has left, so the client sees 200 and a mid-body socket error
      // rather than a connection that never answered.
      response.write(events[half - 1]!, () => request.socket.destroy());
      return;
    }

    for (const event of buildEvents(next.reply)) response.write(event);
    response.end();
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return {
    get baseURL(): string {
      const port = (server.address() as AddressInfo).port;
      return `http://127.0.0.1:${port}`;
    },
    requests,
    script: (next) => {
      scripts.push(next);
    },
    start: () => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)),
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) return resolve();
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
