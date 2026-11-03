import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import type { Queue, Worker } from 'bullmq';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { QUEUE_REDIS, STREAM_REDIS } from '../src/common/redis/redis.constants';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../src/database/database.types';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import {
  AGENT_QUEUE,
  AGENT_TIMINGS,
  type AgentTimings,
  RUN_EXECUTOR,
} from '../src/modules/agent/agent.constants';
import { AgentRunConsumer } from '../src/modules/agent/agent-run.consumer';
import type { ExecutionContext, RunExecutor } from '../src/modules/agent/run-executor.port';
import { RunService } from '../src/modules/agent/run.service';
import { RunReaper } from '../src/modules/agent/run-reaper';
import { FencedError, RunStore } from '../src/modules/agent/run-store';
import { ScriptedExecutor, type Step } from '../src/modules/agent/scripted-executor';
import { streamKey } from '../src/modules/agent/stream.constants';
import type { EventConsumer } from '../src/modules/outbox/consumer';
import type { Envelope } from '../src/modules/outbox/envelope';
import type { EventType } from '../src/modules/outbox/events';
import { JOB_RETENTION } from '../src/modules/outbox/outbox.constants';
import { QueueRegistry } from '../src/modules/outbox/queue-registry';
import { OrgService } from '../src/modules/tenancy/services/org.service';
import { ProjectService } from '../src/modules/tenancy/services/project.service';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import { seedProviderKey } from './support/seed-provider-key';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  // No shipped worker, relay or reaper: the suite builds its own workers with short timings,
  // relays the one row by hand and drives the reaper by hand, so every kill lands where it says.
  process.env.RUN_PROFILES = 'api';
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

/** Booting waits on the outbox suite lock, which another relay suite may hold for minutes. */
const LOCKED_BOOT_TIMEOUT_MS = 600_000;
/** A kill, a stall detection and a resume: seconds, with the timings below. */
const CASE_TIMEOUT_MS = 30_000;
/** BullMQ's lock and stall check, shortened as the poison suite does (research R12). */
const WORKER_TIMINGS = { lockDuration: 1_000, stalledInterval: 500 };
const SIX_TOOLS: Step[] = Array.from({ length: 6 }, () => ({ kind: 'tool' }));

/** Polls `predicate` until it holds or `ms` elapse. */
async function until(predicate: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }

    await sleep(25);
  }

  return predicate();
}

/**
 * The scripted fake, with a crash switch. A crashed worker is one whose executor stops mid-step,
 * whose heartbeat stops, and whose pending batch never reaches disk — so the wrapper hangs the
 * `freezeAtToolEnd`-th `tool.end` emit of an attempt on a promise the suite settles at the end,
 * and the suite closes the BullMQ worker around it with `close(true)`, exactly as the poison
 * suite stands in for a dead process. The raw context is kept, so the suite can drive the dead
 * worker's `emit` by hand once another worker holds the run.
 */
class CrashingExecutor implements RunExecutor {
  readonly contexts: ExecutionContext[] = [];
  readonly frozen: (() => void)[] = [];
  freezeAtToolEnd: number | undefined;

  private readonly inner = new ScriptedExecutor();

  execute(context: ExecutionContext) {
    const at = this.freezeAtToolEnd;
    let toolEnds = 0;

    this.contexts.push(context);

    return this.inner.execute({
      ...context,
      emit: (event) => {
        if (event.type === 'tool.end' && at !== undefined && (toolEnds += 1) === at) {
          return new Promise<void>((_resolve, reject) => {
            this.frozen.push(() => reject(new Error('the crashed worker was released')));
          });
        }

        return context.emit(event);
      },
    });
  }

  release(): void {
    for (const release of this.frozen.splice(0)) {
      release();
    }
  }
}

/**
 * Spec 008 US2 — the §17 "Duplicate safety" gate (SC-003, SC-004). A worker is killed inside each
 * of six tool steps; a second worker takes the same job when BullMQ detects the stall, claims the
 * run under the next epoch, resumes from what is on disk, and finishes. Every milestone ends up
 * on disk exactly once, a redone step is marked, `seq` is contiguous, and every late write from
 * the dead worker is refused. Two batch timings per kill: one where the dead worker's `tool.start`
 * had been flushed (the resumed step is a marked duplicate) and one where nothing had (the run
 * restarts from the top with nothing to mark). The last case kills both workers and lets the
 * reaper fail the run.
 */
describe('Agent run fencing (e2e)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and the queue Redis role', () => {
    let app: INestApplication;
    let db: ForgeDatabase;
    let store: Redis;
    let transactions: TenantTransactionRunner;
    let runs: RunService;
    let runStore: RunStore;
    let registry: QueueRegistry;
    let consumer: AgentRunConsumer;
    let reaper: RunReaper;
    let queue: Queue<Envelope, void, EventType>;
    let suiteLock: { release: () => Promise<void> } | undefined;
    let orgId: string;
    let projectId: string;
    let userId: string;
    const executor = new CrashingExecutor();
    const workers: Worker<Envelope, void, EventType>[] = [];
    /** Mutable on purpose: the consumer and the batcher read it at run time, so a case can retune it. */
    const timings: { -readonly [K in keyof AgentTimings]: AgentTimings[K] } = {
      batchMs: 10,
      batchSize: 32,
      heartbeatMs: 60_000,
      leaseTtlMs: 1_000,
      reaperMs: 60_000,
      staleAfterMs: 60_000,
      providerAttempts: 3,
      providerBackoffBaseMs: 1_000,
      providerBackoffCapMs: 10_000,
      cancelPollMs: 500,
      summaryMs: 30_000,
    };

    function inTenant<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantTransaction(orgId, fn);
    }

    /** A run created the product's way, then relayed by hand: its outbox row becomes the one job. */
    async function dispatched(steps: Step[]): Promise<string> {
      const run = await transactions.runInTenantScope({ orgId, userId }, () =>
        runs.create(orgId, projectId, userId, JSON.stringify({ script: steps })),
      );
      const [row] = await db
        .select()
        .from(schema.outbox)
        .where(
          and(eq(schema.outbox.type, 'agent-run.requested'), eq(schema.outbox.aggregateId, run.id)),
        );

      await queue.add(
        'agent-run.requested',
        {
          aggregate: row!.aggregate,
          aggregateId: row!.aggregateId,
          eventId: row!.id,
          occurredAt: row!.occurredAt.toISOString(),
          orgId: row!.originOrgId,
          payload: row!.payload as Envelope<'agent-run.requested'>['payload'],
          traceId: row!.traceId,
          type: 'agent-run.requested',
        },
        {
          attempts: consumer.attempts,
          backoff: { type: 'full-jitter' },
          jobId: row!.id,
          ...JOB_RETENTION,
        },
      );
      await db
        .update(schema.outbox)
        .set({ publishedAt: new Date() })
        .where(eq(schema.outbox.id, row!.id));

      return run.id;
    }

    function worker(): Worker<Envelope, void, EventType> {
      // The registry's list is typed for the effect-less consumer; discovery casts the same way.
      const built = registry.createWorker([consumer as unknown as EventConsumer], WORKER_TIMINGS);

      workers.push(built);

      return built;
    }

    async function row(runId: string) {
      const [found] = await inTenant((tx) =>
        tx.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId)),
      );

      return found!;
    }

    async function events(runId: string) {
      return inTenant((tx) =>
        tx
          .select({
            data: schema.runEvents.data,
            seq: schema.runEvents.seq,
            type: schema.runEvents.type,
          })
          .from(schema.runEvents)
          .where(eq(schema.runEvents.runId, runId))
          .orderBy(asc(schema.runEvents.seq)),
      );
    }

    async function ofType(runId: string, type: string) {
      return (await events(runId)).filter((event) => event.type === type);
    }

    /** Starts a worker, lets it run `runId` until the executor freezes, and kills it there. */
    async function crashInside(toolEnd: number, runId: string): Promise<ExecutionContext> {
      const frozenBefore = executor.frozen.length;

      executor.freezeAtToolEnd = toolEnd;

      const victim = worker();

      expect(await until(() => executor.frozen.length > frozenBefore, 10_000)).toBe(true);

      executor.freezeAtToolEnd = undefined;
      await victim.close(true);

      // The step whose end never came: its start is on disk iff the batch timer had run.
      expect((await row(runId)).status).toBe('running');

      return executor.contexts.at(-1)!;
    }

    /** SC-004: the dead worker's next write, however it is driven, is refused and lands nowhere. */
    async function assertFenced(context: ExecutionContext, runId: string): Promise<void> {
      const before = (await events(runId)).length;
      const late = async () => {
        for (let i = 0; i < timings.batchSize; i += 1) {
          await context.emit({ data: { checkpointId: `late-${i}` }, type: 'checkpoint' });
        }
      };

      await expect(late()).rejects.toThrow(FencedError);
      expect((await events(runId)).length).toBe(before);
    }

    beforeAll(async () => {
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(RUN_EXECUTOR)
        .useValue(executor)
        .overrideProvider(AGENT_TIMINGS)
        .useValue(timings)
        .compile();

      // A job left by an earlier run would be taken first and land inside a case's counting.
      store = moduleRef.get<Redis>(QUEUE_REDIS);
      const stale = await store.keys(`bull:${AGENT_QUEUE}*`);

      if (stale.length > 0) {
        await store.del(...stale);
      }

      app = moduleRef.createNestApplication();
      configureApplication(app);
      await app.init();

      db = app.get<ForgeDatabase>(APP_DATABASE);
      transactions = app.get(TenantTransactionRunner);
      runs = app.get(RunService);
      runStore = app.get(RunStore);
      registry = app.get(QueueRegistry);
      consumer = app.get(AgentRunConsumer);
      reaper = app.get(RunReaper);

      const [user] = await db
        .insert(schema.users)
        .values({ email: `008f-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });

      userId = user!.id;

      const org = await app
        .get(OrgService)
        .create(userId, { name: 'Fencing fixture', slug: `008f-${randomUUID().slice(0, 8)}` });

      orgId = org.id;
      // Run create resolves a credential; the organisation's key, which the scripted executor
      // never reads (platform credits are retired).
      await seedProviderKey(app, { orgId, owner: { userId } });

      const [workspace] = await inTenant((tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      );
      const project = await transactions.runInTenantScope({ orgId, userId }, () =>
        app.get(ProjectService).create({
          actorId: userId,
          name: 'Fencing',
          orgId,
          ownerId: userId,
          workspaceId: workspace!.id,
        }),
      );

      projectId = project.id;

      // Opening a worker opens the queue; the queue is what the hand relay adds to.
      await worker().close();
      workers.splice(0);
      queue = registry.queues.get(AGENT_QUEUE) as Queue<Envelope, void, EventType>;
    }, LOCKED_BOOT_TIMEOUT_MS);

    afterEach(async () => {
      executor.freezeAtToolEnd = undefined;
      executor.release();
      await Promise.all(workers.splice(0).map((built) => built.close(true)));
      // The stall check is throttled queue-wide by this key; a fresh case starts with a fresh clock.
      await store.del(queue.toKey('stalled-check'));
    });

    afterAll(async () => {
      executor.release();
      await db.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
      await db.delete(schema.users).where(inArray(schema.users.id, [userId]));
      await app?.close();
      await suiteLock?.release();
    });

    describe.each([
      ['flushed', 10],
      ['unflushed', 60_000],
    ])('with the dead worker’s last batch %s', (mode, batchMs) => {
      it.each([1, 2, 3, 4, 5, 6])(
        'resumes under epoch 2 after a kill inside tool %i, every milestone once, late writes refused',
        async (k) => {
          timings.batchMs = batchMs;

          const runId = await dispatched(SIX_TOOLS);
          const dead = await crashInside(k, runId);
          const starts = async () => (await ofType(runId, 'tool.start')).length;

          // What the dead worker left on disk: through step k-1 and the start of step k, or nothing.
          if (mode === 'flushed') {
            expect(await until(async () => (await starts()) === k, 2_000)).toBe(true);
          } else {
            expect(await starts()).toBe(0);
          }

          worker();

          expect(await until(async () => (await row(runId)).status === 'succeeded', 15_000)).toBe(
            true,
          );

          const after = await row(runId);
          const all = await events(runId);
          const stepIds = (type: string) =>
            all.filter((event) => event.type === type).map((event) => String(event.data.stepId));

          expect(after).toMatchObject({ leaseEpoch: 2, leaseUntil: null, status: 'succeeded' });
          expect(all.map((event) => event.seq)).toEqual(all.map((_event, index) => index + 1));
          expect(
            all.filter((event) => event.type === 'state').map((event) => event.data.to),
          ).toEqual(['queued', 'starting', 'running', 'succeeded']);
          expect(stepIds('tool.end').sort()).toEqual(
            Array.from({ length: 6 }, (_step, index) => `${runId}/${index}`).sort(),
          );

          const duplicates = all.filter((event) => event.type === 'usage');

          if (mode === 'flushed') {
            // The dead worker's tool.start for step k-1 was committed; the resumed attempt redid
            // the step and said so (FR-019).
            expect(duplicates).toHaveLength(1);
            expect(duplicates[0]!.data).toMatchObject({ duplicateOf: `${runId}/${k - 1}` });
            expect(stepIds('tool.start').filter((id) => id === `${runId}/${k - 1}`)).toHaveLength(
              2,
            );
            expect(stepIds('tool.start')).toHaveLength(7);
          } else {
            expect(duplicates).toEqual([]);
            expect(stepIds('tool.start')).toHaveLength(6);
          }

          await assertFenced(dead, runId);

          // Letting the dead worker go flushes whatever it still held — refused, nothing lands.
          const before = all.length;

          executor.release();
          await sleep(100);

          expect((await events(runId)).length).toBe(before);
        },
        CASE_TIMEOUT_MS,
      );
    });

    /** FR-020: no worker comes back; the reaper is what ends the run, under a third epoch. */
    it(
      'fails a run as stalled when both workers die and the reaper finds the lease cold',
      async () => {
        timings.batchMs = 10;

        const runId = await dispatched(SIX_TOOLS);
        const first = await crashInside(2, runId);

        // The second worker resumes, redoes step 1 as a marked duplicate, and dies two tools later.
        const second = await crashInside(2, runId);

        expect((await row(runId)).leaseEpoch).toBe(2);

        // Cold means older than staleAfterMs; the lease was a second long.
        timings.staleAfterMs = 0;
        await sleep(timings.leaseTtlMs + 100);

        // At least this run: the sweep is every tenant, and another suite may have left a cold one.
        expect(await reaper.tick()).toBeGreaterThanOrEqual(1);

        const after = await row(runId);

        expect(after).toMatchObject({
          failureClass: 'stalled',
          leaseEpoch: 3,
          leaseUntil: null,
          status: 'failed',
        });
        expect(after.endedAt).not.toBeNull();
        expect((await events(runId)).at(-1)).toMatchObject({
          data: { from: 'running', reason: 'stalled', to: 'failed' },
          type: 'state',
        });
        expect((await row(runId)).leaseEpoch).toBe(3);

        await assertFenced(first, runId);
        await assertFenced(second, runId);

        timings.staleAfterMs = 60_000;
      },
      CASE_TIMEOUT_MS,
    );

    /** Spec 009 US3 (SC-007): a fenced worker's stream-only events stop too, before the stream. */
    it(
      'refuses a fenced worker’s token and appends nothing to the stream',
      async () => {
        timings.batchMs = 10;

        const stream = app.get<Redis>(STREAM_REDIS);
        const runId = await dispatched(SIX_TOOLS);
        const dead = await crashInside(2, runId);

        worker();

        expect(await until(async () => (await row(runId)).status === 'succeeded', 15_000)).toBe(
          true,
        );
        await assertFenced(dead, runId);

        const length = await stream.xlen(streamKey(runId));

        await expect(dead.emit({ data: { text: 'late' }, type: 'token' })).rejects.toThrow(
          FencedError,
        );
        expect(await stream.xlen(streamKey(runId))).toBe(length);
      },
      CASE_TIMEOUT_MS,
    );

    /** R5: a live worker's heartbeat is what keeps a second claim out during a long step. */
    it(
      'keeps the lease while the worker is alive, so a second claim waits it out',
      async () => {
        timings.heartbeatMs = 100;
        timings.leaseTtlMs = 400;

        const runId = await dispatched([{ kind: 'sleep', ms: 1_200 }]);

        worker();

        expect(await until(async () => (await row(runId)).status === 'running', 10_000)).toBe(true);

        const claimed = (await row(runId)).leaseUntil!;

        await sleep(800);

        const later = await row(runId);
        const rival = await inTenant((tx) =>
          runStore.claim(tx, { leaseTtlMs: 400, orgId, owner: 'rival', runId }),
        );

        expect(later.status).toBe('running');
        expect(later.leaseUntil!.getTime()).toBeGreaterThan(claimed.getTime());
        expect(rival).toEqual({ heldUntil: expect.any(Date) as Date });
        expect((rival as { heldUntil: Date }).heldUntil.getTime()).toBeGreaterThanOrEqual(
          later.leaseUntil!.getTime(),
        );
        expect(await until(async () => (await row(runId)).status === 'succeeded', 10_000)).toBe(
          true,
        );
        expect((await row(runId)).leaseEpoch).toBe(1);

        timings.heartbeatMs = 60_000;
        timings.leaseTtlMs = 1_000;
      },
      CASE_TIMEOUT_MS,
    );
  });
});
