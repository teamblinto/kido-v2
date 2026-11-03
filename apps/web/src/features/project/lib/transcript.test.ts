import type { RunEvent, RunResponse, StreamResetEvent } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import {
  applyEvent,
  applyHistory,
  applyRun,
  approvalResolutions,
  emptyTranscript,
  items,
} from './transcript';

const RUN = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

/** A durable event at `seq`, distinguishable from its neighbours by its path. */
function patch(seq: number): RunEvent {
  return {
    at: '2026-01-01T00:00:00.000Z',
    data: { diff: `--- ${String(seq)}`, path: `src/${String(seq)}.ts` },
    run: RUN,
    seq,
    type: 'file.patch',
  };
}

/** A transient event: its `seq` is the durable seq it follows, not one of its own. */
function token(seq: number, text: string): Extract<RunEvent, { type: 'token' }> {
  return { at: '2026-01-01T00:00:00.000Z', data: { text }, run: RUN, seq, type: 'token' };
}

/** The run record a snapshot carries: the reset replaces the transcript's copy with it. */
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
  projectId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
  promptExcerpt: 'ship it',
  startedAt: null,
  status: 'running',
  userId: '3f2504e0-4f89-11d3-9a0c-0305e82c3302',
};

/**
 * The snapshot the stream sends when the seq a client asked to resume from has aged out.
 *
 * Its own `seq` is the snapshot's last, which is what the transcript continues from — never the
 * count of the events it carries.
 */
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
 * A deterministic shuffle.
 *
 * Seeded rather than random: a property test that fails on one CI run in twenty and passes on
 * replay proves nothing and teaches everyone to re-run it.
 */
function shuffle(events: readonly RunEvent[]): RunEvent[] {
  const pool = [...events];
  const shuffled: RunEvent[] = [];
  // A Lehmer generator: its multiplier keeps every product inside an exact integer, so the order
  // is the same on every machine rather than the same only where the floats round alike.
  let seed = 48_611;

  while (pool.length > 0) {
    seed = (seed * 48_271) % 2_147_483_647;
    shuffled.push(...pool.splice(seed % pool.length, 1));
  }

  return shuffled;
}

/** Feed a list of events into a fresh transcript, in the order given. */
function feed(events: readonly RunEvent[]) {
  return events.reduce(applyEvent, emptyTranscript(RUN));
}

/** What the screen would actually show, as a list of identifying strings. */
function rendered(state: ReturnType<typeof feed>): string[] {
  return items(state).map(({ event }) =>
    event.type === 'token' ? `token:${event.data.text}` : `${event.type}:${String(event.seq)}`,
  );
}

describe('the durable rule', () => {
  it('renders each durable event once, in seq order', () => {
    const state = feed([patch(1), patch(2), patch(3)]);

    expect(rendered(state)).toEqual(['file.patch:1', 'file.patch:2', 'file.patch:3']);
    expect(state.highestSeq).toBe(3);
  });

  it('ignores a durable event whose seq it already holds', () => {
    // Ignored by construction rather than by a branch: the map key is the rule.
    const state = feed([patch(1), patch(2), patch(1), patch(2), patch(2)]);

    expect(rendered(state)).toEqual(['file.patch:1', 'file.patch:2']);
    expect(state.highestSeq).toBe(2);
  });

  it('inserts a late event at its place rather than appending it', () => {
    // The snapshot seam: rejecting an event below highestSeq would be the gap SC-002 forbids,
    // and appending it would be the wrong order. It belongs where its seq says.
    const state = feed([patch(1), patch(4), patch(2), patch(3)]);

    expect(rendered(state)).toEqual([
      'file.patch:1',
      'file.patch:2',
      'file.patch:3',
      'file.patch:4',
    ]);
    expect(state.highestSeq).toBe(4);
  });

  it('advances highestSeq only on durable events', () => {
    const state = feed([patch(1), token(1, 'a'), token(1, 'b'), patch(2), token(2, 'c')]);

    expect(state.highestSeq).toBe(2);
  });

  it('leaves the state it was given untouched', () => {
    // Every function returns new state. A reducer that mutated would make React's identity check
    // miss the change, which fails as "the transcript stopped updating" rather than as a bug here.
    const before = feed([patch(1)]);
    const after = applyEvent(before, patch(2));

    expect(before.durable.size).toBe(1);
    expect(after.durable.size).toBe(2);
    expect(after).not.toBe(before);
  });
});

describe('the transient rule', () => {
  it('keeps every transient event that shares one seq', () => {
    // The bug this rule exists to prevent (R3). A seq-based ignore test would render 'a' and
    // silently drop the other nineteen tokens — every message after its first word.
    const tokens = Array.from({ length: 20 }, (_, index) => token(7, `t${String(index)}`));
    const state = feed([patch(7), ...tokens]);

    expect(rendered(state)).toEqual([
      'file.patch:7',
      ...tokens.map((event) => `token:${event.data.text}`),
    ]);
  });

  it('never advances highestSeq on a transient event', () => {
    // A transient seq is the durable seq it follows. Advancing on one would ask the server to
    // resume from a place the run has not reached.
    const state = feed([patch(1), token(9, 'a'), token(9, 'b')]);

    expect(state.highestSeq).toBe(1);
  });

  it('orders transient items after the durable event whose seq they carry', () => {
    const state = feed([patch(1), patch(2), token(1, 'a'), token(2, 'b'), token(1, 'c')]);

    expect(rendered(state)).toEqual([
      'file.patch:1',
      'token:a',
      'token:c',
      'file.patch:2',
      'token:b',
    ]);
  });

  it('renders a transient event that arrived before the durable one it follows', () => {
    // The stream files a token under a seq the client may not hold yet. Dropping it would lose
    // the agent's output; it renders in its place once the durable event lands.
    const state = feed([token(2, 'a'), patch(1), patch(2)]);

    expect(rendered(state)).toEqual(['file.patch:1', 'file.patch:2', 'token:a']);
  });

  it('never writes a transient event into the durable map', () => {
    const state = feed([token(1, 'a')]);

    expect(state.durable.size).toBe(0);
    expect(state.transient).toHaveLength(1);
  });
});

describe('the run record', () => {
  /** The run saying so itself: `to` is the status the contract names. */
  function ended(seq: number): RunEvent {
    return {
      at: '2026-01-01T00:00:00.000Z',
      data: { from: 'running', to: 'cancelled' },
      run: RUN,
      seq,
      type: 'state',
    };
  }

  it('follows the status a state event reports', () => {
    // Otherwise the record says `running` until somebody reads the run again, and a run that has
    // just said it was cancelled goes on offering a stop control (FR-013).
    const state = applyEvent(applyRun(emptyTranscript(RUN), aRun), ended(1));

    expect(state.run?.status).toBe('cancelled');
  });

  it('has nothing to follow before the run has been read', () => {
    const state = applyEvent(emptyTranscript(RUN), ended(1));

    expect(state.run).toBeUndefined();
  });

  it('leaves the record alone for an event that is not a state', () => {
    const state = applyEvent(applyRun(emptyTranscript(RUN), aRun), patch(1));

    expect(state.run).toBe(aRun);
  });
});

describe('a history page', () => {
  it('inserts each event by the durable rule and marks the transcript as read', () => {
    const state = applyHistory(emptyTranscript(RUN), [patch(1), patch(2), patch(1)]);

    expect(rendered(state)).toEqual(['file.patch:1', 'file.patch:2']);
    expect(state.highestSeq).toBe(2);
    expect(state.source).toBe('history');
  });
});

describe('every item', () => {
  it('carries a key that is stable across redelivery', () => {
    // React needs a key that does not move when the same event arrives twice, or the list
    // re-mounts and the transcript visibly flickers on every reconnect.
    const first = items(feed([patch(1), patch(2), token(1, 'a')])).map((item) => item.id);
    const again = items(feed([patch(2), patch(1), patch(2), token(1, 'a')])).map((item) => item.id);

    expect(first).toEqual(again);
    expect(new Set(first).size).toBe(first.length);
  });
});

describe('the snapshot seam', () => {
  it('replaces the transcript from a stream.reset rather than merging into it', () => {
    // R5: the snapshot is authoritative and complete up to its own seq, so a merge can only
    // reproduce it or corrupt it. What the client held before is discarded, not reconciled.
    const state = applyEvent(feed([patch(1), patch(9)]), reset(3, [patch(1), patch(2), patch(3)]));

    expect(rendered(state)).toEqual(['file.patch:1', 'file.patch:2', 'file.patch:3']);
    expect(state.highestSeq).toBe(3);
    expect(state.run?.id).toBe(RUN);
  });

  it('renders no event twice when a snapshot overlaps what is already rendered', () => {
    // The seam SC-002 tests hardest: the snapshot covers ground the live stream already
    // delivered, and the live events after it continue from the snapshot's seq.
    const state = [patch(4), patch(5)].reduce(
      applyEvent,
      applyEvent(feed([patch(1), patch(2), patch(3)]), reset(3, [patch(1), patch(2), patch(3)])),
    );

    expect(rendered(state)).toEqual([
      'file.patch:1',
      'file.patch:2',
      'file.patch:3',
      'file.patch:4',
      'file.patch:5',
    ]);
    expect(state.highestSeq).toBe(5);
  });

  it('clears transient items on a reset', () => {
    // R3 and R5 together: tokens are not in the snapshot, because the store never held them.
    // Keeping the ones rendered before the reset would leave a run's words under events the
    // snapshot has since replaced.
    const state = applyEvent(
      feed([patch(1), token(1, 'a'), token(1, 'b')]),
      reset(2, [patch(1), patch(2)]),
    );

    expect(state.transient).toEqual([]);
    expect(rendered(state)).toEqual(['file.patch:1', 'file.patch:2']);
  });

  it('continues live after a reset', () => {
    // A snapshot arrives on the live stream, so what follows it is still live (FR-011).
    const state = applyEvent(applyHistory(emptyTranscript(RUN), [patch(1)]), reset(1, [patch(1)]));

    expect(state.source).toBe('live');
  });
});

describe('the property SC-002 rests on', () => {
  it('renders the same transcript for any delivery order', () => {
    // The assertion that does not depend on the test double. Whatever a transport does to the
    // order — a reconnect replaying, a snapshot overlapping, a frame arriving twice — the
    // transcript it produces is the one the run recorded. Transients are set aside because
    // their order is their arrival order by construction (R3), not their seq.
    const run = [1, 2, 3, 4, 5, 6, 7, 8].map((seq) => patch(seq));
    const inOrder = rendered(feed(run));

    const deliveries: Record<string, RunEvent[]> = {
      'in order': [...run],
      reversed: [...run].reverse(),
      shuffled: shuffle(run),
      'shuffled, with repeats': shuffle([...run, ...run, ...shuffle(run)]),
      'reversed, every event twice': [...run].reverse().flatMap((event) => [event, event]),
    };

    for (const [delivery, events] of Object.entries(deliveries)) {
      expect(rendered(feed(events)), delivery).toEqual(inOrder);
    }
  });
});

/** Spec 040: a local agent's permission requests, and what answered them. */
describe('approvalResolutions', () => {
  function approval(seq: number, requestId: string): RunEvent {
    return {
      at: '2026-01-01T00:00:00.000Z',
      data: { detail: 'rm -rf dist', kind: 'command', requestId, title: 'Run rm' },
      run: RUN,
      seq,
      type: 'approval.request',
    };
  }

  function resolution(seq: number, requestId: string): RunEvent {
    return {
      at: '2026-01-01T00:00:00.000Z',
      data: { by: 'timeout', decision: 'deny', requestId },
      run: RUN,
      seq,
      type: 'approval.resolved',
    };
  }

  it('keeps both events durable and maps only the answered request', () => {
    const state = [approval(1, 'a'), approval(2, 'b'), resolution(3, 'a')].reduce(
      applyEvent,
      emptyTranscript(RUN),
    );

    const resolved = approvalResolutions(items(state));

    expect(items(state)).toHaveLength(3);
    expect(resolved.get('a')?.data).toEqual({ by: 'timeout', decision: 'deny', requestId: 'a' });
    expect(resolved.has('b')).toBe(false);
  });

  it('settles a request from history as it does from the stream, redelivery included', () => {
    const state = applyHistory(emptyTranscript(RUN), [
      approval(1, 'a'),
      resolution(2, 'a'),
      resolution(2, 'a'),
    ]);

    expect(approvalResolutions(items(state)).size).toBe(1);
    expect(items(state)).toHaveLength(2);
  });
});
