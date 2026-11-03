import { randomUUID } from 'node:crypto';

import { outbox, processedEvents, schema } from '@repo/db';
import { UnrecoverableError } from 'bullmq';
import { and, count, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, describe, expect, inject, it, vi } from 'vitest';

import { openPool } from '../../../test/support/integration-database';
import { FakeClock } from '../../common/clock/fake-clock';
import type { ForgeDatabase, TenantTransaction } from '../../database/database.types';
import { EventConsumer, RetryableFailure } from './consumer';
import { type AttemptRecord, ConsumerBase, type ConsumerJob } from './consumer-base';
import type { Envelope } from './envelope';

/** Probed once per run by `test/global-setup.ts`, which also owns the CI-must-not-skip rule. */
const reachable = inject('postgresReachable');

/** `forge_app`, as the worker: the processed row and the handler's writes go through one pool. */
const pool = reachable ? openPool(process.env.DATABASE_URL ?? '', 2) : undefined;

/** A job as the worker hands it over, with a `log` that keeps what the base writes to it. */
function job(attemptsMade = 0): ConsumerJob<'outbox.probe'> & { readonly logs: string[] } {
  const logs: string[] = [];

  return {
    attemptsMade,
    data: {
      aggregate: 'probe',
      aggregateId: randomUUID(),
      eventId: randomUUID(),
      occurredAt: '2026-09-13T10:00:00.000Z',
      orgId: null,
      payload: { probeId: randomUUID() },
      traceId: null,
      type: 'outbox.probe',
    },
    log: (row: string): Promise<number> => Promise.resolve(logs.push(row)),
    logs,
  };
}

function records(delivery: { readonly logs: string[] }): AttemptRecord[] {
  return delivery.logs.map((row) => JSON.parse(row) as AttemptRecord);
}

/**
 * A consumer whose `handle` writes a row on the transaction it is given — an outbox row keyed by
 * the envelope's aggregate id, the one table `forge_app` may insert into without a tenant — so the
 * suite can see whether the handler's write and the processed row commit together.
 */
class RecordingConsumer extends EventConsumer<'outbox.probe'> {
  readonly attempts = 1;
  readonly queue = 'probe';
  readonly types = ['outbox.probe'] as const;

  handleCalls = 0;

  constructor(
    readonly name: string,
    private readonly failure?: Error,
  ) {
    super();
  }

  async handle(event: Envelope<'outbox.probe'>, tx: TenantTransaction): Promise<void> {
    this.handleCalls += 1;
    await tx.insert(outbox).values({
      aggregate: event.aggregate,
      aggregateId: event.aggregateId,
      occurredAt: new Date(event.occurredAt),
      payload: event.payload,
      type: event.type,
    });

    if (this.failure) {
      throw this.failure;
    }
  }
}

/**
 * Spec 006 (research R5): a consumer with an external side effect. `handle` writes the same probe
 * row; `effect` is what the base must call after that commit and with no transaction held, and
 * the processed row is what it must write only after `effect` returned.
 */
class EffectConsumer extends EventConsumer<'outbox.probe', string> {
  readonly attempts = 1;
  readonly queue = 'probe';
  readonly types = ['outbox.probe'] as const;

  readonly calls: string[] = [];
  effectFailure?: Error;
  probeRowsAtEffect = -1;

  constructor(
    readonly name: string,
    private readonly db: ForgeDatabase,
  ) {
    super();
  }

  async handle(event: Envelope<'outbox.probe'>, tx: TenantTransaction): Promise<string> {
    this.calls.push('handle');
    await tx.insert(outbox).values({
      aggregate: event.aggregate,
      aggregateId: event.aggregateId,
      occurredAt: new Date(event.occurredAt),
      payload: event.payload,
      type: event.type,
    });

    return event.aggregateId;
  }

  override async effect(_event: Envelope<'outbox.probe'>, prepared: string): Promise<void> {
    this.calls.push('effect');
    // Read on the pool, not a transaction: visible only if `handle` has committed.
    const [row] = await this.db
      .select({ n: count() })
      .from(outbox)
      .where(eq(outbox.aggregateId, prepared));
    this.probeRowsAtEffect = row!.n;

    if (this.effectFailure) {
      throw this.effectFailure;
    }
  }
}

/**
 * US2 (spec 005): a consumer acts exactly once per event. The base inserts `(consumer, event_id)`
 * `ON CONFLICT DO NOTHING` and calls `handle` only when that returned a row, on the same
 * transaction — so the handler's writes commit with the processed row or not at all (FR-015/016).
 */
describe.skipIf(!reachable)('ConsumerBase', () => {
  const db: ForgeDatabase = drizzle(pool!, { schema });
  const clock = new FakeClock('2026-09-13T12:00:00.000Z');
  const base = new ConsumerBase(db, clock);

  afterAll(async () => {
    await pool?.end();
  });

  async function processedRows(consumer: string, eventId: string): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(processedEvents)
      .where(and(eq(processedEvents.consumer, consumer), eq(processedEvents.eventId, eventId)));

    return row!.n;
  }

  async function probeRows(aggregateId: string): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(outbox)
      .where(eq(outbox.aggregateId, aggregateId));

    return row!.n;
  }

  it('calls handle once and records the processed row in the same transaction', async () => {
    const consumer = new RecordingConsumer(`c-${randomUUID()}`);
    const delivery = job();

    await base.processJob(consumer, delivery);

    expect(consumer.handleCalls).toBe(1);
    expect(await processedRows(consumer.name, delivery.data.eventId)).toBe(1);
    expect(await probeRows(delivery.data.aggregateId)).toBe(1);
  });

  it('does not call handle when the event was already processed by this consumer', async () => {
    const consumer = new RecordingConsumer(`c-${randomUUID()}`);
    const delivery = job();

    await db
      .insert(processedEvents)
      .values({ consumer: consumer.name, eventId: delivery.data.eventId });

    await expect(base.processJob(consumer, delivery)).resolves.toBeUndefined();

    expect(consumer.handleCalls).toBe(0);
    expect(await probeRows(delivery.data.aggregateId)).toBe(0);
  });

  it('rolls back the processed row when handle throws', async () => {
    const consumer = new RecordingConsumer(`c-${randomUUID()}`, new Error('handler failed'));
    const delivery = job();

    await expect(base.processJob(consumer, delivery)).rejects.toThrow('handler failed');

    expect(consumer.handleCalls).toBe(1);
    expect(await processedRows(consumer.name, delivery.data.eventId)).toBe(0);
    expect(await probeRows(delivery.data.aggregateId)).toBe(0);
  });

  it('lets a second consumer process the same event', async () => {
    const first = new RecordingConsumer(`c-${randomUUID()}`);
    const second = new RecordingConsumer(`c-${randomUUID()}`);
    const delivery = job();

    await base.processJob(first, delivery);
    await base.processJob(second, delivery);

    expect(first.handleCalls).toBe(1);
    expect(second.handleCalls).toBe(1);
    expect(await processedRows(first.name, delivery.data.eventId)).toBe(1);
    expect(await processedRows(second.name, delivery.data.eventId)).toBe(1);
    expect(await probeRows(delivery.data.aggregateId)).toBe(2);
  });

  /**
   * Spec 006 (research R5): prepare durably, act without a connection, record after the act. A
   * lost mail is worse than a repeated one, so the processed row is written last.
   */
  describe('with an effect', () => {
    it('runs effect after handle committed and records the event afterwards', async () => {
      const consumer = new EffectConsumer(`c-${randomUUID()}`, db);
      const delivery = job();

      await base.processJob(consumer, delivery);

      expect(consumer.calls).toEqual(['handle', 'effect']);
      expect(consumer.probeRowsAtEffect).toBe(1);
      expect(await processedRows(consumer.name, delivery.data.eventId)).toBe(1);
    });

    it("leaves handle's writes and records nothing when effect throws", async () => {
      const consumer = new EffectConsumer(`c-${randomUUID()}`, db);
      consumer.effectFailure = new RetryableFailure('throttled');
      const delivery = job();

      await expect(base.processJob(consumer, delivery)).rejects.toBe(consumer.effectFailure);

      expect(await probeRows(delivery.data.aggregateId)).toBe(1);
      expect(await processedRows(consumer.name, delivery.data.eventId)).toBe(0);
      expect(records(delivery)).toEqual([
        expect.objectContaining({ classification: 'retryable', reason: 'throttled' }),
      ]);
    });

    it('skips handle and effect when the event is already processed', async () => {
      const consumer = new EffectConsumer(`c-${randomUUID()}`, db);
      const delivery = job();

      await db
        .insert(processedEvents)
        .values({ consumer: consumer.name, eventId: delivery.data.eventId });

      await base.processJob(consumer, delivery);

      expect(consumer.calls).toEqual([]);
      expect(await probeRows(delivery.data.aggregateId)).toBe(0);
    });

    it('records after effect so a crash between them redelivers', async () => {
      const consumer = new EffectConsumer(`c-${randomUUID()}`, db);
      const delivery = job();
      const crash = new Error('crashed before the record');
      // The first transaction (handle) runs for real; the second (record) is the crash.
      const real = db.transaction.bind(db);
      const transaction = vi
        .spyOn(db, 'transaction')
        .mockImplementationOnce(real)
        .mockImplementationOnce(() => Promise.reject(crash));

      await expect(base.processJob(consumer, delivery)).rejects.toBe(crash);
      transaction.mockRestore();

      expect(consumer.calls).toEqual(['handle', 'effect']);
      expect(await processedRows(consumer.name, delivery.data.eventId)).toBe(0);

      await base.processJob(consumer, delivery);

      expect(consumer.calls).toEqual(['handle', 'effect', 'handle', 'effect']);
      expect(await processedRows(consumer.name, delivery.data.eventId)).toBe(1);
    });
  });

  /**
   * US3 (spec 005, research R5): the base classifies, BullMQ retries. A `RetryableFailure` must
   * reach the worker as itself — wrapped, it would be terminal — and everything else must reach
   * it as `UnrecoverableError`, the one class `moveToFailed` refuses to retry. Each failed
   * attempt leaves one record on the job (the DLQ's attempt history, R7), stamped by the injected
   * clock and never carrying the payload.
   */
  describe('classification', () => {
    it('rethrows a RetryableFailure unwrapped so the queue retries it', async () => {
      const failure = new RetryableFailure('throttled');
      const consumer = new RecordingConsumer(`c-${randomUUID()}`, failure);
      const delivery = job();

      await expect(base.processJob(consumer, delivery)).rejects.toBe(failure);

      expect(records(delivery)).toEqual([
        expect.objectContaining({ classification: 'retryable', reason: 'throttled' }),
      ]);
    });

    it('wraps any other error in UnrecoverableError so the queue does not retry it', async () => {
      const failure = new TypeError('cannot read properties of undefined');
      const consumer = new RecordingConsumer(`c-${randomUUID()}`, failure);
      const delivery = job();

      const rejection = base.processJob(consumer, delivery);

      await expect(rejection).rejects.toBeInstanceOf(UnrecoverableError);
      await expect(rejection).rejects.toMatchObject({ cause: failure, message: failure.message });
    });

    it('wraps an unclassified error as terminal', async () => {
      class UpstreamRejected extends Error {
        override readonly name = 'UpstreamRejected';
      }
      const consumer = new RecordingConsumer(`c-${randomUUID()}`, new UpstreamRejected('no'));
      const delivery = job();

      await expect(base.processJob(consumer, delivery)).rejects.toBeInstanceOf(UnrecoverableError);

      expect(records(delivery)).toEqual([
        expect.objectContaining({ classification: 'terminal', reason: 'UpstreamRejected' }),
      ]);
      expect(delivery.logs.join('')).not.toContain(delivery.data.payload.probeId);
    });

    it("writes one attempt record per attempt with the injected clock's time", async () => {
      const consumer = new RecordingConsumer(`c-${randomUUID()}`, new RetryableFailure('timeout'));
      const first = job(0);
      const second = job(1);

      await expect(base.processJob(consumer, first)).rejects.toBeInstanceOf(RetryableFailure);
      clock.advance(1_500);
      await expect(base.processJob(consumer, second)).rejects.toBeInstanceOf(RetryableFailure);

      expect(records(first)).toEqual([
        {
          at: '2026-09-13T12:00:00.000Z',
          attempt: 1,
          classification: 'retryable',
          reason: 'timeout',
        },
      ]);
      expect(records(second)).toEqual([
        {
          at: '2026-09-13T12:00:01.500Z',
          attempt: 2,
          classification: 'retryable',
          reason: 'timeout',
        },
      ]);
    });
  });
});
