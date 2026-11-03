import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import type { Queue, Worker } from 'bullmq';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { QUEUE_REDIS } from '../src/common/redis/redis.constants';
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
import { AGENT_LINE_QUEUE, RunQueueConsumer } from '../src/modules/agent/run-queue.consumer';
import { RunService } from '../src/modules/agent/run.service';
import { ScriptedExecutor, type Step } from '../src/modules/agent/scripted-executor';
import type { EventConsumer } from '../src/modules/outbox/consumer';
import type { Envelope } from '../src/modules/outbox/envelope';
import type { EventType } from '../src/modules/outbox/events';
import { JOB_RETENTION } from '../src/modules/outbox/outbox.constants';
import { QueueRegistry } from '../src/modules/outbox/queue-registry';
import { OrgService } from '../src/modules/tenancy/services/org.service';
import { ProjectService } from '../src/modules/tenancy/services/project.service';
import { openPool } from './support/integration-database';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import { seedProviderKey } from './support/seed-provider-key';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  // No shipped worker or relay: the suite relays its own org's agent rows by hand.
  process.env.RUN_PROFILES = 'api';
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const LOCKED_BOOT_TIMEOUT_MS = 600_000;
const CASE_TIMEOUT_MS = 60_000;
const TERMINAL = ['succeeded', 'failed', 'cancelled'];
/** Long enough that two runs dispatched together overlap if nothing serialises them. */
const SLOW: Step[] = [{ kind: 'tool' }, { kind: 'sleep', ms: 400 }, { kind: 'succeed' }];

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
 * Spec 031 US1 — one writer per project. Walk 0 (T012) proves the gap: two runs started on one
 * project at once must never both hold it. Against Postgres and the queue Redis role.
 */
describe('The run line (e2e)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and the queue Redis role', () => {
    let app: INestApplication;
    let db: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    let runs: RunService;
    let registry: QueueRegistry;
    let consumers: EventConsumer[];
    const queues = new Map<string, Queue<Envelope, void, EventType>>();
    let suiteLock: { release: () => Promise<void> } | undefined;
    let orgId: string;
    let userId: string;
    let workspaceId: string;
    let pump: NodeJS.Timeout | undefined;
    const workers: Worker<Envelope, void, EventType>[] = [];
    const timings: AgentTimings = {
      batchMs: 10,
      batchSize: 32,
      cancelPollMs: 500,
      heartbeatMs: 60_000,
      leaseTtlMs: 30_000,
      providerAttempts: 3,
      providerBackoffBaseMs: 1_000,
      providerBackoffCapMs: 10_000,
      reaperMs: 60_000,
      staleAfterMs: 60_000,
      summaryMs: 30_000,
    };

    function inTenant<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantTransaction(orgId, fn);
    }

    async function project(): Promise<string> {
      const created = await transactions.runInTenantScope({ orgId, userId }, () =>
        app.get(ProjectService).create({
          actorId: userId,
          name: `Line ${randomUUID().slice(0, 8)}`,
          orgId,
          ownerId: userId,
          workspaceId,
        }),
      );

      return created.id;
    }

    function create(projectId: string, steps: Step[] = SLOW) {
      return transactions.runInTenantScope({ orgId, userId }, () =>
        runs.create(orgId, projectId, userId, JSON.stringify({ script: steps })),
      );
    }

    /** The relay, for this org's rows the agent queue's consumers take. */
    async function relay(): Promise<void> {
      const types = consumers.flatMap((consumer) => [...consumer.types]);
      const rows = await db
        .select()
        .from(schema.outbox)
        .where(
          and(
            eq(schema.outbox.originOrgId, orgId),
            isNull(schema.outbox.publishedAt),
            inArray(schema.outbox.type, types),
          ),
        );

      for (const row of rows) {
        const consumer = consumers.find((each) =>
          (each.types as readonly string[]).includes(row.type),
        )!;

        await queues.get(consumer.queue)!.add(
          row.type as EventType,
          {
            aggregate: row.aggregate,
            aggregateId: row.aggregateId,
            eventId: row.id,
            occurredAt: row.occurredAt.toISOString(),
            orgId: row.originOrgId,
            payload: row.payload as Envelope['payload'],
            traceId: row.traceId,
            type: row.type as EventType,
          },
          { attempts: 3, backoff: { type: 'full-jitter' }, jobId: row.id, ...JOB_RETENTION },
        );
        await db
          .update(schema.outbox)
          .set({ publishedAt: new Date() })
          .where(eq(schema.outbox.id, row.id));
      }
    }

    function startPump(): void {
      let busy = false;

      pump = setInterval(() => {
        if (busy) return;
        busy = true;
        void relay().finally(() => {
          busy = false;
        });
      }, 50);
    }

    function worker(): void {
      for (const consumer of consumers) {
        workers.push(registry.createWorker([consumer]));
      }
    }

    async function rowsOf(projectId: string) {
      return inTenant((tx) =>
        tx.select().from(schema.agentRuns).where(eq(schema.agentRuns.projectId, projectId)),
      );
    }

    /** Samples every 50 ms until every run on the project ends; the most holders seen at once. */
    async function watchHolders(projectId: string, ms: number): Promise<number> {
      const deadline = Date.now() + ms;
      let most = 0;

      while (Date.now() < deadline) {
        const all = await rowsOf(projectId);
        const holders = all.filter(
          (run) => run.startedAt !== null && !TERMINAL.includes(run.status),
        ).length;

        most = Math.max(most, holders);

        if (all.every((run) => TERMINAL.includes(run.status))) {
          break;
        }

        await sleep(50);
      }

      return most;
    }

    beforeAll(async () => {
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(RUN_EXECUTOR)
        .useValue(new ScriptedExecutor())
        .overrideProvider(AGENT_TIMINGS)
        .useValue(timings)
        .compile();
      const store = moduleRef.get<Redis>(QUEUE_REDIS);
      const stale = [
        ...(await store.keys(`bull:${AGENT_QUEUE}*`)),
        ...(await store.keys(`bull:${AGENT_LINE_QUEUE}*`)),
      ];

      if (stale.length > 0) {
        await store.del(...stale);
      }

      app = moduleRef.createNestApplication();
      configureApplication(app);
      await app.init();

      db = app.get<ForgeDatabase>(APP_DATABASE);
      transactions = app.get(TenantTransactionRunner);
      runs = app.get(RunService);
      registry = app.get(QueueRegistry);
      consumers = [app.get(AgentRunConsumer), app.get(RunQueueConsumer)];

      const [user] = await db
        .insert(schema.users)
        .values({ email: `031l-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });

      userId = user!.id;

      const org = await app
        .get(OrgService)
        .create(userId, { name: 'Line fixture', slug: `031l-${randomUUID().slice(0, 8)}` });

      orgId = org.id;
      // Run create resolves a credential; the organisation's key, which the scripted executor
      // never reads (platform credits are retired).
      await seedProviderKey(app, { orgId, owner: { userId } });

      const [workspace] = await inTenant((tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      );

      workspaceId = workspace!.id;
      for (const consumer of consumers) {
        await registry.createWorker([consumer]).close();
        queues.set(
          consumer.queue,
          registry.queues.get(consumer.queue) as Queue<Envelope, void, EventType>,
        );
      }
    }, LOCKED_BOOT_TIMEOUT_MS);

    afterEach(async () => {
      clearInterval(pump);
      await Promise.all(workers.splice(0).map((built) => built.close(true)));
    });

    afterAll(async () => {
      await db.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
      await db.delete(schema.users).where(eq(schema.users.id, userId));
      await app?.close();
      await suiteLock?.release();
    });

    it(
      'two runs started on one project at once never both hold it',
      async () => {
        const projectId = await project();

        await Promise.all([create(projectId), create(projectId)]);
        worker();
        startPump();

        const most = await watchHolders(projectId, 20_000);
        const ended = await rowsOf(projectId);

        expect(most).toBeLessThanOrEqual(1);
        expect(ended.map((run) => run.status)).toEqual(['succeeded', 'succeeded']);
      },
      CASE_TIMEOUT_MS,
    );

    /** SC-001, FR-012: however many start together, one holds at a time and each run's work is one block. */
    it.each([2, 5, 10])(
      '%i creates at once never produce two holders, and each run\u2019s checkpoints are contiguous in the chain',
      async (n) => {
        const projectId = await project();
        const settled = await Promise.allSettled(
          Array.from({ length: n }, () => create(projectId)),
        );
        const accepted = settled.filter((result) => result.status === 'fulfilled').length;
        const refused = settled.filter((result) => result.status === 'rejected');

        // The first create may already be the head, so up to RUN_LINE_LIMIT wait behind nothing.
        expect(accepted).toBe(Math.min(n, 5));
        for (const failure of refused) {
          expect(failure.reason).toMatchObject({
            extensions: { reason: 'queue-full' },
          });
        }

        worker();
        startPump();

        const most = await watchHolders(projectId, 45_000);
        const ended = await rowsOf(projectId);

        expect(most).toBeLessThanOrEqual(1);
        expect(ended.every((run) => run.status === 'succeeded')).toBe(true);

        // Each run held the project for one unbroken span, and no two spans overlap: the
        // checkpoints each run left sit together in the chain.
        const spans = ended
          .map((run) => [run.startedAt!.getTime(), run.endedAt!.getTime()] as const)
          .sort((a, b) => a[0] - b[0]);

        for (let i = 1; i < spans.length; i += 1) {
          expect(spans[i]![0]).toBeGreaterThanOrEqual(spans[i - 1]![1]);
        }
      },
      CASE_TIMEOUT_MS,
    );

    /** SC-002 */
    it(
      'the next run starts within 5 s of the holder succeeding',
      async () => {
        const projectId = await project();
        const first = await create(projectId);
        const second = await create(projectId);

        worker();
        startPump();

        expect(
          await until(async () => {
            const all = await rowsOf(projectId);

            return all.every((run) => run.status === 'succeeded');
          }, 20_000),
        ).toBe(true);

        const all = await rowsOf(projectId);
        const a = all.find((run) => run.id === first.id)!;
        const b = all.find((run) => run.id === second.id)!;

        expect(b.startedAt!.getTime() - a.endedAt!.getTime()).toBeLessThan(5_000);
      },
      CASE_TIMEOUT_MS,
    );

    it(
      'a sixth waiting run is refused 409 queue-full',
      async () => {
        const projectId = await project();

        for (let i = 0; i < 5; i += 1) {
          await create(projectId);
        }

        await expect(create(projectId)).rejects.toMatchObject({
          extensions: { reason: 'queue-full' },
          type: 'conflict',
        });
        expect(await rowsOf(projectId)).toHaveLength(5);
      },
      CASE_TIMEOUT_MS,
    );

    it(
      'the database refuses a second started non-terminal run on one project',
      async () => {
        const projectId = await project();
        const started = { model: 'fake', orgId, projectId, startedAt: new Date(), userId };

        await inTenant((tx) =>
          tx.insert(schema.agentRuns).values({ ...started, status: 'running' }),
        );
        await expect(
          inTenant((tx) =>
            tx.insert(schema.agentRuns).values({ ...started, status: 'awaiting_input' }),
          ),
        ).rejects.toMatchObject({ cause: { constraint: 'agent_runs_one_holder_per_project' } });
      },
      CASE_TIMEOUT_MS,
    );

    it(
      'migration 0043 cancels all but the oldest started run on a project and creates the index',
      async () => {
        const projectId = await project();
        const pool = openPool(process.env.DATABASE_MIGRATION_URL ?? '');
        const client = await pool.connect();
        const migration = readFileSync(
          join(__dirname, '../../../packages/db/migrations/0043_one_holder_per_project.sql'),
          'utf8',
        );

        try {
          // One transaction, rolled back: the seed exists only before the migration, as on a
          // database that predates 031, and nobody else sees the index missing.
          await client.query('begin');
          await client.query(`select set_config('app.org_id', $1, true)`, [orgId]);
          await client.query('drop index agent_runs_one_holder_per_project');
          await client.query('drop index agent_runs_line_idx');

          const seeded: string[] = [];

          for (const [offset, status] of [
            [3, 'running'],
            [2, 'awaiting_input'],
            [1, 'paused'],
          ] as const) {
            const { rows } = await client.query<{ id: string }>(
              `insert into agent_runs (org_id, project_id, user_id, model, status, started_at)
               values ($1, $2, $3, 'fake', $4, now() - make_interval(mins => $5)) returning id`,
              [orgId, projectId, userId, status, offset],
            );

            seeded.push(rows[0]!.id);
          }

          for (const statement of migration.split('--> statement-breakpoint')) {
            await client.query(statement);
          }

          const { rows: after } = await client.query<{
            ended: boolean;
            id: string;
            status: string;
          }>(
            `select id, status, ended_at is not null as ended from agent_runs where project_id = $1`,
            [projectId],
          );
          const byId = new Map(after.map((row) => [row.id, row]));

          expect(byId.get(seeded[0]!)).toMatchObject({ ended: false, status: 'running' });
          expect(byId.get(seeded[1]!)).toMatchObject({ ended: true, status: 'cancelled' });
          expect(byId.get(seeded[2]!)).toMatchObject({ ended: true, status: 'cancelled' });

          const { rows: indexes } = await client.query<{ indexname: string }>(
            `select indexname from pg_indexes where tablename = 'agent_runs'
               and indexname in ('agent_runs_one_holder_per_project', 'agent_runs_line_idx')`,
          );

          expect(indexes.map((row) => row.indexname).sort()).toEqual([
            'agent_runs_line_idx',
            'agent_runs_one_holder_per_project',
          ]);
        } finally {
          await client.query('rollback');
          client.release();
          await pool.end();
        }
      },
      CASE_TIMEOUT_MS,
    );
  });
});
