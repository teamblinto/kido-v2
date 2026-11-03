import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeClock } from '../../common/clock/fake-clock';
import type { TenantTransaction } from '../../database/database.types';
import { DEFAULT_AGENT_TIMINGS } from './agent.constants';
import { type BatcherTimer, EventBatcher, IllegalEventError } from './event-batcher';
import type { EmittedEvent } from './run-executor.port';
import { FencedError, type RunEventInput, type RunStore } from './run-store';
import type { RunStreamPublisher } from './run-stream-publisher';

const START = '2026-09-14T10:00:00.000Z';
const FENCE = { epoch: 1, orgId: 'org', runId: 'run' };

/** The store as the batcher sees it: two statements per flush, plus the usage roll-up. */
function fakeStore() {
  let next = 3;

  return {
    addUsage: vi.fn(() => Promise.resolve()),
    allocateSeq: vi.fn((_tx: unknown, _fence: unknown, n: number) => {
      const first = next;

      next += n;

      return Promise.resolve(first);
    }),
    appendEvents: vi.fn((_tx: unknown, _fence: unknown, _rows: RunEventInput[]) =>
      Promise.resolve(),
    ),
  };
}

/** Records what was scheduled; the test fires it by hand. */
function fakeTimer() {
  const scheduled: { fn: () => void; ms: number }[] = [];
  const cancelled: number[] = [];
  const timer: BatcherTimer = {
    schedule(fn, ms) {
      const index = scheduled.push({ fn, ms }) - 1;

      return () => {
        cancelled.push(index);
      };
    },
  };

  return { cancelled, scheduled, timer };
}

const tx = { fake: true } as unknown as TenantTransaction;

function tool(index: number): EmittedEvent {
  return { data: { ok: true, stepId: `run/${index}` }, type: 'tool.end' };
}

describe('EventBatcher', () => {
  let clock: FakeClock;
  let store: ReturnType<typeof fakeStore>;
  let timer: ReturnType<typeof fakeTimer>;
  let batcher: EventBatcher;
  let publisher: { append: ReturnType<typeof vi.fn> };
  let committed: number;

  beforeEach(() => {
    clock = new FakeClock(START);
    store = fakeStore();
    timer = fakeTimer();
    publisher = {
      append: vi.fn((_orgId: string, _runId: string, rows: RunEventInput[]) =>
        Promise.resolve(rows.at(-1)!.seq),
      ),
    };
    committed = 0;
    batcher = new EventBatcher(
      {
        clock,
        publisher: publisher as unknown as Pick<RunStreamPublisher, 'append'>,
        store: store as unknown as RunStore,
        timer: timer.timer,
        timings: DEFAULT_AGENT_TIMINGS,
        transactions: {
          runInTenantTransaction: async (_orgId, fn) => {
            const result = await fn(tx);

            committed += 1;

            return result;
          },
        },
      },
      FENCE,
    );
  });

  it('flushes at batchSize: one seq range, every row stamped, in one transaction', async () => {
    for (let index = 0; index < DEFAULT_AGENT_TIMINGS.batchSize; index += 1) {
      await batcher.push(tool(index));
    }

    expect(store.allocateSeq).toHaveBeenCalledTimes(1);
    expect(store.allocateSeq).toHaveBeenCalledWith(tx, FENCE, 32);
    expect(store.appendEvents).toHaveBeenCalledTimes(1);

    const rows = store.appendEvents.mock.calls[0]![2];

    expect(rows.map((row) => row.seq)).toEqual(
      Array.from({ length: 32 }, (_unused, index) => 3 + index),
    );
    expect(rows.every((row) => row.at.getTime() === Date.parse(START))).toBe(true);
    // The timer armed by the first push is disarmed by the flush.
    expect(timer.cancelled).toEqual([0]);
  });

  it('flushes at batchMs from the first push, arming one timer per batch', async () => {
    await batcher.push(tool(0));
    await batcher.push(tool(1));

    expect(timer.scheduled).toHaveLength(1);
    expect(timer.scheduled[0]!.ms).toBe(DEFAULT_AGENT_TIMINGS.batchMs);
    expect(store.appendEvents).not.toHaveBeenCalled();

    timer.scheduled[0]!.fn();
    await batcher.flush();

    expect(store.appendEvents).toHaveBeenCalledTimes(1);
    expect(store.appendEvents.mock.calls[0]![2]).toHaveLength(2);

    await batcher.push(tool(2));

    expect(timer.scheduled).toHaveLength(2);
  });

  it('flushes on flush() and does nothing when empty', async () => {
    await batcher.flush();

    expect(store.allocateSeq).not.toHaveBeenCalled();

    await batcher.push(tool(0));
    await batcher.push(tool(1));
    await batcher.push(tool(2));
    await batcher.flush();

    expect(store.appendEvents).toHaveBeenCalledTimes(1);
    expect(store.appendEvents.mock.calls[0]![2]).toHaveLength(3);
    expect(timer.cancelled).toEqual([0]);
  });

  it('writes no row for the non-durable types and arms no timer for them', async () => {
    await batcher.push({ data: { text: 'a' }, type: 'token' });
    await batcher.push({ data: { text: 'b' }, type: 'thought' });
    await batcher.push({ data: { chunk: 'c', stepId: 'run/0' }, type: 'tool.delta' });
    await batcher.flush();

    expect(timer.scheduled).toEqual([]);
    expect(store.allocateSeq).not.toHaveBeenCalled();
    expect(store.appendEvents).not.toHaveBeenCalled();
  });

  it('refuses a state event: transitions belong to the consumer', async () => {
    await expect(
      batcher.push({ data: { from: 'running', to: 'succeeded' }, type: 'state' }),
    ).rejects.toThrow(IllegalEventError);
    await batcher.flush();

    expect(store.allocateSeq).not.toHaveBeenCalled();
  });

  it('rolls usage into the run row in the same flush', async () => {
    await batcher.push({
      data: { costMicros: 5, inputTokens: 10, outputTokens: 2 },
      type: 'usage',
    });
    await batcher.push({
      data: { costMicros: 1, duplicateOf: 'run/0', inputTokens: 1, outputTokens: 1 },
      type: 'usage',
    });
    await batcher.flush();

    expect(store.addUsage).toHaveBeenCalledWith(tx, FENCE, {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicros: 6,
      inputTokens: 11,
      outputTokens: 3,
    });
  });

  it('rolls cache tokens onto the row', async () => {
    await batcher.push({
      data: {
        cacheReadTokens: 900,
        cacheWriteTokens: 300,
        costMicros: 0,
        inputTokens: 4,
        outputTokens: 2,
      },
      type: 'usage',
    });
    await batcher.push({
      data: {
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
        costMicros: 0,
        inputTokens: 1,
        outputTokens: 1,
      },
      type: 'usage',
    });
    await batcher.flush();

    expect(store.addUsage).toHaveBeenCalledWith(tx, FENCE, {
      cacheReadTokens: 1000,
      cacheWriteTokens: 300,
      costMicros: 0,
      inputTokens: 5,
      outputTokens: 3,
    });
  });

  it('propagates a fenced flush from flush() and from the push that fills the batch', async () => {
    store.appendEvents.mockRejectedValue(new FencedError('run', 'appendEvents', 1));

    await batcher.push(tool(0));

    await expect(batcher.flush()).rejects.toThrow(FencedError);

    for (let index = 0; index < DEFAULT_AGENT_TIMINGS.batchSize - 1; index += 1) {
      await batcher.push(tool(index));
    }

    await expect(batcher.push(tool(99))).rejects.toThrow(FencedError);
  });

  /** A timer fires with nobody awaiting it; the fence it hits surfaces on the next call. */
  it('surfaces a fenced timer flush on the next push', async () => {
    store.appendEvents.mockRejectedValueOnce(new FencedError('run', 'appendEvents', 1));

    await batcher.push(tool(0));
    timer.scheduled[0]!.fn();
    await new Promise((resolve) => setImmediate(resolve));

    await expect(batcher.push(tool(1))).rejects.toThrow(FencedError);
  });

  /** Spec 009 FR-002/FR-004: the stream hears of a batch once it is on disk, in emission order. */
  describe('the stream fan-out (009)', () => {
    const delta = (chunk: string): EmittedEvent => ({
      data: { chunk, stepId: 'run/0' },
      type: 'tool.delta',
    });

    it('publishes exactly the rows a flush wrote, after its transaction committed', async () => {
      await batcher.push(tool(0));
      await batcher.push(tool(1));
      await batcher.flush();

      expect(publisher.append).toHaveBeenCalledTimes(1);
      expect(publisher.append).toHaveBeenCalledWith(
        FENCE.orgId,
        FENCE.runId,
        store.appendEvents.mock.calls[0]![2],
      );
      expect(publisher.append.mock.calls[0]![2]).toMatchObject([{ seq: 3 }, { seq: 4 }]);
      expect(committed).toBe(1);
      expect(publisher.append.mock.invocationCallOrder[0]).toBeGreaterThan(
        store.appendEvents.mock.invocationCallOrder[0]!,
      );
    });

    it('publishes nothing when the transaction fails', async () => {
      store.appendEvents.mockRejectedValueOnce(new FencedError('run', 'appendEvents', 1));

      await batcher.push(tool(0));
      await expect(batcher.flush()).rejects.toThrow(FencedError);

      expect(publisher.append).not.toHaveBeenCalled();
    });

    it('sends a non-durable event straight to the stream when nothing is pending, stamped with the seq it follows', async () => {
      batcher.follow(9);
      await batcher.push(delta('a'));

      expect(publisher.append).toHaveBeenCalledWith(FENCE.orgId, FENCE.runId, [
        { at: clock.now(), data: { chunk: 'a', stepId: 'run/0' }, seq: 9, type: 'tool.delta' },
      ]);
      expect(timer.scheduled).toEqual([]);
      expect(store.allocateSeq).not.toHaveBeenCalled();
    });

    it('queues a non-durable event behind a pending milestone and appends it with that batch, in order', async () => {
      await batcher.push(tool(0));
      await batcher.push(delta('a'));
      await batcher.push(delta('b'));
      await batcher.push(tool(1));
      await batcher.push(delta('c'));

      expect(publisher.append).not.toHaveBeenCalled();
      expect(batcher.pending).toBe(5);

      await batcher.flush();

      // Two seqs, two rows; the deltas file under the milestone before them.
      expect(store.allocateSeq).toHaveBeenCalledWith(tx, FENCE, 2);
      expect(store.appendEvents.mock.calls[0]![2].map((row) => row.seq)).toEqual([3, 4]);
      expect(publisher.append).toHaveBeenCalledTimes(1);
      expect(
        (publisher.append.mock.calls[0]![2] as RunEventInput[]).map((row) => [row.type, row.seq]),
      ).toEqual([
        ['tool.end', 3],
        ['tool.delta', 3],
        ['tool.delta', 3],
        ['tool.end', 4],
        ['tool.delta', 4],
      ]);
      expect(batcher.lastSeq).toBe(4);
    });

    it('lets a lone non-durable event wait for a write in flight, so it lands after that batch', async () => {
      let commit!: () => void;

      store.appendEvents.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            commit = resolve;
          }),
      );

      await batcher.push(tool(0));

      const flushing = batcher.flush();

      // The write has taken the buffer and is waiting on Postgres.
      await new Promise((resolve) => setImmediate(resolve));

      const pushing = batcher.push(delta('late'));

      await new Promise((resolve) => setImmediate(resolve));

      expect(publisher.append).not.toHaveBeenCalled();

      commit();
      await flushing;
      await pushing;

      expect(
        publisher.append.mock.calls.map((call) => (call[2] as RunEventInput[])[0]!.type),
      ).toEqual(['tool.end', 'tool.delta']);
      expect(publisher.append.mock.calls[1]![2]).toMatchObject([{ seq: 3 }]);
    });

    it('remembers the highest seq its flushes published, and follows a seq synced elsewhere', async () => {
      expect(batcher.lastSeq).toBe(0);

      await batcher.push(tool(0));
      await batcher.push(tool(1));
      await batcher.flush();

      expect(batcher.lastSeq).toBe(4);

      batcher.follow(2);

      expect(batcher.lastSeq).toBe(4);

      batcher.follow(5);

      expect(batcher.lastSeq).toBe(5);
    });

    it('reports how many events are buffered', async () => {
      expect(batcher.pending).toBe(0);

      await batcher.push(tool(0));
      await batcher.push({ data: { text: 'a' }, type: 'token' });

      expect(batcher.pending).toBe(2);

      await batcher.flush();

      expect(batcher.pending).toBe(0);
    });
  });

  it('close() flushes what is pending and disarms the timer', async () => {
    await batcher.push(tool(0));
    await batcher.close();

    expect(store.appendEvents).toHaveBeenCalledTimes(1);
    expect(timer.cancelled).toEqual([0]);
  });
});
