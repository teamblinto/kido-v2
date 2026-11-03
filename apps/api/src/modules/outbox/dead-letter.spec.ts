import { EventEmitter } from 'node:events';

import type { Job, Queue, Worker } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { FakeClock } from '../../common/clock/fake-clock';
import { RetryableFailure } from './consumer';
import { attachDeadLetter, type DeadLetter, type DeadLetterQueue } from './dead-letter';
import type { Envelope } from './envelope';
import type { EventType } from './events';

type EventWorker = Worker<Envelope, void, EventType>;
type EventQueue = Queue<Envelope, void, EventType>;

const envelope: Envelope<'outbox.probe'> = {
  aggregate: 'probe',
  aggregateId: 'a1',
  eventId: 'e1',
  occurredAt: '2026-09-13T10:00:00.000Z',
  orgId: null,
  payload: { probeId: 'p1' },
  traceId: 'test',
  type: 'outbox.probe',
};

/** The attempt records the base wrote (T023), as `getJobLogs` returns them: oldest first. */
const logs = [
  '{"at":"2026-09-13T10:00:01.000Z","attempt":1,"classification":"retryable","reason":"throttled"}',
  '{"at":"2026-09-13T10:00:03.000Z","attempt":2,"classification":"retryable","reason":"throttled"}',
];

/**
 * A job as the `failed` listener sees it: `attemptsMade` already incremented by `moveToFailed`,
 * `failedReason` set to the error's message (research R7).
 */
function failedJob(
  overrides: Partial<Pick<Job, 'attemptsMade' | 'failedReason' | 'stacktrace'>> & {
    attempts?: number;
  } = {},
): Job<Envelope, void, EventType> {
  return {
    attemptsMade: overrides.attemptsMade ?? 1,
    data: envelope,
    failedReason: overrides.failedReason ?? 'boom',
    id: 'e1',
    opts: { attempts: overrides.attempts ?? 1 },
    remove: vi.fn(() => Promise.resolve()),
    stacktrace: overrides.stacktrace ?? ['Error: boom\n    at handle'],
  } as unknown as Job<Envelope, void, EventType>;
}

/** The `remove` spy `failedJob` installed, read without binding a method off the job. */
function removeOf(job: Job<Envelope, void, EventType>): ReturnType<typeof vi.fn> {
  return (job as unknown as { remove: ReturnType<typeof vi.fn> }).remove;
}

function harness(): {
  added: { data: DeadLetter; name: string; opts: unknown }[];
  clock: FakeClock;
  error: ReturnType<typeof vi.fn>;
  fail: (job: Job<Envelope, void, EventType>, error: Error) => Promise<void>;
} {
  const emitter = new EventEmitter();
  const worker = emitter as unknown as EventWorker;
  const queue = { getJobLogs: () => Promise.resolve({ count: logs.length, logs }), name: 'probe' };
  const added: { data: DeadLetter; name: string; opts: unknown }[] = [];
  const dlq = {
    add: (name: string, data: DeadLetter, opts: unknown): Promise<unknown> => {
      added.push({ data, name, opts });
      return Promise.resolve();
    },
  };
  const clock = new FakeClock('2026-09-13T10:00:05.000Z');
  const error = vi.fn();

  attachDeadLetter(
    worker,
    queue as unknown as EventQueue,
    dlq as unknown as DeadLetterQueue,
    clock,
    { error, warn: vi.fn() },
  );

  return {
    added,
    clock,
    error,
    // The listener fires the DLQ add without awaiting it (a `failed` listener returns void);
    // one macrotask turn is enough for the fake queue's promises to settle.
    fail: async (job, failure): Promise<void> => {
      emitter.emit('failed', job, failure, 'active');
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

/**
 * US3 (spec 005, research R7): BullMQ has no DLQ, so one `failed` listener per worker decides
 * finality — terminal by class, exhausted by count, poison by BullMQ's stall message — and copies
 * what §10 asks for onto a paired `<queue>.dlq` under the same job id.
 */
describe('attachDeadLetter', () => {
  it('dead-letters an UnrecoverableError on the first attempt', async () => {
    const { added, fail } = harness();

    await fail(failedJob({ attempts: 5 }), new UnrecoverableError('boom'));

    expect(added).toHaveLength(1);
    expect(added[0]?.name).toBe('dead-letter');
    expect(added[0]?.opts).toEqual({ jobId: 'e1' });
  });

  it('dead-letters a retryable failure only when attempts are exhausted', async () => {
    const { added, fail } = harness();
    const failure = new RetryableFailure('throttled');

    await fail(failedJob({ attempts: 3, attemptsMade: 1 }), failure);
    await fail(failedJob({ attempts: 3, attemptsMade: 2 }), failure);
    expect(added).toHaveLength(0);

    await fail(failedJob({ attempts: 3, attemptsMade: 3 }), failure);
    expect(added).toHaveLength(1);
  });

  it('marks a stall-limit failure as poison', async () => {
    const { added, fail } = harness();
    const reason = 'job stalled more than allowable limit';

    await fail(failedJob({ attempts: 5, failedReason: reason }), new UnrecoverableError(reason));

    expect(added[0]?.data.poison).toBe(true);
    expect(added[0]?.data.failedReason).toBe(reason);
  });

  it('carries payload, error chain, attempt history and trace id', async () => {
    const { added, fail } = harness();
    const stacktrace = ['Error: first\n    at handle', 'Error: boom\n    at handle'];

    await fail(failedJob({ attempts: 2, attemptsMade: 2, stacktrace }), new Error('boom'));

    expect(added[0]?.data).toEqual({
      attempts: [
        {
          at: '2026-09-13T10:00:01.000Z',
          attempt: 1,
          classification: 'retryable',
          reason: 'throttled',
        },
        {
          at: '2026-09-13T10:00:03.000Z',
          attempt: 2,
          classification: 'retryable',
          reason: 'throttled',
        },
      ],
      deadLetteredAt: '2026-09-13T10:00:05.000Z',
      errors: stacktrace,
      failedReason: 'boom',
      jobId: 'e1',
      payload: envelope,
      poison: false,
      sourceQueue: 'probe',
      traceId: 'test',
    });
  });

  /**
   * Spec 006 research R3: the job id is the mail lane's dedupe key, and a failed job keeps its id
   * for 7 d — so the letter is the record and the source job goes, or a same-hour re-request after
   * a fixed cause would be dropped. Without a letter the job stays: nothing is lost twice.
   */
  it('removes the source job once the letter is written', async () => {
    const { added, fail } = harness();
    const job = failedJob();

    await fail(job, new UnrecoverableError('boom'));

    expect(added).toHaveLength(1);
    expect(removeOf(job)).toHaveBeenCalledTimes(1);
  });

  it('leaves the job when the letter could not be written', async () => {
    const emitter = new EventEmitter();
    const job = failedJob();

    attachDeadLetter(
      emitter as unknown as EventWorker,
      { getJobLogs: () => Promise.resolve({ count: 0, logs: [] }) } as unknown as EventQueue,
      { add: () => Promise.reject(new Error('queue store down')) } as unknown as DeadLetterQueue,
      new FakeClock(0),
      { error: vi.fn(), warn: vi.fn() },
    );
    emitter.emit('failed', job, new Error('boom'), 'active');
    await new Promise((resolve) => setImmediate(resolve));

    expect(removeOf(job)).not.toHaveBeenCalled();
  });

  it('logs at warn and keeps the letter when the remove fails', async () => {
    const emitter = new EventEmitter();
    const warn = vi.fn();
    const error = vi.fn();
    const job = failedJob();
    removeOf(job).mockRejectedValueOnce(new Error('locked'));

    attachDeadLetter(
      emitter as unknown as EventWorker,
      {
        getJobLogs: () => Promise.resolve({ count: 0, logs: [] }),
        name: 'probe',
      } as unknown as EventQueue,
      { add: () => Promise.resolve() } as unknown as DeadLetterQueue,
      new FakeClock(0),
      { error, warn },
    );
    emitter.emit('failed', job, new Error('boom'), 'active');
    await new Promise((resolve) => setImmediate(resolve));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('e1'));
    expect(error).not.toHaveBeenCalled();
  });

  /** R7: a DLQ add that fails is an `error` line naming the job; the failed set still has it. */
  it('logs at error with the job id when the dlq refuses the add', async () => {
    const emitter = new EventEmitter();
    const error = vi.fn();
    const dlq = { add: () => Promise.reject(new Error('queue store down')) };

    attachDeadLetter(
      emitter as unknown as EventWorker,
      { getJobLogs: () => Promise.resolve({ count: 0, logs: [] }) } as unknown as EventQueue,
      dlq as unknown as DeadLetterQueue,
      new FakeClock(0),
      { error, warn: vi.fn() },
    );
    emitter.emit('failed', failedJob(), new Error('boom'), 'active');
    await new Promise((resolve) => setImmediate(resolve));

    expect(error).toHaveBeenCalledWith(expect.stringContaining('e1'));
  });
});
