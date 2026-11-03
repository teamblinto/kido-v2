import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { outbox, processedEvents } from '@repo/db';
import { type Job, Queue, type Worker } from 'bullmq';
import { count, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { QUEUE_REDIS } from '../src/common/redis/redis.constants';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import { InMemoryMailer } from '../src/modules/mail/in-memory.mailer';
import { MAILER } from '../src/modules/mail/mailer.port';
import type { AttemptRecord } from '../src/modules/outbox/consumer-base';
import {
  type DeadLetter,
  type DeadLetterQueue,
  STALL_LIMIT_REASON,
} from '../src/modules/outbox/dead-letter';
import type { Envelope } from '../src/modules/outbox/envelope';
import type { EventType } from '../src/modules/outbox/events';
import { OutboxWriter } from '../src/modules/outbox/outbox-writer';
import { EVENT_CONSUMERS } from '../src/modules/outbox/outbox.constants';
import { QueueRegistry } from '../src/modules/outbox/queue-registry';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import { ProbeConsumer } from './support/probe-consumer';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  // Off by default under test (one outbox table, many parallel workers); this suite holds the
  // outbox suite lock, so it is the one process that relays and drains.
  process.env.RUN_PROFILES = 'api,agent,events,cron';
});

/**
 * The wait for the outbox suite lock is inside `beforeAll`, and it is a wait behind every other
 * suite that relays — `password.e2e-spec.ts`'s measurement among them — so the hook's budget is
 * the serialised suites', not this one's boot.
 */
const LOCKED_BOOT_TIMEOUT_MS = 600_000;

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

/** Polls `predicate` until it holds or `ms` elapse — delivery has no other clock to wait on. */
async function until(predicate: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }

    await sleep(50);
  }

  return predicate();
}

/**
 * US2 and US3 (spec 005) end to end: a row committed through the writer reaches a consumer's
 * `handle` exactly once per consumer, in commit order per aggregate, within the budget
 * (SC-001..004, FR-010/015), and a queue store that refuses writes holds rows without touching the
 * request path (FR-014); a failure is classified by what the handler threw, retried with jitter
 * and dead-lettered with its history once final (SC-005, FR-017..020). The probe consumers are
 * the only registrants, overriding the empty token `OutboxModule` ships (FR-028).
 *
 * The outbox table is shared with the writer, relay and consumer-base suites, which leave probe
 * rows of their own that this application's relay delivers in passing; every assertion is scoped
 * to the ids this suite committed. Nothing is deleted from the two tables: `forge_app` has no
 * `DELETE` on either by grant (FR-003b), and a truncation would land under the other suites' feet.
 */
describe('Outbox delivery (e2e)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and the queue Redis role', () => {
    let app: INestApplication;
    let db: ForgeDatabase;
    let writer: OutboxWriter;
    let store: Redis;
    let queue: Queue<Envelope>;
    let registry: QueueRegistry;
    let suiteLock: { release: () => Promise<void> };
    const probe = new ProbeConsumer();
    const second = new ProbeConsumer('probe-2');
    /** The spent-budget case's consumer: two attempts in total, so the second failure is final. */
    const third = new ProbeConsumer('probe-3', 'probe-3', 2);

    /** `n` events for one aggregate in one transaction, with `traceId: 'test'`; returns the ids. */
    async function emit(n: number, aggregateId = randomUUID()): Promise<string[]> {
      return db.transaction(async (tx) => {
        const ids: string[] = [];

        for (let i = 0; i < n; i += 1) {
          const { eventId } = await writer.append(tx, {
            aggregateId,
            payload: { probeId: randomUUID() },
            traceId: 'test',
            type: 'outbox.probe',
          });

          ids.push(eventId);
        }

        return ids;
      });
    }

    function seenIds(consumer: ProbeConsumer, ids: readonly string[]): string[] {
      return consumer.seen.map((entry) => entry.eventId).filter((id) => ids.includes(id));
    }

    function delivered(consumer: ProbeConsumer, ids: readonly string[]): boolean {
      return ids.every((id) => consumer.seen.some((entry) => entry.eventId === id));
    }

    /** The DLQ job for `id` on `<source>.dlq`, or a failed assertion once `ms` have passed. */
    async function deadLettered(source: string, id: string, ms: number): Promise<DeadLetter> {
      const dlq = registry.queues.get(`${source}.dlq`) as DeadLetterQueue;
      let letter: Job<DeadLetter> | undefined;

      expect(await until(async () => (letter = await dlq.getJob(id)) !== undefined, ms)).toBe(true);

      return letter!.data;
    }

    /**
     * Spec 006 research R3: once the letter is written the source job is removed, so its id —
     * the mail lane's dedupe key — is free. Awaited, because the remove follows the DLQ add.
     */
    async function sourceGone(id: string, ms: number): Promise<void> {
      expect(await until(async () => (await queue.getJob(id)) === undefined, ms)).toBe(true);
    }

    async function attemptRecords(id: string): Promise<AttemptRecord[]> {
      const { logs } = await queue.getJobLogs(id);

      return logs.map((row) => JSON.parse(row) as AttemptRecord);
    }

    beforeAll(async () => {
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EVENT_CONSUMERS)
        .useValue([probe, second, third])
        .overrideProvider(MAILER)
        .useValue(new InMemoryMailer())
        .compile();

      // Before the workers exist: a job left waiting by an earlier run would be processed first
      // and land inside this run's latency measurement.
      store = moduleRef.get<Redis>(QUEUE_REDIS);
      const stale = await store.keys('bull:probe*');

      if (stale.length > 0) {
        await store.del(...stale);
      }

      app = moduleRef.createNestApplication();
      configureApplication(app);
      await app.init();

      db = app.get<ForgeDatabase>(APP_DATABASE);
      writer = app.get(OutboxWriter);
      registry = app.get(QueueRegistry);
      queue = new Queue<Envelope>('probe', { connection: store });
    }, LOCKED_BOOT_TIMEOUT_MS);

    afterEach(() => {
      probe.behaviour = 'ok';
      third.behaviour = 'ok';
    });

    afterAll(async () => {
      // A stall the poison case did not get to release would hold a pool connection through
      // `app.close()`, and the pool's `end()` waits for every client to come back.
      for (const release of probe.stalls.splice(0)) {
        release();
      }

      await queue?.close();
      await app?.close();
      await suiteLock?.release();
    });

    /** SC-002, measured from the commit returning to the probe's `seen` push, over 50 events. */
    it('delivers a committed event to the consumer within 5 s', async () => {
      const ids = await emit(50);
      const committedAt = performance.now();

      expect(await until(() => delivered(probe, ids), 15_000)).toBe(true);

      const latencies = ids
        .map((id) => probe.seen.find((entry) => entry.eventId === id)!.at - committedAt)
        .sort((a, b) => a - b);
      const p95 = latencies[Math.ceil(0.95 * latencies.length) - 1]!;
      const max = latencies.at(-1)!;

      process.stderr.write(
        `\n[SC-002] commit → handle over ${ids.length} events: p95 ${p95.toFixed(0)} ms · ` +
          `max ${max.toFixed(0)} ms\n`,
      );

      expect(p95).toBeLessThan(5_000);
      expect(max).toBeLessThan(15_000);
    });

    /**
     * SC-001: 100 committed transactions are 100 rows and 100 rolled-back ones are none. Here
     * rather than in the writer suite because the rows are left for this application's relay to
     * drain: a hundred unpublished rows left behind would fill the relay suite's next batch.
     */
    it('keeps 100 of 100 committed events and none of 100 rolled back', async () => {
      const committed = randomUUID();
      const rolledBack = randomUUID();
      const ids: string[] = [];

      class CallerFailed extends Error {}

      const rowsFor = async (aggregateId: string): Promise<number> =>
        (
          await db.select({ n: count() }).from(outbox).where(eq(outbox.aggregateId, aggregateId))
        )[0]!.n;

      for (let i = 0; i < 100; i += 1) {
        ids.push(...(await emit(1, committed)));
        await expect(
          db.transaction(async (tx) => {
            await writer.append(tx, {
              aggregateId: rolledBack,
              payload: { probeId: randomUUID() },
              type: 'outbox.probe',
            });
            throw new CallerFailed();
          }),
        ).rejects.toBeInstanceOf(CallerFailed);
      }

      expect(await rowsFor(committed)).toBe(100);
      expect(await rowsFor(rolledBack)).toBe(0);
      expect(await until(() => delivered(probe, ids), 15_000)).toBe(true);
    });

    /**
     * SC-004 / FR-015: the same job offered again completes without the handler running — 100
     * re-adds, 100 completions, one side effect. The completed job is removed before each re-add
     * because BullMQ refuses an id that still exists (R4) — the second layer, the
     * `(consumer, event_id)` row, is what this case exercises.
     */
    it('acts once when the same job is delivered 100 times', async () => {
      const [id] = await emit(1);

      expect(await until(() => delivered(probe, [id!]), 15_000)).toBe(true);

      const job = await queue.getJob(id!);

      expect(job).toBeDefined();

      const completed = async (): Promise<boolean> =>
        (await (await queue.getJob(id!))?.getState()) === 'completed';
      let completions = 0;

      for (let i = 0; i < 100; i += 1) {
        await queue.remove(id!);
        await queue.add('outbox.probe', job!.data, { jobId: id });

        if (await until(completed, 15_000)) {
          completions += 1;
        }
      }

      process.stderr.write(`\n[SC-004] ${completions} completions of 100 re-adds\n`);

      expect(completions).toBe(100);
      expect(seenIds(probe, [id!])).toEqual([id]);
    });

    /** FR-015 is per consumer: two consumers of one event are two processed rows and two handles. */
    it('acts once per consumer when two consumers share an event', async () => {
      const [id] = await emit(1);

      expect(await until(() => delivered(probe, [id!]) && delivered(second, [id!]), 15_000)).toBe(
        true,
      );

      // `seen` is pushed inside the handler's transaction, before it commits; the rows are polled
      // rather than read once so the assertion is on the committed state.
      const consumers = async (): Promise<string[]> =>
        (
          await db
            .select({ consumer: processedEvents.consumer })
            .from(processedEvents)
            .where(eq(processedEvents.eventId, id!))
        )
          .map((row) => row.consumer)
          .sort();

      expect(await until(async () => (await consumers()).length === 3, 15_000)).toBe(true);
      expect(await consumers()).toEqual(['probe', 'probe-2', 'probe-3']);
      expect(seenIds(probe, [id!])).toEqual([id]);
      expect(seenIds(second, [id!])).toEqual([id]);
    });

    /** SC-003 / FR-010: two commits on one aggregate reach the handler in the order they committed. */
    it('publishes A before B for the same aggregate', async () => {
      const aggregateId = randomUUID();
      const [a] = await emit(1, aggregateId);
      const [b] = await emit(1, aggregateId);

      expect(await until(() => delivered(probe, [a!, b!]), 15_000)).toBe(true);
      expect(seenIds(probe, [a!, b!])).toEqual([a, b]);
    });

    /**
     * FR-014 / SC-011: with the queue store refusing every add, a commit costs what a commit costs,
     * rows wait unpublished, and the backlog drains in `seq` order once adds succeed again. Every
     * `Queue.add` is stubbed rather than one instance's, because the relay's queues are the
     * module's own and the request path must not know them. The 100 commits made with the store
     * up first are the baseline the down-time commits are read against and are recorded, not
     * asserted on: two distributions over 100 samples cross on scheduler noise alone. The bound is
     * on the p95 rather than the maximum for the same reason — a CI runner sharing its cores with
     * the other suites produced one 307 ms commit in a set whose 99 others were under 100 ms.
     */
    it('holds events while publishing fails and drains them in order', async () => {
      const commitTimes = async (): Promise<{ ids: string[]; ms: number[] }> => {
        const aggregateId = randomUUID();
        const ids: string[] = [];
        const ms: number[] = [];

        for (let i = 0; i < 100; i += 1) {
          const startedAt = performance.now();
          const [id] = await emit(1, aggregateId);

          ms.push(performance.now() - startedAt);
          ids.push(id!);
        }

        return { ids, ms };
      };
      const p95 = (ms: number[]): number =>
        [...ms].sort((a, b) => a - b)[Math.ceil(0.95 * ms.length) - 1]!;
      const summary = (ms: number[]): string =>
        `p95 ${p95(ms).toFixed(1)} ms · max ${Math.max(...ms).toFixed(1)} ms`;

      const baseline = await commitTimes();
      const add = vi.spyOn(Queue.prototype, 'add').mockRejectedValue(new Error('queue store down'));
      const { ids, ms: commitMs } = await commitTimes();

      await sleep(3_000);

      process.stderr.write(
        `\n[SC-011] ${ids.length} commits with the queue store down: ${summary(commitMs)} · ` +
          `store up: ${summary(baseline.ms)}\n`,
      );

      expect(add).toHaveBeenCalled();
      expect(seenIds(probe, ids)).toEqual([]);
      expect(p95(commitMs)).toBeLessThan(100);

      add.mockRestore();

      expect(await until(() => delivered(probe, ids), 15_000)).toBe(true);
      expect(seenIds(probe, ids)).toEqual(ids);
    });

    /**
     * FR-017/019 / SC-005: an error that is not a `RetryableFailure` is final on the first
     * attempt, budget notwithstanding — the probe has five — in 100 of 100 trials. Each letter
     * carries the envelope untouched, the handler's own error at the head of the chain, the one
     * attempt record and the trace id.
     */
    it('dead-letters a terminal failure after exactly one attempt, 100 of 100 times', async () => {
      probe.behaviour = 'terminal';
      const ids = await emit(100);
      const letters: DeadLetter[] = [];

      for (const id of ids) {
        letters.push(await deadLettered('probe', id, 15_000));
      }

      const afterOneAttempt = letters.filter((letter) => letter.attempts.length === 1).length;

      process.stderr.write(
        `\n[SC-005] ${afterOneAttempt} of ${ids.length} dead-lettered after one attempt\n`,
      );

      expect(afterOneAttempt).toBe(100);

      for (const [index, letter] of letters.entries()) {
        expect(letter.attempts[0]).toMatchObject({
          attempt: 1,
          classification: 'terminal',
          reason: 'Error',
        });
        expect(letter.poison).toBe(false);
        expect(letter.traceId).toBe('test');
        expect(letter.payload).toMatchObject({ eventId: ids[index], type: 'outbox.probe' });
        expect(letter.errors[0]).toContain('boom');
        expect(letter.failedReason).toBe('boom');
        await sourceGone(ids[index]!, 5_000);
      }

      expect(seenIds(probe, ids)).toEqual([]);
    });

    /**
     * FR-018 / SC-005: attempt 1's retry is drawn from [0, 2 s), read off the gap between the
     * first two attempt records; the tolerance is the promotion from `delayed` plus the attempt
     * itself. Once the handler recovers, the job completes within its remaining budget.
     */
    it('retries a retryable failure with a jittered delay', async () => {
      probe.behaviour = 'retryable';
      const [id] = await emit(1);

      expect(await until(async () => (await attemptRecords(id!)).length >= 2, 15_000)).toBe(true);

      const [first, next] = await attemptRecords(id!);
      const gap = Date.parse(next!.at) - Date.parse(first!.at);

      process.stderr.write(`\n[SC-005] first retry after ${gap} ms (bound 2 000 ms + tolerance)\n`);

      expect(first).toMatchObject({ attempt: 1, classification: 'retryable', reason: 'throttled' });
      expect(next).toMatchObject({ attempt: 2, classification: 'retryable', reason: 'throttled' });
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThan(2_000 + 1_000);

      probe.behaviour = 'ok';

      expect(await until(() => delivered(probe, [id!]), 15_000)).toBe(true);
    });

    /** FR-019: `attempts` is the total, including the first; a budget of two is spent on the second. */
    it('dead-letters a retryable failure when the budget is spent', async () => {
      third.behaviour = 'retryable';
      const [id] = await emit(1);

      const letter = await deadLettered('probe-3', id!, 10_000);

      expect(letter.attempts.map((record) => record.attempt)).toEqual([1, 2]);
      expect(letter.attempts.map((record) => record.classification)).toEqual([
        'retryable',
        'retryable',
      ]);
      expect(letter.poison).toBe(false);
      expect(letter.traceId).toBe('test');
      expect(seenIds(third, [id!])).toEqual([]);
    });

    /**
     * US4 / SC-006 / FR-020: a job whose worker died twice mid-handle is failed on its third pickup
     * before the handler runs, dead-lettered as poison with both stalls on its record, and never
     * offered again — BullMQ's default `maxStalledCount: 1` (research R6).
     *
     * `close(true)` is a faithful stand-in for a crashed worker: a stall is a lock the worker did
     * not renew while the job was active, and a forced close stops the renewal timer with the
     * job still active and the processor still pending — which is exactly what a process death
     * looks like from Redis, with the difference that the pending handle stays in this process
     * and is released at the end so the transaction under it does not outlive the application.
     * The shipped worker on this queue is paused meanwhile: it would take the recovered job under
     * a 30 s lock and each stall would cost 30 s. The three workers here share its processor,
     * strategy and dead-letter listener and differ only in the lock and stall intervals.
     */
    it('quarantines a job after its second stall and never offers it a third time', async () => {
      const timings = { lockDuration: 500, stalledInterval: 500 };
      const shipped = registry.workers.find((worker) => worker.name === 'probe')!;
      const jobOf = async (id: string): Promise<Job<Envelope>> => (await queue.getJob(id))!;
      const stalledTimes = async (id: string): Promise<number> => (await jobOf(id)).stalledCounter;
      const stateOf = async (id: string): Promise<string> => (await jobOf(id)).getState();

      await shipped.pause(true);

      // A paused worker whose blocking fetch is still open takes the next job that arrives.
      expect(await until(() => !shipped.isRunning(), 15_000)).toBe(true);

      // The stall check is throttled queue-wide: `moveStalledJobsToWait` returns at once while
      // this key exists, and the shipped worker set it for its own 30 s interval before it was
      // paused. Gone once, and no longer re-set by the paused checker, the workers below check at
      // the cadence they were built with.
      await store.del(queue.toKey('stalled-check'));

      probe.behaviour = 'stall';
      const workers: Worker<Envelope, void, EventType>[] = [];

      try {
        const a = registry.createWorker([probe], timings);
        workers.push(a);
        const callsBeforeA = probe.handleCalls;
        const [id] = await emit(1);

        expect(await until(() => probe.handleCalls > callsBeforeA, 15_000)).toBe(true);
        await a.close(true);

        const b = registry.createWorker([probe], timings);
        workers.push(b);

        expect(
          await until(
            async () => (await stalledTimes(id!)) === 1 && (await stateOf(id!)) === 'active',
            15_000,
          ),
        ).toBe(true);
        await b.close(true);

        const callsBeforeC = probe.handleCalls;
        const c = registry.createWorker([probe], timings);
        workers.push(c);
        const letter = await deadLettered('probe', id!, 15_000);

        expect(letter.poison).toBe(true);
        expect(letter.failedReason).toBe(STALL_LIMIT_REASON);
        expect(letter.traceId).toBe('test');
        await sourceGone(id!, 5_000);
        expect(probe.handleCalls).toBe(callsBeforeC);
        expect(seenIds(probe, [id!])).toEqual([]);

        probe.behaviour = 'ok';
        const [next] = await emit(1);

        expect(await until(() => delivered(probe, [next!]), 15_000)).toBe(true);
        expect(await queue.getJob(id!)).toBeUndefined();
        expect(seenIds(probe, [id!])).toEqual([]);
      } finally {
        for (const release of probe.stalls.splice(0)) {
          release();
        }

        await Promise.all(workers.map((worker) => worker.close(true)));
        await shipped.resume();
      }
    });
  });
});
