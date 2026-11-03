import type { RunEvent, RunResponse, StreamResetEvent } from '@repo/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';

import { API, server } from '@/test/server';
import { frame, sse } from '@/test/sse';
import { useRunStream } from './use-run-stream';

const ORG = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const PROJECT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const RUN = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

const RUNS = `${API}/orgs/${ORG}/projects/${PROJECT}/runs`;
const STREAM = `${RUNS}/${RUN}/stream`;
const EVENTS = `${RUNS}/${RUN}/events`;

const aRun: RunResponse = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cancelRequestedAt: null,
  contextSkips: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  endedAt: null,
  failureClass: null,
  id: RUN,
  inputTokens: 0,
  lastSeq: 0,
  model: 'claude-opus-5',
  outputTokens: 0,
  projectId: PROJECT,
  promptExcerpt: '',
  startedAt: null,
  status: 'running',
  userId: '3f2504e0-4f89-11d3-9a0c-0305e82c3302',
};

function patch(seq: number): RunEvent {
  return {
    at: '2026-01-01T00:00:00.000Z',
    data: { diff: `--- ${String(seq)}`, path: `src/${String(seq)}.ts` },
    run: RUN,
    seq,
    type: 'file.patch',
  };
}

function state(seq: number, to: 'cancelled' | 'succeeded'): RunEvent {
  return {
    at: '2026-01-01T00:00:00.000Z',
    data: { from: 'running', to },
    run: RUN,
    seq,
    type: 'state',
  };
}

/** The snapshot the stream sends when the `seq` a client resumed from has aged out. */
function reset(seq: number, events: readonly RunEvent[]): StreamResetEvent {
  return {
    at: '2026-01-01T00:00:00.000Z',
    data: { events: [...events], run: { ...aRun, lastSeq: seq } },
    run: RUN,
    seq,
    type: 'stream.reset',
  };
}

/**
 * Answer both requests the hook makes: the run record, and the stream.
 *
 * The run comes first and is not optional — its `status` is what decides whether a stream is
 * opened at all (FR-014), so a hook that streamed before reading it would open a connection to a
 * run that had already finished.
 */
function handlers(stream: Parameters<typeof http.get>[1], run: Partial<RunResponse> = {}) {
  return [
    http.get(`${RUNS}/${RUN}`, () => HttpResponse.json({ ...aRun, ...run })),
    http.get(STREAM, stream),
  ];
}

/**
 * The hook reads the run and its history through react-query (R8), so it needs a client.
 *
 * A fresh one per render, with retries off: a shared cache would let one test's run record answer
 * the next test's read, and a retried refusal would be waited through twice before a test could
 * see it.
 */
function queryWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function renderStream(runId: string | undefined = RUN) {
  return renderHook(() => useRunStream({ orgId: ORG, projectId: PROJECT, runId }), {
    wrapper: queryWrapper(),
  });
}

describe('useRunStream', () => {
  it('renders a streamed run in order', async () => {
    server.use(...handlers(() => sse([frame(patch(1)), frame(patch(2)), frame(patch(3))])));

    const { result, unmount } = renderStream();

    await waitFor(() => {
      expect(result.current.items).toHaveLength(3);
    });

    expect(result.current.items.map(({ event }) => event.seq)).toEqual([1, 2, 3]);
    expect(result.current.connection).toBe('open');
    unmount();
  });

  it('tells a subscriber about every event, in order, after the reducer', async () => {
    server.use(...handlers(() => sse([frame(patch(1)), frame(patch(2)), frame(patch(3))])));

    const seen: RunEvent[] = [];

    const { result, unmount } = renderHook(
      () =>
        useRunStream({
          onEvent: (event) => seen.push(event),
          orgId: ORG,
          projectId: PROJECT,
          runId: RUN,
        }),
      { wrapper: queryWrapper() },
    );

    await waitFor(() => {
      expect(result.current.items).toHaveLength(3);
    });

    expect(seen.map(({ seq }) => seq)).toEqual([1, 2, 3]);
    expect(seen.every(({ type }) => type === 'file.patch')).toBe(true);
    unmount();
  });

  it('parses every frame through streamEventSchema and fails on one the union does not describe', async () => {
    // The boundary FR-004 puts here: a frame the contract cannot describe is a failure, not a
    // partial render. The well-formed events around it still arrive — one bad frame must not
    // take the transcript down with it.
    server.use(
      ...handlers(() =>
        sse([frame(patch(1)), 'id: 2\ndata: {"type":"nonsense","seq":2}\n\n', frame(patch(3))]),
      ),
    );

    const { result, unmount } = renderStream();

    await waitFor(() => {
      expect(result.current.items).toHaveLength(2);
    });

    expect(result.current.items.map(({ event }) => event.seq)).toEqual([1, 3]);
    unmount();
  });

  it('closes the connection when a state event reports a terminal status', async () => {
    let opened = 0;

    server.use(
      ...handlers(() => {
        opened += 1;

        // Closing the body after a terminal state is what a real run does. If the hook did not
        // close on the event, the double would reconnect and `opened` would climb.
        return sse([frame(patch(1)), frame(state(2, 'succeeded'))], { closeAfter: true });
      }),
    );

    const { result, unmount } = renderStream();

    await waitFor(() => {
      expect(result.current.connection).toBe('closed');
    });

    const openedOnce = opened;

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(opened).toBe(openedOnce);
    unmount();
  });

  it('opens nothing until it has a run to open', () => {
    // An unhandled request fails the suite outright (`onUnhandledRequest: 'error'`), so a hook
    // that opened a stream for an undefined run would be caught here rather than in production.
    const { result, unmount } = renderStream(undefined);

    expect(result.current.connection).toBe('idle');
    expect(result.current.items).toEqual([]);
    unmount();
  });

  it('closes the connection on unmount', async () => {
    let opened = 0;

    server.use(
      ...handlers(() => {
        opened += 1;

        return sse([frame(patch(1))], { closeAfter: true });
      }),
    );

    const { result, unmount } = renderStream();

    await waitFor(() => {
      expect(result.current.items).toHaveLength(1);
    });

    unmount();
    const openedBefore = opened;

    // A stream left open after unmount reconnects forever and leaks into the next test.
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(opened).toBe(openedBefore);
  });

  it('reports the run it read, so the screen can show the model it used', async () => {
    // FR-018: the model is something the run reports, never something the console offers.
    server.use(...handlers(() => sse([])));

    const { result, unmount } = renderStream();

    await waitFor(() => {
      expect(result.current.run?.model).toBe('claude-opus-5');
    });

    unmount();
  });
});

describe('useRunStream, interrupted', () => {
  it('reconnects on its own and resumes from the last durable seq', async () => {
    // SC-003: no action by the person. The first connection drops mid-sequence; the double
    // reconnects carrying `Last-Event-ID`, which is a durable `seq` because `id:` is written
    // from one — and the server answers from there.
    const resumedFrom: (string | null)[] = [];

    server.use(
      ...handlers(({ request }) => {
        resumedFrom.push(request.headers.get('Last-Event-ID'));

        return resumedFrom.length === 1
          ? sse([frame(patch(1)), frame(patch(2)), frame(patch(3))], { closeAfter: true })
          : sse([frame(patch(4)), frame(patch(5))]);
      }),
    );

    const { result, unmount } = renderStream();

    await waitFor(() => {
      expect(result.current.items).toHaveLength(5);
    });

    // SC-002 at the transport: the union of what was rendered is the run's own sequence, each
    // event exactly once, with no gap at the seam and no duplicate across it.
    expect(result.current.items.map(({ event }) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(resumedFrom).toEqual([null, '3']);
    expect(result.current.connection).toBe('open');
    unmount();
  });

  it('continues live after a stream.reset', async () => {
    // FR-008: the resumed-from point had aged out, so the stream sends the run's snapshot
    // instead. It overlaps what is already rendered — and the seam still holds.
    server.use(
      ...handlers(() =>
        sse([frame(patch(1)), frame(reset(3, [patch(1), patch(2), patch(3)])), frame(patch(4))]),
      ),
    );

    const { result, unmount } = renderStream();

    await waitFor(() => {
      expect(result.current.items).toHaveLength(4);
    });

    expect(result.current.items.map(({ event }) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(result.current.source).toBe('live');
    unmount();
  });

  it('reports lost after the retry threshold rather than sitting silent', async () => {
    // FR-010, SC-004: a transcript that stopped receiving must not keep looking live. The first
    // connection opens and drops; every reconnect after it fails, and the hook says so rather
    // than staying in `retrying` for as long as the stream stays down.
    let opened = 0;

    server.use(
      ...handlers(() => {
        opened += 1;

        // The retry hint travels on the one connection that opens, so the reconnects that
        // follow are milliseconds apart rather than the two seconds the contract opens with.
        return opened === 1
          ? sse([frame(patch(1))], { closeAfter: true, retryMs: 5 })
          : HttpResponse.error();
      }),
    );

    const { result, unmount } = renderStream();

    await waitFor(() => {
      expect(result.current.connection).toBe('lost');
    });

    // Given up on, not still trying: a hook that reconnected forever would keep the request
    // count climbing behind a screen that says it is not receiving updates.
    const openedWhenLost = opened;

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(opened).toBe(openedWhenLost);
    // What was received before the connection went is still rendered — losing the stream is not
    // losing the transcript.
    expect(result.current.items).toHaveLength(1);
    unmount();
  });

  it('opens again when asked to retry a lost connection', async () => {
    // The one action `lost` offers. Nothing reconnects on its own past the threshold, so the
    // screen's retry control is the only way back and it has to actually open something.
    let opened = 0;

    server.use(
      ...handlers(() => {
        opened += 1;

        if (opened === 1) {
          return sse([frame(patch(1))], { closeAfter: true, retryMs: 5 });
        }

        return result.current.connection === 'lost' ? sse([frame(patch(2))]) : HttpResponse.error();
      }),
    );

    const { result, unmount } = renderStream();

    await waitFor(() => {
      expect(result.current.connection).toBe('lost');
    });

    act(() => {
      result.current.retry();
    });

    await waitFor(() => {
      expect(result.current.connection).toBe('open');
    });

    expect(result.current.items.map(({ event }) => event.seq)).toEqual([1, 2]);
    unmount();
  });

  it('reports retrying while the transport is reconnecting on its own', async () => {
    // `retrying` versus `lost` is the whole of FR-010: a stream that dropped a moment ago and is
    // coming back is not a stream that has gone. Asserted over every value the hook reported
    // rather than by sampling it — a poll that happened to land after the reconnect would pass a
    // hook that never said `retrying` at all.
    const reported: string[] = [];
    let opened = 0;

    server.use(
      ...handlers(() => {
        opened += 1;

        return opened === 1
          ? sse([frame(patch(1))], { closeAfter: true, retryMs: 20 })
          : sse([frame(patch(2))]);
      }),
    );

    const { result, unmount } = renderHook(
      () => {
        const stream = useRunStream({ orgId: ORG, projectId: PROJECT, runId: RUN });

        reported.push(stream.connection);

        return stream;
      },
      { wrapper: queryWrapper() },
    );

    await waitFor(() => {
      expect(result.current.items).toHaveLength(2);
    });

    expect(result.current.connection).toBe('open');
    expect(reported).toContain('retrying');
    // It came back on its own, so it never reached the threshold (SC-003).
    expect(reported).not.toContain('lost');
    unmount();
  });
});

describe('useRunStream, reopening a finished run', () => {
  /** A run that has ended, with `lastSeq` naming how far a reader can page. */
  const finished = (lastSeq: number): Partial<RunResponse> => ({
    endedAt: '2026-01-01T00:05:00.000Z',
    lastSeq,
    status: 'succeeded',
  });

  it("pages a finished run's history until lastSeq", async () => {
    // R6: `lastSeq` is the termination condition, so nothing has to guess whether a short page
    // means the end. Two pages here, and the hook must stop after the second rather than asking
    // for a third and discovering the end the expensive way.
    const asked: (string | null)[] = [];

    server.use(
      ...handlers(() => sse([]), finished(4)),
      http.get(EVENTS, ({ request }) => {
        const after = new URL(request.url).searchParams.get('after');

        asked.push(after);

        return HttpResponse.json({
          events: after === '2' ? [patch(3), patch(4)] : [patch(1), patch(2)],
          lastSeq: 4,
        });
      }),
    );

    const { result, unmount } = renderStream();

    await waitFor(() => {
      expect(result.current.items).toHaveLength(4);
    });

    expect(result.current.items.map(({ event }) => event.seq)).toEqual([1, 2, 3, 4]);
    // FR-011: read back, not streamed — which is what the screen says out loud.
    expect(result.current.source).toBe('history');
    expect(result.current.connection).toBe('closed');

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(asked).toEqual(['0', '2']);
    unmount();
  });

  it('opens no stream for a run that is already terminal', async () => {
    // FR-014, asserted on the absence of the request: a finished run is rebuilt from the store,
    // and a connection opened here would be one held open for a run with nothing left to send.
    let opened = 0;

    server.use(
      ...handlers(() => {
        opened += 1;

        return sse([]);
      }, finished(1)),
      http.get(EVENTS, () => HttpResponse.json({ events: [patch(1)], lastSeq: 1 })),
    );

    const { result, unmount } = renderStream();

    await waitFor(() => {
      expect(result.current.items).toHaveLength(1);
    });

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(opened).toBe(0);
    unmount();
  });

  it('terminates on an empty page rather than looping', async () => {
    // The belt to `lastSeq`'s braces (R6). A run whose events were partly trimmed never reaches
    // the `lastSeq` it advertises, and paging towards it forever would hang the screen on a run
    // that is merely incomplete.
    let pages = 0;

    server.use(
      ...handlers(() => sse([]), finished(9)),
      http.get(EVENTS, () => {
        pages += 1;

        return HttpResponse.json({ events: pages === 1 ? [patch(1), patch(2)] : [], lastSeq: 9 });
      }),
    );

    const { result, unmount } = renderStream();

    await waitFor(() => {
      expect(result.current.items).toHaveLength(2);
    });

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(pages).toBe(2);
    unmount();
  });
});
