import {
  DURABLE_RUN_EVENT_TYPES,
  type RunEvent,
  STREAM_EVENT_TYPES,
  type StreamEvent,
  streamEventSchema,
} from '@repo/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { getRun, getRunEvents, runStreamUrl } from '../api';
import { isTerminal } from '../lib/run-phase';
import {
  type Connection,
  type TranscriptItem,
  type TranscriptState,
  applyEvent,
  applyHistory,
  applyRun,
  emptyTranscript,
  items as renderItems,
  setConnection,
} from '../lib/transcript';

interface UseRunStreamOptions {
  /**
   * Told about every event the transcript accepts that is new since the connection opened, in
   * order, after the reducer has applied it. A replayed durable event — `seq` at or below the run
   * record's `lastSeq` when the stream connected — reaches the transcript but not this.
   *
   * Additive only (FR-025): a subscriber is a second reader of the one stream, never a second
   * writer of the transcript, so nothing it does can change what is on screen. Held in a ref so a
   * caller passing an inline function does not reopen the connection on every render.
   */
  readonly onEvent?: (event: RunEvent) => void;
  readonly orgId: string | undefined;
  readonly projectId: string | undefined;
  /** Undefined while the run on screen is still being decided. Nothing is opened for it. */
  readonly runId: string | undefined;
}

/**
 * How many consecutive failed connections are a stream that has gone rather than one that is
 * coming back.
 *
 * Three rather than one because a single drop is ordinary — a laptop lid, a proxy recycling, a
 * deploy — and calling that "not receiving updates" would teach people to ignore the words. Three
 * rather than ten because at `STREAM_RETRY_MS` apart, ten is most of a minute of a stalled
 * transcript presented as a live one, which is precisely what FR-010 forbids. A successful open
 * resets the count: the threshold is about a stream that will not come back, not about how many
 * times it has ever dropped.
 */
const RETRY_LIMIT = 3;

/**
 * How long after the browser *closed* a stream (a non-`200` answer: `204`, `502`, `503`) the hook
 * opens one itself, doubling per consecutive failure up to `REOPEN_MAX_MS`.
 *
 * The browser retries only a dropped connection, never a refused one, so without this a stream
 * that met one `502` during a deploy stayed shut for good — and the run it was watching went on to
 * finish unseen, leaving Stop on screen over a run that was over.
 */
export const REOPEN_BASE_MS = 1_000;
const REOPEN_MAX_MS = 15_000;

/**
 * How often a live run's record is read again while the stream is open, and while it is not.
 *
 * The record is the authority on status (it is the row the worker transitions), and the stream is
 * only the fast path to it. Reading it on an interval is what guarantees the screen converges on
 * the truth whatever went wrong between them: a terminal frame lost to a proxy, a reconnect the
 * browser refused, a stream given up on. One row, by primary key — cheap enough to do while
 * someone is watching, and `transcript.ts` keeps an older record from ever undoing a newer event.
 */
export const RECONCILE_LIVE_MS = 20_000;
export const RECONCILE_DETACHED_MS = 4_000;

const DURABLE_TYPES = new Set<string>(DURABLE_RUN_EVENT_TYPES);

export interface RunStream {
  readonly connection: Connection;
  /**
   * The refusal from reading the run or its history, for the screen to put a sentence to.
   *
   * Reported rather than handled here: `MESSAGES` is exhaustive and the screen already renders
   * through it, so a hook that invented its own wording would be writing a second catalogue
   * (FR-021, R7).
   */
  readonly error: Error | null;
  readonly items: readonly TranscriptItem[];
  readonly run: TranscriptState['run'];
  readonly source: TranscriptState['source'];
  /** Open again after the connection was given up on — the one action `lost` offers. */
  retry: () => void;
}

/** Every write to the transcript goes through `transcript.ts`; this is the only door. */
type Action =
  | { readonly kind: 'connection'; readonly connection: Connection }
  | { readonly kind: 'event'; readonly event: StreamEvent }
  | { readonly kind: 'history'; readonly events: readonly RunEvent[] }
  | { readonly kind: 'reset'; readonly runId: string }
  | { readonly kind: 'run'; readonly run: NonNullable<TranscriptState['run']> };

function reduce(state: TranscriptState, action: Action): TranscriptState {
  switch (action.kind) {
    case 'connection': {
      return setConnection(state, action.connection);
    }

    case 'event': {
      return applyEvent(state, action.event);
    }

    case 'history': {
      return applyHistory(state, action.events);
    }

    case 'reset': {
      return emptyTranscript(action.runId);
    }

    case 'run': {
      return applyRun(state, action.run);
    }
  }
}

/** One frame's `data`, or nothing at all if it is not an event this contract describes. */
function parseFrame(data: string): StreamEvent | undefined {
  let payload: unknown;

  try {
    payload = JSON.parse(data);
  } catch {
    // Not JSON at all. The same answer as a frame the union rejects: it is not an event.
    return undefined;
  }

  const parsed = streamEventSchema.safeParse(payload);

  return parsed.success ? parsed.data : undefined;
}

/**
 * Rebuild a finished run from the store, a page at a time.
 *
 * Two termination conditions, and both are load-bearing (R6). `lastSeq` is the run's own account
 * of how far a reader can page, so nothing has to guess whether a short page means the end. An
 * empty page is the belt to that braces: a run whose events were partly trimmed never reaches the
 * `lastSeq` it advertises, and paging towards it forever would hang the screen on a run that is
 * merely incomplete rather than broken.
 *
 * Each page goes through the same reducer the live stream feeds, so a run read back is de-duplicated
 * and ordered by exactly the rules a run watched live is — there is no second implementation of
 * SC-002 hiding in the history path.
 */
async function readHistory(
  orgId: string,
  projectId: string,
  runId: string,
  signal: AbortSignal,
): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  let after = 0;

  for (;;) {
    // No `catch`: a refusal is the query's to carry, so it reaches the screen and is rendered
    // through the catalogue like every other one (FR-021) — and an `unauthorized` reaches the
    // client's session reaction, which is what keeps an expired session from surfacing as a
    // stream failure (FR-023).
    const page = await getRunEvents(orgId, projectId, runId, { after }, signal);

    if (page.events.length === 0) {
      return events;
    }

    events.push(...page.events);

    const highest = Math.max(...page.events.map((event) => event.seq));

    // A page that cannot advance the cursor would be asked for again, identically, forever.
    if (highest <= after || highest >= page.lastSeq) {
      return events;
    }

    after = highest;
  }
}

/**
 * One `EventSource` and one transcript, for the run on screen.
 *
 * The division of labour is research R2's: the transport opens, delivers and reconnects, and
 * every guarantee about ordering and de-duplication belongs to `transcript.ts`, which is pure.
 * Nothing here writes to the transcript except through that module.
 *
 * The run record is read before anything is opened, because its `status` decides whether a stream
 * should be opened at all: a run that has already finished is rebuilt from history and gets no
 * connection (FR-014).
 */
export function useRunStream({ onEvent, orgId, projectId, runId }: UseRunStreamOptions): RunStream {
  const [transcript, dispatch] = useReducer(reduce, emptyTranscript(runId ?? ''));
  const [attempt, setAttempt] = useState(0);

  // Consecutive failed connections, across the reopens this hook makes itself (each reopen is a
  // fresh `EventSource`, so a counter local to one would never reach the limit). A successful open
  // and a change of run reset it.
  const failures = useRef(0);

  useEffect(() => {
    failures.current = 0;
  }, [runId]);

  const subscriber = useRef(onEvent);

  // Assigned in an effect, not during render: a render can be discarded or replayed, and a ref
  // written then would outlive it. The stream effect reads this ref, never `onEvent`, so a caller
  // passing a fresh closure each render never reopens the connection.
  useEffect(() => {
    subscriber.current = onEvent;
  });

  const retry = useCallback(() => {
    failures.current = 0;
    setAttempt((value) => value + 1);
  }, []);

  // A change of run discards everything: a transcript is only ever about one run, and carrying an
  // event across would render one run's work under another's name.
  useEffect(() => {
    dispatch({ kind: 'reset', runId: runId ?? '' });
  }, [runId]);

  /*
   * Reading the run, and only then deciding whether to open anything.
   *
   * Through react-query like every other request this console makes (R8), which is not
   * bookkeeping: the client is where the application's single reaction to a dead session lives,
   * so a run read refused with `unauthorized` ends in the sign-in redirect rather than in this
   * screen reporting that a stream broke (FR-023). Only the stream itself stays outside — a
   * subscription is not a query.
   */
  const canRead = orgId !== undefined && projectId !== undefined && runId !== undefined;
  const queryClient = useQueryClient();

  // What the transport is doing, read by the record's refetch interval without re-creating it.
  const connectionRef = useRef<Connection>(transcript.connection);

  useEffect(() => {
    connectionRef.current = transcript.connection;
  });

  const runQuery = useQuery({
    enabled: canRead,
    queryFn: ({ signal }) => getRun(orgId ?? '', projectId ?? '', runId ?? '', signal),
    queryKey: ['run', orgId, projectId, runId],
    // Reconciliation (see `RECONCILE_LIVE_MS`): while the record says the run is still going, it
    // is read again — often when the stream is not delivering, rarely when it is. A terminal
    // record stops it.
    refetchInterval: (query) => {
      const status = query.state.data?.status;

      if (status !== undefined && isTerminal(status)) return false;

      return connectionRef.current === 'open' ? RECONCILE_LIVE_MS : RECONCILE_DETACHED_MS;
    },
    // A cached record may be minutes old by the time this screen shows the run again; the status
    // it carries decides whether a stream opens, so it is always checked on mount.
    staleTime: 0,
  });

  const runRecord = runQuery.data;
  const refetchRun = useRef(runQuery.refetch);

  useEffect(() => {
    refetchRun.current = runQuery.refetch;
  });

  useEffect(() => {
    if (runRecord !== undefined) {
      dispatch({ kind: 'run', run: runRecord });
    }
  }, [runRecord]);

  // The run record's `lastSeq`, read by the stream effect when it connects without reopening it.
  const knownSeq = useRef(0);

  useEffect(() => {
    knownSeq.current = transcript.run?.lastSeq ?? 0;
  });

  const status = transcript.run?.status;
  const isFinished = status !== undefined && isTerminal(status);
  const isKnown = status !== undefined;

  // A finished run is read from the store, in pages, and gets no connection (FR-014, R6).
  const historyQuery = useQuery({
    enabled: canRead && isFinished,
    queryFn: ({ signal }) => readHistory(orgId ?? '', projectId ?? '', runId ?? '', signal),
    queryKey: ['run-events', orgId, projectId, runId],
  });

  const historyEvents = historyQuery.data;

  useEffect(() => {
    if (historyEvents !== undefined) {
      dispatch({ kind: 'history', events: historyEvents });
    }
  }, [historyEvents]);

  useEffect(() => {
    if (orgId === undefined || projectId === undefined || runId === undefined) {
      return;
    }

    // Nothing to open yet (the run has not been read) or nothing to open at all (it has ended).
    if (!isKnown) {
      return;
    }

    if (isFinished) {
      dispatch({ kind: 'connection', connection: 'closed' });

      return;
    }

    // A fresh connection replays the run from seq 1. What the run record already counted is not
    // news, so the subscriber hears only durable events newer than that — a replayed checkpoint
    // reloading the preview was the second preview load on every page open (spec 043).
    const knownThrough = knownSeq.current;
    const isNews = (event: RunEvent): boolean =>
      !DURABLE_TYPES.has(event.type) || event.seq > knownThrough;

    const source = new EventSource(runStreamUrl(orgId, projectId, runId));

    /*
     * Consecutive failures since the last successful open.
     *
     * The transport reconnects by itself — that is `EventSource`'s job and the whole of SC-003 —
     * so what is counted here is not "should we retry" but "is anyone still receiving". Until the
     * threshold the connection is `retrying`, which the screen shows quietly; past it the stream
     * is given up on and reported `lost`, because a transcript that stopped receiving must not
     * keep looking live (FR-010, SC-004). `retry()` is what opens one again.
     */
    let reopen: ReturnType<typeof setTimeout> | undefined;

    source.onopen = () => {
      failures.current = 0;
      dispatch({ kind: 'connection', connection: 'open' });
    };

    source.onerror = () => {
      failures.current += 1;
      // Whatever broke, the record knows whether the run is still going. A run that ended while
      // the stream was down resolves from it — the stream effect sees a terminal status and stops
      // — instead of waiting on a stream that may never come back.
      void refetchRun.current();

      if (failures.current >= RETRY_LIMIT) {
        // Closing is part of saying `lost`: a screen that reads "not receiving updates" over a
        // transport still hammering the server every two seconds is telling the person one thing
        // and the server another. The record goes on being read (`RECONCILE_DETACHED_MS`), so the
        // status still settles.
        source.close();
        dispatch({ kind: 'connection', connection: 'lost' });

        return;
      }

      dispatch({ kind: 'connection', connection: 'retrying' });

      // A dropped connection the browser retries by itself. A *refused* one (`readyState` is
      // `CLOSED`: a `204`, a `502` from a proxy mid-deploy, a `503`) it never retries, so the hook
      // does, after a back-off — by which time the record read above has usually said whether
      // there is anything left to open for.
      if (source.readyState === EventSource.CLOSED) {
        const delay = Math.min(REOPEN_BASE_MS * 2 ** (failures.current - 1), REOPEN_MAX_MS);

        reopen = setTimeout(() => {
          setAttempt((value) => value + 1);
        }, delay);
      }
    };

    // Every frame the server writes is named (`event: <type>`), and a named frame reaches only a
    // listener registered under that name — `onmessage` would hear nothing, and a run's terminal
    // `state` would never close the connection (found by the by-hand walk, 012 SC-009).
    const onFrame = (message: MessageEvent<string>) => {
      // FR-004: the union is the boundary, and it is crossed exactly once — here. A frame it
      // cannot describe never reaches the reducer, so the transcript can hold nothing the
      // contract does not describe, and everything downstream is typed rather than sniffed.
      const parsed = parseFrame(message.data);

      if (parsed === undefined) {
        return;
      }

      dispatch({ kind: 'event', event: parsed });

      // After the reducer, and only for the events the transcript itself holds — a `stream.reset`
      // is a snapshot of the run, not an event of it, and its contents reach the subscriber as
      // the events they are.
      if (parsed.type === 'stream.reset') {
        for (const event of parsed.data.events) {
          if (isNews(event)) subscriber.current?.(event);
        }
      } else if (isNews(parsed)) {
        subscriber.current?.(parsed);
      }

      // Closing on the run's own word rather than on the server hanging up. The terminal `state`
      // event is the run saying it is done; waiting for the socket instead would leave the double
      // — and a real browser — reconnecting to a run with nothing left to send.
      if (parsed.type === 'state' && isTerminal(parsed.data.to)) {
        source.close();
        dispatch({ kind: 'connection', connection: 'closed' });
        // The record carries what the event does not — `endedAt` for "Worked for", the final
        // token counts — and the run list's chip reads the list query, not this transcript.
        void queryClient.invalidateQueries({ queryKey: ['run', orgId, projectId, runId] });
        void queryClient.invalidateQueries({ queryKey: ['runs', orgId, projectId, 'list'] });
      }
    };

    for (const type of STREAM_EVENT_TYPES) {
      source.addEventListener(type, onFrame);
    }

    return () => {
      if (reopen !== undefined) clearTimeout(reopen);
      source.close();
    };
    // Keyed on known/finished, never on `status` itself: a fresh connection replays the run from
    // seq 1, its `state` events walk `status` through queued → … → awaiting_input, and reopening on
    // each step replays again — a reconnect storm that also remounted the preview every replay.
  }, [orgId, projectId, runId, isKnown, isFinished, attempt, queryClient]);

  /*
   * Coming back: the network returned, or the tab is visible again after the laptop slept. A
   * stream given up on is opened again without waiting for the person to press "Try again", and
   * the record is read at once — the run may have finished while nobody was looking.
   */
  const connection = transcript.connection;

  useEffect(() => {
    if (!canRead || isFinished) return;

    const onReturn = () => {
      if (document.visibilityState === 'hidden') return;

      void refetchRun.current();

      if (connection === 'lost') {
        failures.current = 0;
        setAttempt((value) => value + 1);
      }
    };

    window.addEventListener('online', onReturn);
    document.addEventListener('visibilitychange', onReturn);

    return () => {
      window.removeEventListener('online', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [canRead, connection, isFinished]);

  const rendered = useMemo(() => renderItems(transcript), [transcript]);

  return {
    connection: transcript.connection,
    error: runQuery.error ?? historyQuery.error,
    items: rendered,
    retry,
    run: transcript.run,
    source: transcript.source,
  };
}
