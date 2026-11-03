import { type IncomingMessage, request as httpRequest } from 'node:http';

/** One SSE block as the bytes carried it; comment lines (`:heartbeat`) are kept, not dropped. */
export interface Frame {
  readonly comment?: string;
  readonly data?: string;
  readonly event?: string;
  readonly id?: string;
  readonly retry?: number;
}

export interface OpenStream {
  /** Destroys the socket: the server sees `close` and must let go of the run. */
  close(): void;
  readonly frames: AsyncIterable<Frame>;
  readonly res: IncomingMessage;
}

/**
 * `GET path` over `node:http` against a listening port — not supertest, which buffers until the
 * response ends and an SSE response ends only with the run. Resolves at the response head;
 * `frames` parses the body block by block until the server ends it or `close()` is called.
 */
export function openStream(
  port: number,
  path: string,
  // `headers` for a caller that is not a browser — the 040 companion sends a bearer token, no cookie.
  options: { cookie?: string; headers?: Record<string, string>; lastEventId?: number | string },
): Promise<OpenStream> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      ...(options.cookie === undefined ? {} : { Cookie: options.cookie }),
      ...options.headers,
    };

    if (options.lastEventId !== undefined) {
      headers['Last-Event-ID'] = String(options.lastEventId);
    }

    const req = httpRequest({ headers, host: '127.0.0.1', method: 'GET', path, port }, (res) => {
      resolve({ close: () => req.destroy(), frames: frames(res), res });
    });

    req.on('error', reject);
    req.end();
  });
}

/** Reads `frames` until `stop` says so (that frame included) or the stream ends. */
export async function collect(
  stream: OpenStream,
  stop: (frame: Frame, seen: readonly Frame[]) => boolean = () => false,
): Promise<Frame[]> {
  const seen: Frame[] = [];

  for await (const frame of stream.frames) {
    seen.push(frame);

    if (stop(frame, seen)) {
      break;
    }
  }

  return seen;
}

function frames(res: IncomingMessage): AsyncIterable<Frame> {
  const queue: Frame[] = [];
  let buffer = '';
  let ended = false;
  let wake: (() => void) | undefined;

  const notify = () => {
    wake?.();
    wake = undefined;
  };

  res.setEncoding('utf8');
  res.on('data', (chunk: string) => {
    buffer += chunk;

    let at: number;

    while ((at = buffer.indexOf('\n\n')) !== -1) {
      queue.push(parse(buffer.slice(0, at)));
      buffer = buffer.slice(at + 2);
    }

    notify();
  });
  res.on('end', () => {
    ended = true;
    notify();
  });
  res.on('close', () => {
    ended = true;
    notify();
  });
  res.on('error', () => {
    ended = true;
    notify();
  });

  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = queue.shift();

        if (next !== undefined) {
          yield next;
          continue;
        }

        if (ended) {
          return;
        }

        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

function parse(block: string): Frame {
  const frame: { -readonly [K in keyof Frame]: Frame[K] } = {};
  const data: string[] = [];

  for (const line of block.split('\n')) {
    if (line.startsWith(':')) {
      frame.comment = line.slice(1);
      continue;
    }

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');

    switch (field) {
      case 'data':
        data.push(value);
        break;
      case 'event':
        frame.event = value;
        break;
      case 'id':
        frame.id = value;
        break;
      case 'retry':
        frame.retry = Number(value);
        break;
      default:
        break;
    }
  }

  if (data.length > 0) {
    frame.data = data.join('\n');
  }

  return frame;
}
