import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';

import { server } from './server';

// The default 1000ms `findBy*`/`waitFor` timeout is tuned for a dev machine running vitest
// alone. CI runs this suite in the same job as apps/api's Postgres- and Redis-backed e2e
// suites, sharing the runner's CPU; `project-page.test.tsx`'s first render has been clocked at
// 1.5-1.6s there twice in a row (35610153712) with nothing slow in the component itself — every
// test here passes locally, instantly, every time. Raised once, globally, rather than per call
// site, since the same margin applies to all 166 findBy*/waitFor uses in this suite.
configure({ asyncUtilTimeout: 5_000 });

// jsdom implements no layout, so the scroll APIs components use to keep an
// active row in view are missing rather than inert. Stub them.
Object.defineProperty(Element.prototype, 'scrollIntoView', {
  configurable: true,
  value: function scrollIntoView(): void {
    // No layout to scroll.
  },
  writable: true,
});

// `input-otp` measures its slots with a ResizeObserver, which jsdom does not implement at all.
// An observer that never fires is enough: nothing in a test depends on the measured width.
class InertResizeObserver implements ResizeObserver {
  disconnect(): void {
    // Nothing was observed.
  }

  observe(): void {
    // No layout to observe.
  }

  unobserve(): void {
    // Nothing was observed.
  }
}

Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  value: InertResizeObserver,
  writable: true,
});

// The same library hit-tests the pointer against its slots on every mouse event, and jsdom has no
// geometry to answer with. `null` is "nothing under the pointer", which is a state it handles.
Object.defineProperty(document, 'elementFromPoint', {
  configurable: true,
  value: function elementFromPoint(): Element | null {
    return null;
  },
  writable: true,
});

/**
 * jsdom implements no `EventSource` at all — checked by running jsdom 30, not recalled — so the run
 * console has nothing to open a stream with under test. This is a minimal one over `fetch`, so MSW
 * answers a stream like any other request.
 *
 * It is deliberately not a conformant implementation and must not grow into one: it exists so a
 * handler can answer `text/event-stream`, not so the browser's behaviour can be asserted. A test
 * that needs something this lacks is a test whose assertion belongs on the transcript reducer,
 * which is transport-free precisely so those guarantees can be proved without a socket.
 *
 * What it does: `GET` with credentials, SSE framing (`data:`, `id:`, `event:`, `retry:` and
 * comments), `message` events carrying `lastEventId`, `Last-Event-ID` on reconnect, a `close()`
 * that aborts the request and stops retrying, and — as the browser does — no retry at all after a
 * response that is not a `200` stream.
 *
 * ponytail: enough for the console's use and no more, on purpose. It is not conformant and must
 * not grow into one — no `withCredentials` negotiation, no BOM handling, no back-off schedule,
 * nothing about what a real browser does on a sleeping tab. Every gap is a signal, not a defect:
 * an assertion that needs one belongs on the transcript reducer, which is transport-free so that
 * it can be proved without a socket. The browser's own reconnection is verified by hand instead
 * (spec 012 SC-009, `quickstart.md` § 5).
 */
class FetchEventSource extends EventTarget {
  static readonly CLOSED = 2;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;

  readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;

  onerror: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent) => unknown) | null = null;
  onopen: ((event: Event) => unknown) | null = null;

  readyState = 0;
  readonly url: string;
  readonly withCredentials: boolean;

  /** The frame currently being accumulated, reset at every blank line. */
  #data: string[] = [];
  #eventType = 'message';
  #controller = new AbortController();
  #lastEventId = '';
  /** The `retry:` hint, seeded with the one `stream.ts` says the server opens with. */
  #retryMs = 2_000;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(url: string | URL, init: EventSourceInit = {}) {
    super();
    this.url = String(url);
    this.withCredentials = init.withCredentials ?? false;
    void this.#connect();
  }

  close(): void {
    this.readyState = this.CLOSED;
    this.#controller.abort();

    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  async #connect(): Promise<void> {
    this.#controller = new AbortController();
    this.readyState = this.CONNECTING;

    const headers = new Headers({ Accept: 'text/event-stream' });

    // The whole reason `id:` is the durable `seq` rather than a transport id: resume is a `seq`,
    // and a test that stubbed this header would prove nothing about resume.
    if (this.#lastEventId.length > 0) {
      headers.set('Last-Event-ID', this.#lastEventId);
    }

    let response: Response;

    try {
      response = await fetch(this.url, {
        credentials: 'include',
        headers,
        signal: this.#controller.signal,
      });
    } catch {
      this.#fail();

      return;
    }

    // The one place the double must match the browser, because the hook's correctness rests on
    // it: a response that is not a `200` event stream — a `204` for a run already over, a `502`
    // from a proxy mid-deploy, a `503` — *fails* the connection. `readyState` goes to `CLOSED`,
    // one `error` fires, and the browser never reconnects. Only a network error or a body that
    // ends is retried. A double that retried here too hid a hook that sat on "Reconnecting" over a
    // run that had long finished (the Stop button that never turned back into Send).
    if (!response.ok || response.status !== 200 || response.body === null) {
      this.readyState = this.CLOSED;
      this.#emit(new Event('error'), this.onerror);

      return;
    }

    this.readyState = this.OPEN;
    this.#emit(new Event('open'), this.onopen);

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += value;

        // A frame ends at a line terminator; anything after the last one is a partial line and
        // stays in the buffer until the next chunk completes it.
        let index = buffer.search(/\r\n|[\n\r]/);

        while (index !== -1) {
          const terminator = buffer.startsWith('\r\n', index) ? 2 : 1;

          this.#line(buffer.slice(0, index));
          buffer = buffer.slice(index + terminator);
          index = buffer.search(/\r\n|[\n\r]/);
        }
      }
    } catch {
      // An abort from `close()`, or the connection dropping mid-sequence — which is the case
      // story 2 is about. Both land in the same place: reconnect unless we were closed.
    }

    this.#fail();
  }

  /** Dispatch to the listeners and to the `on…` property, as the real one does to both. */
  #emit(event: Event, handler: ((event: never) => unknown) | null): void {
    this.dispatchEvent(event);
    handler?.call(this, event as never);
  }

  /** The stream ended or could not be opened: report it, then retry unless `close()` was called. */
  #fail(): void {
    if (this.readyState === this.CLOSED) {
      return;
    }

    this.readyState = this.CONNECTING;
    this.#emit(new Event('error'), this.onerror);

    this.#timer = setTimeout(() => {
      if (this.readyState !== this.CLOSED) {
        void this.#connect();
      }
    }, this.#retryMs);
  }

  #line(line: string): void {
    // A blank line ends the frame. A frame with no `data:` sets `lastEventId` and dispatches
    // nothing — which is how a bare `id:` or a `retry:` reaches the client without being an event.
    if (line.length === 0) {
      const data = this.#data;
      const type = this.#eventType;

      this.#data = [];
      this.#eventType = 'message';

      if (data.length > 0) {
        this.#emit(
          new MessageEvent(type, {
            data: data.join('\n'),
            lastEventId: this.#lastEventId,
            origin: new URL(this.url, 'http://localhost').origin,
          }),
          type === 'message' ? this.onmessage : null,
        );
      }

      return;
    }

    // `:heartbeat` and anything else beginning with a colon. The stream writes one when nothing
    // else has been, so ignoring it is load-bearing rather than tidiness.
    if (line.startsWith(':')) {
      return;
    }

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const raw = colon === -1 ? '' : line.slice(colon + 1);
    const value = raw.startsWith(' ') ? raw.slice(1) : raw;

    switch (field) {
      case 'data': {
        this.#data.push(value);
        break;
      }

      case 'event': {
        this.#eventType = value;
        break;
      }

      case 'id': {
        // The one value the spec says to ignore rather than store.
        if (!value.includes('\0')) {
          this.#lastEventId = value;
        }

        break;
      }

      case 'retry': {
        if (/^\d+$/.test(value)) {
          this.#retryMs = Number(value);
        }

        break;
      }

      default: {
        // An unknown field is ignored, per the framing rules.
        break;
      }
    }
  }
}

Object.defineProperty(globalThis, 'EventSource', {
  configurable: true,
  value: FetchEventSource,
  writable: true,
});

// `onUnhandledRequest: 'error'` is the point of using msw here rather than a fetch stub: a
// component that calls an endpoint no handler describes fails loudly, instead of quietly hanging
// on a promise that never settles and timing out with nothing to explain it.
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

// Vitest runs without `globals`, so React Testing Library cannot register its
// own auto-cleanup. Without this, rendered trees leak between test cases.
afterEach(() => {
  cleanup();
  server.resetHandlers();
  // The CSRF cookie is real state that outlives a test otherwise, and "the second test in the file
  // passes only because the first one left a token behind" is exactly the coupling msw is here to
  // prevent.
  for (const entry of document.cookie.split(';')) {
    const name = entry.split('=')[0]?.trim();

    if (name !== undefined && name.length > 0) {
      document.cookie = `${name}=; Max-Age=0; path=/`;
    }
  }
});

afterAll(() => {
  server.close();
});
