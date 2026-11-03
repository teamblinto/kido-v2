import {
  DURABLE_RUN_EVENT_TYPES,
  type DurableRunEvent,
  type RunEvent,
  type RunResponse,
  type StreamEvent,
  type StreamResetEvent,
} from '@repo/contracts';

/**
 * The transcript, as a reducer over the run's events.
 *
 * Pure: no React, no transport, no clock. That is what makes it the place every ordering and
 * de-duplication guarantee lives (R2). A guarantee proved here needs no `EventSource`, no MSW and
 * no component, so the test double's fidelity never becomes load-bearing — which matters because
 * the double is deliberately not a conformant `EventSource`.
 *
 * Every function is total and returns new state; none mutates its argument.
 *
 * ponytail: a `Map` keyed by `seq` and an append-only list of transient items, rendered whole.
 * The transcript does not virtualise, so a run of tens of thousands of events renders every one
 * of them into the DOM. The ceiling is deliberate — windowing is a different component with a
 * different scroll story, and it belongs to 022 with the rest of the product surface.
 */

const DURABLE = new Set<string>(DURABLE_RUN_EVENT_TYPES);

function isDurable(event: RunEvent): event is DurableRunEvent {
  return DURABLE.has(event.type);
}

/** What the transport is doing. `retrying` versus `lost` is what stops a stall looking live. */
export type Connection = 'closed' | 'idle' | 'lost' | 'open' | 'retrying';

/** Whether the transcript is being streamed or was read back from the store (FR-011). */
export type TranscriptSource = 'history' | 'live';

/** A transient event with the arrival order it must keep — many share one `seq`. */
interface TransientEntry {
  readonly event: RunEvent;
  /** Monotonic across the transcript's life, so an item's key never moves. */
  readonly arrival: number;
}

export interface TranscriptState {
  readonly connection: Connection;
  /** Durable events by `seq`. The map **is** the de-duplication rule. */
  readonly durable: ReadonlyMap<number, DurableRunEvent>;
  /** Highest durable `seq` accepted; `0` before the first. What resume continues from. */
  readonly highestSeq: number;
  readonly run: RunResponse | undefined;
  readonly runId: string;
  readonly source: TranscriptSource;
  readonly transient: readonly TransientEntry[];
}

/** One rendered entry. `id` is stable across redelivery, so React never re-mounts the list. */
export interface TranscriptItem {
  readonly event: RunEvent;
  readonly id: string;
}

export function emptyTranscript(runId: string): TranscriptState {
  return {
    connection: 'idle',
    durable: new Map(),
    highestSeq: 0,
    run: undefined,
    runId,
    source: 'live',
    transient: [],
  };
}

/**
 * Take one durable event.
 *
 * `set` on a `Map` keyed by `seq` is the whole rule: a redelivery overwrites an identical entry
 * and changes nothing, and a late arrival below `highestSeq` is filled in at its place rather than
 * rejected. Rejecting it would be the gap SC-002 forbids.
 */
function takeDurable(state: TranscriptState, event: DurableRunEvent): TranscriptState {
  const durable = new Map(state.durable);

  durable.set(event.seq, event);

  return {
    ...state,
    durable,
    highestSeq: Math.max(state.highestSeq, event.seq),
    // A `state` event is the run reporting its own status, so the run record follows it. Without
    // this the record would say `running` until somebody read the run again, and a run that had
    // just said it was cancelled would still be offering a stop control (FR-013). `to` is the
    // status the contract names, so this is the run's word taken at face value, not an inference.
    run:
      state.run !== undefined && event.type === 'state'
        ? { ...state.run, status: event.data.to }
        : state.run,
  };
}

/**
 * Take the snapshot the stream sends when the `seq` asked for has aged out.
 *
 * It replaces; it never merges (R5). The snapshot is authoritative and complete up to its own
 * `seq`, so a merge could only reproduce it or corrupt it — and the seam between a snapshot and
 * the live events that follow is exactly where SC-002 is hardest to hold. Replacing is the
 * version that is obviously correct there.
 *
 * Three consequences worth naming, because each is a test: the transcript continues from the
 * snapshot's own `seq` rather than from the count of events it carries; transient items are
 * dropped with what they annotated, since the store never held them to send back (R3); and the
 * transcript is live again, because a snapshot arrives *on* the live stream — it is the stream
 * catching the client up, not a stored record being read (FR-011).
 */
function applyReset(state: TranscriptState, event: StreamResetEvent): TranscriptState {
  const durable = new Map<number, DurableRunEvent>();

  for (const carried of event.data.events) {
    // The contract refines the snapshot's events to the durable variants, but a refinement is not
    // a narrowing: the guard is what makes them durable to the compiler as well as to the server.
    if (isDurable(carried)) {
      durable.set(carried.seq, carried);
    }
  }

  return {
    ...state,
    durable,
    highestSeq: event.seq,
    run: event.data.run,
    source: 'live',
    transient: [],
  };
}

/**
 * Fold one event in, by whichever of the two rules applies to it.
 *
 * The distinction is the load-bearing one in this feature, and it is not what FR-009 reads like
 * at first glance: a transient event's `seq` is the durable seq it *follows*, not its own, so many
 * legitimately share one value. Testing those against `highestSeq` would render the first token of
 * every message and silently drop the rest (R3).
 */
export function applyEvent(state: TranscriptState, event: StreamEvent): TranscriptState {
  if (event.type === 'stream.reset') {
    return applyReset(state, event);
  }

  if (isDurable(event)) {
    return takeDurable(state, event);
  }

  return {
    ...state,
    transient: [...state.transient, { arrival: state.transient.length, event }],
  };
}

/**
 * Fold in a page of history.
 *
 * Every event by the durable rule — the store only ever held durable ones — and the transcript is
 * marked as read back rather than streamed, which is the distinction FR-011 shows.
 */
export function applyHistory(state: TranscriptState, events: readonly RunEvent[]): TranscriptState {
  const next = events.reduce<TranscriptState>(
    (current, event) => (isDurable(event) ? takeDurable(current, event) : current),
    state,
  );

  return { ...next, source: 'history' };
}

/** The run's own record: status, model, `lastSeq`. Replaced wholesale; never merged field-wise. */
export function applyRun(state: TranscriptState, run: RunResponse): TranscriptState {
  return { ...state, run };
}

export function setConnection(state: TranscriptState, connection: Connection): TranscriptState {
  return { ...state, connection };
}

/**
 * What the screen renders: durable events by `seq` ascending, each followed by the transient
 * items carrying that `seq`.
 *
 * Derived rather than stored, so there is one ordering rule rather than one per writer. A
 * transient event whose durable event has not arrived yet still renders — at the place its `seq`
 * names — because dropping it would lose the agent's output rather than merely reorder it.
 */
export function items(state: TranscriptState): TranscriptItem[] {
  const bySeq = new Map<number, TransientEntry[]>();

  for (const entry of state.transient) {
    const existing = bySeq.get(entry.event.seq);

    if (existing === undefined) {
      bySeq.set(entry.event.seq, [entry]);
    } else {
      existing.push(entry);
    }
  }

  const seqs = [...new Set([...state.durable.keys(), ...bySeq.keys()])].sort((a, b) => a - b);
  const rendered: TranscriptItem[] = [];

  for (const seq of seqs) {
    const event = state.durable.get(seq);

    if (event !== undefined) {
      rendered.push({ event, id: `d-${String(seq)}` });
    }

    for (const entry of bySeq.get(seq) ?? []) {
      rendered.push({ event: entry.event, id: `t-${String(entry.arrival)}` });
    }
  }

  return rendered;
}

export type ApprovalResolution = Extract<RunEvent, { type: 'approval.resolved' }>;

/**
 * Each answered `approval.request`, by `requestId` (spec 040). A request absent here is still
 * pending. Derived from the rendered items, like a tool's end, so a snapshot or a history read
 * settles a card exactly as the live stream does.
 */
export function approvalResolutions(
  rendered: readonly TranscriptItem[],
): ReadonlyMap<string, ApprovalResolution> {
  const resolved = new Map<string, ApprovalResolution>();

  for (const { event } of rendered) {
    if (event.type === 'approval.resolved') resolved.set(event.data.requestId, event);
  }

  return resolved;
}
