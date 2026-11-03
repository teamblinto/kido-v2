import type { StreamEvent } from '@repo/contracts';

/**
 * Turning a list of events into a `text/event-stream` response, so a handler can answer the run
 * console's stream with the contract's own shapes rather than with hand-written text.
 *
 * Every frame is written with `id:` set from the event's `seq` — never a transport id, which is
 * what `stream.ts` promises and what makes `Last-Event-ID` on a reconnect a `seq` the server can
 * resume from. Stubbing that header instead would leave resume untested at the one seam story 2
 * is about.
 */

/** One already-serialised frame, terminated by the blank line that ends it. */
export type Frame = string;

/**
 * A frame carrying one stream event, filed under its own `seq` and named by its type — exactly
 * what `run-stream-reader.ts` writes. The name matters: a real `EventSource` delivers a named
 * frame only to `addEventListener(name)`, never to `onmessage`, and the double is as strict.
 */
export function frame(event: StreamEvent): Frame {
  return `event: ${event.type}\nid: ${String(event.seq)}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** A comment frame: the stream writes one when nothing else has been. */
export function heartbeat(): Frame {
  return ':heartbeat\n\n';
}

interface SseOptions {
  /**
   * Whether to close the stream once the frames are written.
   *
   * `false` — the default — leaves it open, which is a run still in progress. `true` closes it
   * mid-sequence, which is the drop the resume story is about: the client sees the end of the
   * body, reconnects with `Last-Event-ID`, and the next handler answers from there.
   */
  readonly closeAfter?: boolean;
  /** The `retry:` hint to open with. Low by default, so a test's reconnect is not a two-second wait. */
  readonly retryMs?: number;
}

/**
 * An SSE response for MSW.
 *
 * Left open unless `closeAfter` says otherwise, because a stream that ends is a stream the client
 * is right to reconnect to — and a handler that closed by accident would look like a bug in the
 * hook rather than in the test.
 */
export function sse(frames: readonly Frame[], options: SseOptions = {}): Response {
  const { closeAfter = false, retryMs = 10 } = options;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();

      controller.enqueue(encoder.encode(`retry: ${String(retryMs)}\n\n`));

      for (const written of frames) {
        controller.enqueue(encoder.encode(written));
      }

      if (closeAfter) {
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: {
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream',
    },
  });
}
