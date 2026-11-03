import { type INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type RunResponse, runResponseSchema } from '@repo/contracts';
import { schema } from '@repo/db';
import type { Queue } from 'bullmq';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { CLOCK } from '../src/common/clock/clock.port';
import { FakeClock } from '../src/common/clock/fake-clock';
import { QUEUE_REDIS } from '../src/common/redis/redis.constants';
import { RUN_PROFILES_TOKEN } from '../src/common/run-profiles/run-profiles.constants';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import {
  AGENT_TIMINGS,
  type AgentTimings,
  LLM_PROVIDER,
} from '../src/modules/agent/agent.constants';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../src/modules/identity/password/breached-password.port';
import { LivenessServer } from '../src/modules/health/liveness-server';
import type { DeadLetter, DeadLetterQueue } from '../src/modules/outbox/dead-letter';
import type { Envelope } from '../src/modules/outbox/envelope';
import { type EventPayload, EVENTS } from '../src/modules/outbox/events';
import { OutboxWriter } from '../src/modules/outbox/outbox-writer';
import { REPO_MIRROR_QUEUE } from '../src/modules/checkpoints/repo-mirror.consumer';
import { QueueRegistry } from '../src/modules/outbox/queue-registry';
import { MaintenanceConsumer } from '../src/modules/sandbox/maintenance.consumer';
import { MaintenanceScheduler } from '../src/modules/sandbox/maintenance.scheduler';
import { PoolRefill } from '../src/modules/sandbox/pool-refill';
import {
  DEFAULT_SANDBOX_TIMINGS,
  MAINTENANCE_JOBS,
  MAINTENANCE_LOCK,
  MAINTENANCE_QUEUE,
  poolFrontKey,
  SANDBOX_OPS_QUEUE,
  SANDBOX_TIMINGS,
  type MaintenanceJob,
  type SandboxTimings,
} from '../src/modules/sandbox/sandbox.constants';
import { SandboxService } from '../src/modules/sandbox/sandbox.service';
import { SandboxReconciler } from '../src/modules/sandbox/sandbox-reconciler';
import { SandboxSweep } from '../src/modules/sandbox/sandbox-sweep';
import { ProjectService } from '../src/modules/tenancy/services/project.service';
import { unsafe } from './support/csrf-client';
import { type FakeDaytona, startFakeDaytona } from './support/fake-daytona';
import { fakeGit } from './support/fake-git';
import { dropFakeVersions, publishFakeVersion } from './support/template-versions';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import { ScriptedProvider } from './support/scripted-provider';
import { seedProviderKey } from './support/seed-provider-key';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  http,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

/**
 * Before any import, as `agent-core.e2e-spec.ts`: `ConfigModule.forRoot` reads the environment
 * when `AppModule` is loaded. `api` for the routes the fixture seeds through, `agent` for the run
 * worker, `events` for the `sandbox.ops` consumer that settles a create and applies a label.
 */
const FAKE = vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  process.env.RUN_PROFILES = 'api,agent,events';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.THROTTLE_LIMIT = '100000';

  const port = 20_000 + Math.floor(Math.random() * 20_000);
  process.env.DAYTONA_API_URL = `http://127.0.0.1:${port}/api`;
  process.env.DAYTONA_API_KEY = 'dtn_fake_key';

  return { port };
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const ORGS = '/api/v1/orgs';
/** Booting waits on the outbox suite lock, which another relay suite may hold for minutes. */
const LOCKED_BOOT_TIMEOUT_MS = 600_000;
/** The relay ticks at 50 ms and every sandbox clock below is milliseconds: a run is seconds. */
const RUN_TIMEOUT_MS = 15_000;
/** The fixture's projects are `vite-react` (`ProjectService.create`'s default). */
const TEMPLATE = 'vite-react' as const;
/** Unique per run of this suite, so the pool rows it wipes are the ones its refill made. */
const SNAPSHOT = `forge/lifecycle-e2e:${randomUUID().slice(0, 8)}`;
/** SC-011's clock starts past here: no other suite's `maintenance.due` rows share its keys. */
const FAR_FUTURE = Date.UTC(2100, 0, 1);
/** SC-011's walk ticks at these offsets from an instant aligned to every period. */
const HANDOVER_OFFSETS_MS: readonly number[] = [0, 60_000, 300_000, 360_000];
/**
 * How many catalogue jobs turn a period at `offsetMs` past that aligned instant. Derived from
 * `MAINTENANCE_JOBS` rather than typed out, so a new job is counted in every assertion that depends
 * on the catalogue — a literal here drifted once already (spec 026's `webhook.retention`).
 */
const dueAt = (offsetMs: number): number =>
  MAINTENANCE_JOBS.filter(({ periodMs }) => offsetMs % periodMs === 0).length;
/** Every `maintenance.due` the walk appends: one per job per period it reaches. */
const HANDOVER_DUE = HANDOVER_OFFSETS_MS.reduce((total, offset) => total + dueAt(offset), 0);
/** Seconds and milliseconds in place of minutes (quickstart § Integration). */
const SANDBOX: SandboxTimings = {
  ...DEFAULT_SANDBOX_TIMINGS,
  readyBudgetMs: 5_000,
  readyPollMs: 50,
  runWaitMs: RUN_TIMEOUT_MS,
  runWaitPollMs: 50,
};
/** As `agent-core.e2e-spec.ts`: every interval short, so leases and polls land in test time. */
const AGENT: AgentTimings = {
  batchMs: 10,
  batchSize: 32,
  cancelPollMs: 20,
  summaryMs: 30_000,
  heartbeatMs: 200,
  leaseTtlMs: 1_000,
  providerAttempts: 3,
  providerBackoffBaseMs: 10,
  providerBackoffCapMs: 50,
  reaperMs: 60_000,
  staleAfterMs: 60_000,
};

class ScriptedBreachPort implements BreachedPasswordPort {
  isBreached(_password: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/** Polls `predicate` until it holds or `ms` elapse; throws naming `what` when it never does. */
async function until(what: string, predicate: () => Promise<boolean>, ms = RUN_TIMEOUT_MS) {
  const deadline = Date.now() + ms;

  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Spec 014 US1 (quickstart § Integration, the four US1 rows): the real `AgentExecutor` over the
 * real queue, its pre-flight reaching `SandboxLifecycle.ensureReady`, the claim on the real
 * `queue` Redis front and the real `sandbox_pool` table, the `sandbox.ops` consumer settling a
 * create and applying the project label at a fake Daytona. The pool is seeded by calling
 * `PoolRefill.refill()` directly, the way the maintenance job does.
 */
describe('Sandbox lifecycle (e2e)', () => {
  describe.skipIf(!postgres || !redis)(
    'against Postgres, the queue Redis and a fake Daytona',
    () => {
      let app: INestApplication;
      let fake: FakeDaytona;
      let world: TwoTenantWorld;
      let db: ForgeDatabase;
      let queue: Redis;
      let transactions: TenantTransactionRunner;
      let refill: PoolRefill;
      let sweep: SandboxSweep;
      let reconciler: SandboxReconciler;
      let sandboxPort: SandboxService;
      let suiteLock: { release: () => Promise<void> } | undefined;
      const provider = new ScriptedProvider();

      const runsPath = (projectId: string) =>
        `${ORGS}/${world.alpha.orgId}/projects/${projectId}/runs`;

      /** A run created the product's way, by alpha's owner; the relay and the worker do the rest. */
      async function createRun(projectId: string, prompt: string): Promise<RunResponse> {
        const response = await unsafe(http(app).post(runsPath(projectId)), [
          world.alpha.owner.cookie,
        ])
          .send({ prompt })
          .expect(201);

        return runResponseSchema.parse(response.body);
      }

      async function read(projectId: string, runId: string): Promise<RunResponse> {
        const response = await http(app)
          .get(`${runsPath(projectId)}/${runId}`)
          .set('Cookie', world.alpha.owner.cookie)
          .expect(200);

        return runResponseSchema.parse(response.body);
      }

      /** Polls the run through the API until it reports `status`; resolves with that read. */
      async function waitFor(projectId: string, runId: string, status: RunResponse['status']) {
        let run: RunResponse | undefined;

        await until(`run ${runId} to be ${status}`, async () => {
          run = await read(projectId, runId);
          return run.status === status;
        });
        // 016: each checkpoint's mirror job bundles in the sandbox after the run — a sign of use
        // that would flip a row this suite has just idled. Let it land before the clocks move.
        const mirror = app.get(QueueRegistry).queues.get(REPO_MIRROR_QUEUE)!;
        await until('the mirror jobs to settle', async () => {
          const [unpublished] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(schema.outbox)
            .where(
              and(eq(schema.outbox.type, 'checkpoint.created'), isNull(schema.outbox.publishedAt)),
            );
          if (unpublished!.count > 0) return false;
          const counts = await mirror.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
          return Object.values(counts).every((count) => count === 0);
        });

        return run!;
      }

      /** The durable event log in `seq` order, read under alpha's scope. */
      async function events(runId: string) {
        return transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx
            .select({ data: schema.runEvents.data, type: schema.runEvents.type })
            .from(schema.runEvents)
            .where(eq(schema.runEvents.runId, runId))
            .orderBy(asc(schema.runEvents.seq)),
        );
      }

      /** A second live project in alpha, owned by alpha's owner, on the fixture's template. */
      async function anotherProject(name: string): Promise<string> {
        const { orgId, owner, workspaceId } = world.alpha;
        const project = await transactions.runInTenantScope({ orgId, userId: owner.userId }, () =>
          app
            .get(ProjectService)
            .create({ actorId: owner.userId, name, orgId, ownerId: owner.userId, workspaceId }),
        );

        return project.id;
      }

      async function sandboxRow(projectId: string) {
        return transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx.query.sandboxes.findFirst({
            where: and(
              eq(schema.sandboxes.orgId, world.alpha.orgId),
              eq(schema.sandboxes.projectId, projectId),
            ),
          }),
        );
      }

      async function sandboxRows(projectId: string) {
        return transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx
            .select()
            .from(schema.sandboxes)
            .where(
              and(
                eq(schema.sandboxes.orgId, world.alpha.orgId),
                eq(schema.sandboxes.projectId, projectId),
              ),
            ),
        );
      }

      /** This suite's pool rows: the ones its refill created from `SNAPSHOT`. */
      const poolRows = () =>
        db.select().from(schema.sandboxPool).where(eq(schema.sandboxPool.snapshot, SNAPSHOT));

      async function auditsFor(target: string) {
        return transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx
            .select({ action: schema.auditLog.action, metadata: schema.auditLog.metadata })
            .from(schema.auditLog)
            .where(
              and(
                eq(schema.auditLog.target, target),
                eq(schema.auditLog.action, 'sandbox.claimed'),
              ),
            ),
        );
      }

      async function opsFor(sandboxId: string) {
        const rows = await db
          .select({ payload: schema.outbox.payload })
          .from(schema.outbox)
          .where(
            and(
              eq(schema.outbox.type, 'sandbox.op.requested'),
              eq(schema.outbox.aggregateId, sandboxId),
            ),
          )
          .orderBy(asc(schema.outbox.seq));

        return rows.map((row) => row.payload as { op: string });
      }

      /** The sandbox.ops job id of a sandbox's latest `op` event: target, op and event id. */
      async function opJobId(sandboxId: string, op: string): Promise<string> {
        const rows = await db
          .select({ id: schema.outbox.id, payload: schema.outbox.payload })
          .from(schema.outbox)
          .where(
            and(
              eq(schema.outbox.type, 'sandbox.op.requested'),
              eq(schema.outbox.aggregateId, sandboxId),
            ),
          )
          .orderBy(asc(schema.outbox.seq));
        const last = rows.filter((row) => (row.payload as { op: string }).op === op).at(-1);

        return `${sandboxId}.${op}.${last?.id ?? 'none'}`;
      }

      const creates = () =>
        fake.requests.filter((r) => r.method === 'POST' && r.path === '/api/sandbox');

      /** The dial; the pool's source is the version `publishFakeVersion` seeded at boot (015, R8). */
      async function setDepth(targetDepth: number): Promise<void> {
        await db
          .insert(schema.sandboxPoolSettings)
          .values({ targetDepth, template: TEMPLATE, updatedAt: new Date() })
          .onConflictDoUpdate({
            set: { targetDepth },
            target: schema.sandboxPoolSettings.template,
          });
      }

      /**
       * The maintenance job's half, by hand: `refill()` posts the create and appends the op; the
       * fake's runner "catches up"; the `sandbox.ops` consumer on the `events` profile settles the
       * row `ready` and pushes it onto the front. Returns the ready rows.
       */
      async function warmPool(depth: number) {
        await setDepth(depth);
        await refill.refill();
        for (const row of await poolRows()) fake.settle(row.daytonaId);
        await until(
          `${String(depth)} ready pool rows on the front`,
          async () => (await queue.llen(poolFrontKey(TEMPLATE))) >= depth,
        );

        return (await poolRows()).filter((r) => r.state === 'ready');
      }

      beforeAll(async () => {
        suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
        fake = await startFakeDaytona({ port: FAKE.port });
        // 016: the executor's baseline and turn-end commit run against an in-memory git that
        // outlives each case, as agent-core.e2e-spec.ts wires it; every other command still "ran".
        fakeGit(fake, (request) => ({ exitCode: 0, result: `ran: ${request.command}\n` }));

        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(BREACHED_PASSWORD_PORT)
          .useClass(ScriptedBreachPort)
          .overrideProvider(LLM_PROVIDER)
          .useValue(provider)
          .overrideProvider(AGENT_TIMINGS)
          .useValue(AGENT)
          .overrideProvider(SANDBOX_TIMINGS)
          .useValue(SANDBOX)
          .compile();

        app = moduleRef.createNestApplication();
        configureApplication(app);
        await app.init();

        db = app.get<ForgeDatabase>(APP_DATABASE);
        queue = app.get<Redis>(QUEUE_REDIS);
        transactions = app.get(TenantTransactionRunner);
        refill = app.get(PoolRefill, { strict: false });
        sweep = app.get(SandboxSweep, { strict: false });
        reconciler = app.get(SandboxReconciler, { strict: false });
        sandboxPort = app.get(SandboxService, { strict: false });
        await queue.del(poolFrontKey(TEMPLATE));
        // Spec 015 (R8): the pool's source is the template's current version, not a dial.
        await publishFakeVersion(db, TEMPLATE, SNAPSHOT);
        world = await createTwoTenantWorld(app);
        // Platform credits are retired: the organisation pays for its runs with its own key.
        await seedProviderKey(app, world.alpha);
      }, LOCKED_BOOT_TIMEOUT_MS);

      beforeEach(() => {
        fake.requests.splice(0);
      });

      afterAll(async () => {
        if (world) await destroyTwoTenantWorld(app, world);
        await db?.delete(schema.sandboxPool).where(eq(schema.sandboxPool.snapshot, SNAPSHOT));
        await db
          ?.delete(schema.sandboxPoolSettings)
          .where(eq(schema.sandboxPoolSettings.template, TEMPLATE));
        if (db) await dropFakeVersions(db, TEMPLATE);
        await queue?.del(poolFrontKey(TEMPLATE));
        // SC-011's far-future `maintenance` jobs: no worker here, and no other suite's business.
        const maintenance = app?.get(QueueRegistry).queues.get(MAINTENANCE_QUEUE);
        for (const job of (await maintenance?.getJobs()) ?? []) {
          if (Number(job.id?.split('.').at(-1)) >= FAR_FUTURE) await job.remove();
        }
        await app?.close();
        await fake?.close();
        await suiteLock?.release();
      });

      /** SC-001, quickstart row 1. */
      it(
        'first run on a warm pool reaches its first tool call, no operator',
        async () => {
          const { projectId } = world.alpha;
          const [pooled] = await warmPool(1);
          expect(await queue.lrange(poolFrontKey(TEMPLATE), 0, -1)).toEqual([pooled!.id]);
          fake.requests.splice(0);
          provider.script(
            { toolCalls: [{ id: 'call-1', input: { path: '.' }, name: 'fs_list' }] },
            { text: 'Listed.' },
          );

          const created = await createRun(projectId, 'List the workspace');
          await waitFor(projectId, created.id, 'succeeded');

          const all = await events(created.id);
          expect(all.filter((e) => e.type === 'sandbox.preparing')).toEqual([]);
          expect(all.filter((e) => e.type === 'tool.start').map((e) => e.data.tool)).toEqual([
            'fs_list',
          ]);
          expect(all.filter((e) => e.type === 'tool.end').map((e) => e.data.ok)).toEqual([true]);

          const row = await sandboxRow(projectId);
          expect(row).toMatchObject({
            daytonaId: pooled!.daytonaId,
            node: pooled!.node,
            state: 'active',
            transition: null,
            workspaceRoot: pooled!.workspaceRoot,
          });
          expect(await poolRows()).toEqual([]);
          expect(await queue.lrange(poolFrontKey(TEMPLATE), 0, -1)).toEqual([]);
          expect(await auditsFor(row!.id)).toEqual([
            {
              action: 'sandbox.claimed',
              metadata: {
                daytonaId: pooled!.daytonaId,
                poolId: pooled!.id,
                snapshot: SNAPSHOT,
                template: TEMPLATE,
              },
            },
          ]);
          // No operator step and no cold create: the label rode the op, off the transaction.
          expect(creates()).toEqual([]);
          expect((await opsFor(row!.id)).map((op) => op.op)).toEqual(['label']);
          await until('the label op to reach the fake', async () =>
            Promise.resolve(
              fake.sandboxes.get(pooled!.daytonaId)!.labels['forge.project'] === projectId,
            ),
          );
          expect(fake.sandboxes.get(pooled!.daytonaId)!.labels).toEqual({
            'forge.kind': 'project',
            'forge.owner': 'forge-test',
            'forge.project': projectId,
            'forge.template': TEMPLATE,
          });
        },
        RUN_TIMEOUT_MS * 2,
      );

      /** SC-002, quickstart row 2. */
      it(
        'first run on an empty pool still completes',
        async () => {
          await setDepth(0);
          expect((await poolRows()).filter((r) => r.state === 'ready')).toEqual([]);
          const projectId = await anotherProject('Cold');
          provider.script({ text: 'Done cold.' });

          const created = await createRun(projectId, 'Start cold');

          // The run waits in `starting` on the create op, which polls the fake until it settles.
          let row: Awaited<ReturnType<typeof sandboxRow>>;
          await until('the creating row', async () => {
            row = await sandboxRow(projectId);
            return row?.transition === 'creating';
          });
          expect(creates()).toHaveLength(1);
          // Research R6 says the run waits in `starting`; as landed, `AgentRunConsumer` moves a
          // claimed run to `running` before `execute`, so the wait is observed there. Either way
          // the run is live and not `failed('no-sandbox')` — which is what SC-002 measures.
          expect(['starting', 'running']).toContain((await read(projectId, created.id)).status);
          await until('the preparing milestone', async () =>
            (await events(created.id)).some((e) => e.type === 'sandbox.preparing'),
          );
          fake.settle(row!.daytonaId);

          await waitFor(projectId, created.id, 'succeeded');

          const all = await events(created.id);
          expect(all.filter((e) => e.type === 'sandbox.preparing').map((e) => e.data)).toEqual([
            { transition: 'creating' },
          ]);
          expect(all.filter((e) => e.type === 'state').map((e) => e.data.to)).toEqual([
            'queued',
            'starting',
            'running',
            'succeeded',
          ]);
          expect(await sandboxRow(projectId)).toMatchObject({
            daytonaId: row!.daytonaId,
            node: fake.runnerId,
            state: 'active',
            transition: null,
            workspaceRoot: fake.workDir,
          });
          expect(await auditsFor(row!.id)).toEqual([
            {
              action: 'sandbox.claimed',
              metadata: { daytonaId: row!.daytonaId, snapshot: SNAPSHOT, template: TEMPLATE },
            },
          ]);
        },
        RUN_TIMEOUT_MS * 2,
      );

      /** SC-003, quickstart row 3. */
      it(
        'concurrent first runs consume exactly one pooled sandbox',
        async () => {
          const projectId = await anotherProject('Raced');
          const [pooled] = await warmPool(1);
          fake.requests.splice(0);
          provider.script({ text: 'First done.' }, { text: 'Second done.' });

          const created = await Promise.all([
            createRun(projectId, 'First'),
            createRun(projectId, 'Second'),
          ]);
          await Promise.all(created.map((run) => waitFor(projectId, run.id, 'succeeded')));

          const rows = await sandboxRows(projectId);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            daytonaId: pooled!.daytonaId,
            state: 'active',
            transition: null,
          });
          expect(await poolRows()).toEqual([]);
          expect(await queue.lrange(poolFrontKey(TEMPLATE), 0, -1)).toEqual([]);
          expect(await auditsFor(rows[0]!.id)).toHaveLength(1);
        },
        RUN_TIMEOUT_MS * 2,
      );

      /** US1 scenario 5, quickstart row 4: spec 010's `register` path, a sandbox with no labels. */
      it(
        'a hand-registered sandbox is used as-is: no claim, no create, no op',
        async () => {
          const projectId = await anotherProject('Registered');
          const { orgId } = world.alpha;
          await transactions.runInTenantScope({ orgId, userId: null }, (tx) =>
            app.get(SandboxService).register(tx, { daytonaId: fake.sandboxId, orgId, projectId }),
          );
          const before = await sandboxRow(projectId);
          expect(before).toMatchObject({ daytonaId: fake.sandboxId, state: 'active' });
          expect(before!.stateEnteredAt).toBeInstanceOf(Date);
          expect(before!.lastSeenAt).toBeInstanceOf(Date);
          fake.requests.splice(0);
          provider.script({ text: 'Done on the registered one.' });

          const created = await createRun(projectId, 'Use mine');
          await waitFor(projectId, created.id, 'succeeded');

          expect((await events(created.id)).filter((e) => e.type === 'sandbox.preparing')).toEqual(
            [],
          );
          expect(creates()).toEqual([]);
          expect(await auditsFor(before!.id)).toEqual([]);
          expect(await opsFor(before!.id)).toEqual([]);
          expect(await sandboxRow(projectId)).toMatchObject({
            daytonaId: fake.sandboxId,
            id: before!.id,
            state: 'active',
            stateEnteredAt: before!.stateEnteredAt,
            transition: null,
          });
          expect(fake.sandboxes.get(fake.sandboxId)!.labels).toEqual({});
        },
        RUN_TIMEOUT_MS * 2,
      );

      /**
       * US2 (quickstart rows 5–9). The clocks are §06's real minutes and days; rather than a fake
       * clock under the whole application (sessions and leases keep time by it too), the row's
       * timestamps are moved back the way the clock would have moved forward, and the sweep is
       * called as the maintenance job calls it.
       */
      const MINUTE = 60_000;
      const ago = (ms: number) => new Date(Date.now() - ms);

      /** Move a project's row back in time (or into a state) the way elapsed time would have. */
      async function backdate(
        projectId: string,
        values: Partial<typeof schema.sandboxes.$inferInsert>,
      ) {
        await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx
            .update(schema.sandboxes)
            .set(values)
            .where(
              and(
                eq(schema.sandboxes.orgId, world.alpha.orgId),
                eq(schema.sandboxes.projectId, projectId),
              ),
            ),
        );
      }

      /**
       * A project whose sandbox is `active` at a started fake — as a completed first run leaves
       * it. `daytonaId` given: a row whose sandbox the fake never had (a ghost).
       */
      async function activeProject(
        name: string,
        daytonaId = fake.seedSandbox({ state: 'started' }),
      ) {
        const projectId = await anotherProject(name);
        await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx.insert(schema.sandboxes).values({
            daytonaId,
            lastSeenAt: new Date(),
            node: fake.runnerId,
            orgId: world.alpha.orgId,
            projectId,
            stateEnteredAt: new Date(),
            workspaceRoot: fake.workDir,
          }),
        );

        return { daytonaId, projectId };
      }

      describe('US2', () => {
        /** Through the sweep and the real `hibernate` op: the fake ends `stopped`, the row `hibernated`. */
        async function hibernate(projectId: string, daytonaId: string) {
          await backdate(projectId, { state: 'idle', stateEnteredAt: ago(61 * MINUTE) });
          expect(await sweep.sweep()).toMatchObject({ hibernating: 1 });
          await until('the fake to be asked to stop', async () =>
            Promise.resolve(fake.sandboxes.get(daytonaId)!.state === 'stopping'),
          );
          fake.settle(daytonaId);
          await until(
            'the row to be hibernated',
            async () => (await sandboxRow(projectId))?.state === 'hibernated',
          );
        }

        const portCall = (projectId: string) =>
          transactions.runInTenantScope({ orgId: world.alpha.orgId, userId: null }, () =>
            sandboxPort.list({ orgId: world.alpha.orgId, projectId }, '.'),
          );

        /** SC-004, quickstart row 5. */
        it(
          'idle within 20 min, hibernated within 80 min, no container after',
          async () => {
            const projectId = await anotherProject('Sleepy');
            await warmPool(1);
            provider.script({ text: 'Done, going quiet.' });
            const created = await createRun(projectId, 'Then rest');
            await waitFor(projectId, created.id, 'succeeded');
            const row = (await sandboxRow(projectId))!;
            expect(row).toMatchObject({ state: 'active', transition: null });
            const touched = row.lastSeenAt!;

            // +21 min without a sign of use.
            await backdate(projectId, { lastSeenAt: ago(21 * MINUTE) });
            const idledAt = new Date();
            expect(await sweep.sweep()).toMatchObject({ idled: 1 });
            const idle = (await sandboxRow(projectId))!;
            expect(idle).toMatchObject({ state: 'idle', transition: null });
            expect(idle.stateEnteredAt.getTime()).toBeGreaterThanOrEqual(idledAt.getTime());
            expect(idle.stateEnteredAt.getTime()).toBeGreaterThan(touched.getTime());
            expect(fake.sandboxes.get(row.daytonaId)!.state).toBe('started');

            // +61 min idle.
            await backdate(projectId, { stateEnteredAt: ago(61 * MINUTE) });
            fake.requests.splice(0);
            expect(await sweep.sweep()).toMatchObject({ hibernating: 1 });
            expect(await sandboxRow(projectId)).toMatchObject({
              state: 'idle',
              transition: 'hibernating',
            });
            expect((await opsFor(row.id)).map((op) => op.op)).toEqual(['label', 'hibernate']);
            await until('the fake to be asked to stop', async () =>
              Promise.resolve(fake.sandboxes.get(row.daytonaId)!.state === 'stopping'),
            );
            fake.settle(row.daytonaId);
            await until(
              'the row to be hibernated',
              async () => (await sandboxRow(projectId))?.state === 'hibernated',
            );

            const hibernated = (await sandboxRow(projectId))!;
            expect(hibernated).toMatchObject({ transition: null, transitionSince: null });
            expect(hibernated.hibernatedAt).toBeInstanceOf(Date);
            expect(fake.sandboxes.get(row.daytonaId)!.state).toBe('stopped');
            expect(fake.requests.filter((r) => r.path.endsWith('/stop'))).toHaveLength(1);
          },
          RUN_TIMEOUT_MS * 2,
        );

        /** US2 scenario 2, quickstart row 6. */
        it('a port call on an idle sandbox makes it active again before it is served', async () => {
          const { projectId } = await activeProject('Nudged');
          const entered = ago(25 * MINUTE);
          await backdate(projectId, {
            lastSeenAt: entered,
            state: 'idle',
            stateEnteredAt: entered,
          });
          const before = new Date();

          await portCall(projectId);

          const row = (await sandboxRow(projectId))!;
          expect(row).toMatchObject({ state: 'active', transition: null });
          expect(row.lastSeenAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
          expect(row.stateEnteredAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
          // The inactivity clock restarted: a sweep now idles nothing.
          expect(await sweep.sweep()).toMatchObject({ idled: 0 });
          expect(await sandboxRow(projectId)).toMatchObject({ state: 'active' });
        });

        /** SC-005, quickstart row 7. */
        it(
          'resume within 10 s, files intact',
          async () => {
            const { daytonaId, projectId } = await activeProject('Napper');
            const ref = { orgId: world.alpha.orgId, projectId };
            await transactions.runInTenantScope({ orgId: world.alpha.orgId, userId: null }, () =>
              sandboxPort.edit(
                ref,
                { content: 'written before hibernation\n', path: 'note.txt' },
                { leaseEpoch: 1, operationId: 'by-hand/step-0' },
              ),
            );
            await hibernate(projectId, daytonaId);
            const row = (await sandboxRow(projectId))!;
            expect(fake.sandboxes.get(daytonaId)!.state).toBe('stopped');
            // A port call outside a run does not resume it (FR-008).
            await expect(portCall(projectId)).rejects.toMatchObject({ kind: 'sandbox-not-ready' });
            fake.requests.splice(0);
            provider.script(
              { toolCalls: [{ id: 'call-1', input: { path: 'note.txt' }, name: 'fs_read' }] },
              { text: 'Read it back.' },
            );

            const started = Date.now();
            const created = await createRun(projectId, 'Read the note');
            await waitFor(projectId, created.id, 'succeeded');

            const all = await events(created.id);
            expect(all.filter((e) => e.type === 'sandbox.preparing').map((e) => e.data)).toEqual([
              { transition: 'resuming' },
            ]);
            expect(all.filter((e) => e.type === 'tool.end').map((e) => e.data.ok)).toEqual([true]);
            const firstTool = all.find((e) => e.type === 'tool.start');
            expect(firstTool).toBeDefined();
            expect(Date.now() - started).toBeLessThan(10_000);
            expect(
              fake.requests.some(
                (r) => r.path.endsWith('/files/download') && r.url.includes('note.txt'),
              ),
            ).toBe(true);
            expect(fake.requests.filter((r) => r.path.endsWith('/start'))).toHaveLength(1);
            expect((await opsFor(row.id)).map((op) => op.op)).toEqual(['hibernate', 'resume']);
            const resumed = (await sandboxRow(projectId))!;
            expect(resumed).toMatchObject({
              daytonaId,
              hibernatedAt: null,
              state: 'active',
              transition: null,
              workspaceRoot: fake.workDir,
            });
            expect(resumed.stateEnteredAt.getTime()).toBeGreaterThan(row.stateEnteredAt.getTime());
            expect(fake.sandboxes.get(daytonaId)!.state).toBe('started');
          },
          RUN_TIMEOUT_MS * 2,
        );

        /** SC-006, quickstart row 8. */
        it('archive never entered, snapshot never deleted', async () => {
          const { daytonaId, projectId } = await activeProject('Ancient');
          const hibernatedAt = ago(15 * 24 * 60 * MINUTE);
          fake.sandboxes.get(daytonaId)!.state = 'stopped';
          await backdate(projectId, {
            hibernatedAt,
            state: 'hibernated',
            stateEnteredAt: hibernatedAt,
          });
          const before = (await sandboxRow(projectId))!;
          const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
          fake.requests.splice(0);

          try {
            expect(await sweep.sweep()).toMatchObject({ archiveRefused: 1 });

            expect(await sandboxRow(projectId)).toEqual(before);
            expect(
              warn.mock.calls.filter(([line]) => String(line).includes('archive refused')),
            ).toHaveLength(1);
            expect(await opsFor(before.id)).toEqual([]);
            expect(
              fake.requests.filter((r) => r.method === 'DELETE' || r.path.includes('archive')),
            ).toEqual([]);
            expect(fake.sandboxes.get(daytonaId)!.state).toBe('stopped');
          } finally {
            warn.mockRestore();
          }
        });

        /** US2 scenario 6, quickstart row 9. */
        it(
          'a run arriving mid-hibernate waits for it to settle, then resumes with one op each',
          async () => {
            const { daytonaId, projectId } = await activeProject('Interrupted');
            await backdate(projectId, { state: 'idle', stateEnteredAt: ago(61 * MINUTE) });
            expect(await sweep.sweep()).toMatchObject({ hibernating: 1 });
            const row = (await sandboxRow(projectId))!;
            provider.script({ text: 'After the nap.' });

            // The op is in flight — the fake is `stopping` until settled — when the run arrives.
            const created = await createRun(projectId, 'Wake up');
            await until('the preparing milestone', async () =>
              (await events(created.id)).some((e) => e.type === 'sandbox.preparing'),
            );
            expect(await sandboxRow(projectId)).toMatchObject({ transition: 'hibernating' });
            expect((await opsFor(row.id)).map((op) => op.op)).toEqual(['hibernate']);
            await until('the fake to be asked to stop', async () =>
              Promise.resolve(fake.sandboxes.get(daytonaId)!.state === 'stopping'),
            );
            fake.settle(daytonaId);

            await waitFor(projectId, created.id, 'succeeded');

            expect(
              (await events(created.id))
                .filter((e) => e.type === 'sandbox.preparing')
                .map((e) => e.data),
            ).toEqual([{ transition: 'hibernating' }]);
            expect((await opsFor(row.id)).map((op) => op.op)).toEqual(['hibernate', 'resume']);
            expect(await sandboxRow(projectId)).toMatchObject({
              hibernatedAt: null,
              state: 'active',
              transition: null,
            });
            expect(fake.sandboxes.get(daytonaId)!.state).toBe('started');
          },
          RUN_TIMEOUT_MS * 2,
        );
      });

      /**
       * US4 (quickstart rows US4 · SC-008, scenario 3, SC-009): the reconciler called as the
       * maintenance job calls it, over the whole fake — every sandbox the earlier rows left there
       * is part of the inventory it walks.
       */
      describe('US4', () => {
        const OWNED = {
          'forge.kind': 'pool',
          'forge.owner': 'forge-test',
          'forge.template': TEMPLATE,
        } as const;

        async function lostAudits(target: string) {
          return transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
            tx
              .select({ metadata: schema.auditLog.metadata })
              .from(schema.auditLog)
              .where(
                and(eq(schema.auditLog.target, target), eq(schema.auditLog.action, 'sandbox.lost')),
              ),
          );
        }

        /** SC-008, quickstart row US4 · SC-008. */
        it('reconciler releases orphans, marks lost, spares unmarked', async () => {
          // A worker lost between create and insert, 16 min ago; another, 1 min ago.
          const orphan = fake.seedSandbox({
            createdAt: ago(16 * MINUTE).toISOString(),
            labels: OWNED,
          });
          const young = fake.seedSandbox({
            createdAt: ago(1 * MINUTE).toISOString(),
            labels: OWNED,
          });
          // A row whose sandbox the provider no longer has.
          const ghost = await activeProject('Ghost', `ghost-${randomUUID().slice(0, 8)}`);
          const ghostRow = (await sandboxRow(ghost.projectId))!;
          // 010's hand-made sandbox: no labels at all.
          const stranger = fake.seedSandbox({});
          const unmarked = [...fake.sandboxes.values()].filter(
            (s) => s.labels['forge.owner'] !== 'forge-test',
          ).length;
          const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
          fake.requests.splice(0);

          try {
            const report = await reconciler.reconcile();

            expect(report).toMatchObject({ foreign: unmarked, lost: 1, orphaned: 1 });
            expect(fake.sandboxes.has(orphan)).toBe(false);
            expect(fake.sandboxes.get(young)).toMatchObject({ labels: OWNED, state: 'started' });
            expect(fake.sandboxes.get(stranger)).toMatchObject({ labels: {}, state: 'started' });
            expect(fake.sandboxes.get(fake.sandboxId)).toMatchObject({ labels: {} });
            expect(fake.requests.filter((r) => r.method === 'DELETE').map((r) => r.path)).toEqual([
              `/api/sandbox/${orphan}`,
            ]);
            expect(
              warn.mock.calls.filter(([line]) =>
                String(line).startsWith(`orphan released: daytonaId=${orphan}`),
              ),
            ).toHaveLength(1);
            const lost = (await sandboxRow(ghost.projectId))!;
            // Marked, not repaired: every column but `lost_at` (and the touch) as it was.
            expect(lost).toMatchObject({
              ...ghostRow,
              lostAt: expect.any(Date) as Date,
              updatedAt: expect.any(Date) as Date,
            });
            expect(await lostAudits(ghostRow.id)).toEqual([
              { metadata: { daytonaId: ghost.daytonaId } },
            ]);
          } finally {
            warn.mockRestore();
          }
        });

        /** US4 scenario 3, quickstart row US4 · scenario 3 (FR-026). */
        it(
          'a run on a project whose sandbox was lost claims a fresh one',
          async () => {
            const { projectId } = await activeProject(
              'Bereft',
              `ghost-${randomUUID().slice(0, 8)}`,
            );
            expect(await reconciler.reconcile()).toMatchObject({ lost: 1 });
            const lost = (await sandboxRow(projectId))!;
            expect(lost.lostAt).toBeInstanceOf(Date);
            const [pooled] = await warmPool(1);
            provider.script({ text: 'Fresh start.' });

            const created = await createRun(projectId, 'Carry on');
            await waitFor(projectId, created.id, 'succeeded');

            const rows = await sandboxRows(projectId);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
              daytonaId: pooled!.daytonaId,
              lostAt: null,
              state: 'active',
              transition: null,
            });
            expect(rows[0]!.id).not.toBe(lost.id);
            expect(await auditsFor(rows[0]!.id)).toHaveLength(1);
            expect(await poolRows()).toEqual([]);
          },
          RUN_TIMEOUT_MS * 2,
        );

        /** SC-009, quickstart row US4 · SC-009 (FR-027). */
        it(
          'queue store loss re-derives every transition',
          async () => {
            // A `hibernating` row whose op the store lost, older than the stale-transition clock.
            const { daytonaId, projectId } = await activeProject('Stranded');
            await backdate(projectId, {
              state: 'idle',
              stateEnteredAt: ago(61 * MINUTE),
              transition: 'hibernating',
              transitionSince: ago(11 * MINUTE),
            });
            const row = (await sandboxRow(projectId))!;
            const readyRows = await warmPool(2);
            expect(readyRows).toHaveLength(2);

            await queue.flushall();
            expect(await queue.llen(poolFrontKey(TEMPLATE))).toBe(0);
            fake.requests.splice(0);

            expect(await reconciler.reconcile()).toMatchObject({ lost: 0, requeued: 1 });

            // The front, rebuilt from the durable record, oldest `ready_at` first.
            const [oldest, newest] = [...readyRows].sort(
              (a, b) => a.readyAt!.getTime() - b.readyAt!.getTime(),
            );
            expect(await queue.lrange(poolFrontKey(TEMPLATE), 0, -1)).toEqual([
              oldest!.id,
              newest!.id,
            ]);
            // The op, re-appended and drained: the fake is asked to stop, the row settles.
            expect((await opsFor(row.id)).map((op) => op.op)).toEqual(['hibernate']);
            await until('the fake to be asked to stop', async () =>
              Promise.resolve(fake.sandboxes.get(daytonaId)!.state === 'stopping'),
            );
            fake.settle(daytonaId);
            await until(
              'the row to be hibernated',
              async () => (await sandboxRow(projectId))?.state === 'hibernated',
            );
            expect(await sandboxRow(projectId)).toMatchObject({
              state: 'hibernated',
              transition: null,
              transitionSince: null,
            });
            expect(fake.requests.filter((r) => r.path.endsWith('/stop'))).toHaveLength(1);

            // The next claim is warm: the rebuilt front hands out the oldest ready row.
            const claimant = await anotherProject('Warmed');
            provider.script({ text: 'Warm.' });
            const created = await createRun(claimant, 'Take one');
            await waitFor(claimant, created.id, 'succeeded');
            expect(await sandboxRow(claimant)).toMatchObject({
              daytonaId: oldest!.daytonaId,
              state: 'active',
            });
            expect(
              (await events(created.id)).filter((e) => e.type === 'sandbox.preparing'),
            ).toEqual([]);
            expect(await queue.lrange(poolFrontKey(TEMPLATE), 0, -1)).toEqual([newest!.id]);
          },
          RUN_TIMEOUT_MS * 3,
        );
      });

      /**
       * US5 (quickstart rows US5 · SC-010, SC-011, scenario 3, SC-013): the two queues as the
       * registry built them — the ops consumer's idempotence and its epoch fence, the scheduler's
       * durable dedupe across two `cron` contexts, the dead-letter path, and the payload shapes.
       */
      describe('US5', () => {
        const registry = () => app.get(QueueRegistry);
        const opsQueue = () => registry().queues.get(SANDBOX_OPS_QUEUE) as Queue<Envelope>;
        const opsDlq = () => registry().queues.get(`${SANDBOX_OPS_QUEUE}.dlq`) as DeadLetterQueue;
        const maintenanceQueue = () => registry().queues.get(MAINTENANCE_QUEUE) as Queue<Envelope>;

        /** An op appended by hand, as the sweep or the lifecycle would append it. */
        const appendOp = (
          sandboxId: string,
          payload: Omit<EventPayload<'sandbox.op.requested'>, 'orgId' | 'sandboxId'>,
        ) =>
          transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
            app.get(OutboxWriter).append(tx, {
              aggregateId: sandboxId,
              orgId: world.alpha.orgId,
              payload: { ...payload, orgId: world.alpha.orgId, sandboxId },
              type: 'sandbox.op.requested',
            }),
          );

        const published = async (sandboxId: string) => {
          const rows = await db
            .select({ publishedAt: schema.outbox.publishedAt })
            .from(schema.outbox)
            .where(eq(schema.outbox.aggregateId, sandboxId));

          return rows.every((row) => row.publishedAt !== null);
        };

        /** A project whose sandbox is `hibernated` at a stopped fake, as the sweep leaves it. */
        async function hibernatedProject(name: string) {
          const { daytonaId, projectId } = await activeProject(name);
          fake.sandboxes.get(daytonaId)!.state = 'stopped';
          const hibernatedAt = ago(5 * MINUTE);
          await backdate(projectId, {
            hibernatedAt,
            state: 'hibernated',
            stateEnteredAt: hibernatedAt,
          });

          return { daytonaId, projectId, row: (await sandboxRow(projectId))! };
        }

        /** SC-010, quickstart row US5 · SC-010 (FR-010, FR-011). */
        it(
          'the same hibernate op twice stops once; a stale-epoch resume settles nothing',
          async () => {
            const { daytonaId, projectId } = await activeProject('Twice');
            await backdate(projectId, { state: 'idle', stateEnteredAt: ago(61 * MINUTE) });
            expect(await sweep.sweep()).toMatchObject({ hibernating: 1 });
            const row = (await sandboxRow(projectId))!;
            // The same op again, before the first has run: one job id, one `stop`.
            await appendOp(row.id, { op: 'hibernate' });
            expect((await opsFor(row.id)).map((op) => op.op)).toEqual(['hibernate', 'hibernate']);
            await until('the fake to be asked to stop', async () =>
              Promise.resolve(fake.sandboxes.get(daytonaId)!.state === 'stopping'),
            );
            fake.settle(daytonaId);
            await until(
              'the row to be hibernated',
              async () => (await sandboxRow(projectId))?.state === 'hibernated',
            );
            await until('both ops to be published', () => published(row.id));
            // And once more after the first settled: `handle` sees `hibernated` and does nothing.
            await appendOp(row.id, { op: 'hibernate' });
            await until('the third op to be published', () => published(row.id));
            const hibernated = (await sandboxRow(projectId))!;
            expect(hibernated).toMatchObject({ state: 'hibernated', transition: null });
            expect(fake.requests.filter((r) => r.path.endsWith('/stop'))).toHaveLength(1);
            expect(fake.sandboxes.get(daytonaId)!.state).toBe('stopped');

            // A resume for epoch 2 is on record (already published); epoch 1 arrives after it.
            await backdate(projectId, { transition: 'resuming', transitionSince: new Date() });
            const resuming = (await sandboxRow(projectId))!;
            await db.insert(schema.outbox).values({
              aggregate: 'sandbox',
              aggregateId: row.id,
              occurredAt: new Date(),
              originOrgId: world.alpha.orgId,
              payload: {
                leaseEpoch: 2,
                op: 'resume',
                orgId: world.alpha.orgId,
                sandboxId: row.id,
              },
              publishedAt: new Date(),
              type: 'sandbox.op.requested',
            });
            fake.requests.splice(0);
            await appendOp(row.id, { leaseEpoch: 1, op: 'resume' });
            await until('the stale resume to be published', () => published(row.id));
            await until(
              'the stale resume job to complete',
              async () =>
                (await (await opsQueue().getJob(await opJobId(row.id, 'resume')))?.getState()) ===
                'completed',
            );

            expect(fake.requests.filter((r) => r.path.endsWith('/start'))).toEqual([]);
            expect(await sandboxRow(projectId)).toEqual(resuming);
            expect(fake.sandboxes.get(daytonaId)!.state).toBe('stopped');
          },
          RUN_TIMEOUT_MS * 2,
        );

        /** SC-011, quickstart row US5 · SC-011 (FR-030, research R7). */
        it(
          'two cron contexts append one maintenance.due per job per period, across a handover',
          async () => {
            // A far-off instant aligned to every period, so no other suite's rows share a key.
            const t0 = FAR_FUTURE + Math.floor(Math.random() * 100_000) * 86_400_000;
            const clock = new FakeClock(t0);
            const bootCron = async () => {
              const context = await Test.createTestingModule({ imports: [AppModule] })
                .overrideProvider(RUN_PROFILES_TOKEN)
                .useValue(new Set(['cron']))
                .overrideProvider(LivenessServer)
                .useValue({})
                .overrideProvider(CLOCK)
                .useValue(clock)
                // The rounds below are the ticks; neither timer adds ticks of its own.
                .overrideProvider(AGENT_TIMINGS)
                .useValue({ ...AGENT, reaperMs: 3_600_000 })
                .overrideProvider(SANDBOX_TIMINGS)
                .useValue({ ...SANDBOX, schedulerTickMs: 3_600_000 })
                // No `maintenance` worker here: the jobs are inspected, not run.
                .overrideProvider(MaintenanceConsumer)
                .useValue({})
                .compile();
              await context.init();

              return context;
            };
            const crons = [await bootCron(), await bootCron()];
            const open = new Set(crons);
            const round = () =>
              Promise.all([...open].map((context) => context.get(MaintenanceScheduler).tick()));
            const sum = (counts: number[]) => counts.reduce((a, b) => a + b, 0);
            const periods = Object.fromEntries(
              MAINTENANCE_JOBS.map(({ job }) => [job, [t0]]),
            ) as Record<MaintenanceJob, number[]>;
            const advance = (ms: number) => {
              clock.advance(ms);
              const now = clock.now().getTime();
              for (const { job, periodMs } of MAINTENANCE_JOBS) {
                const start = Math.floor(now / periodMs) * periodMs;
                if (!periods[job].includes(start)) periods[job].push(start);
              }
            };

            try {
              const [first, sixty, threeHundred, threeSixty] = HANDOVER_OFFSETS_MS.map(dueAt);
              // Round 1: the first period (every job), appended by exactly one of the two.
              expect(first).toBe(MAINTENANCE_JOBS.length);
              expect(sum(await round())).toBe(first);
              // Round 2: same period, nothing more.
              expect(sum(await round())).toBe(0);
              // Round 3: a new period, but a third connection holds the lock for 30 ms.
              advance(60_000);
              let release!: () => void;
              const held = new Promise<void>((resolve) => (release = resolve));
              const holder = db.transaction(async (tx) => {
                await tx.execute(sql`select pg_advisory_xact_lock(${MAINTENANCE_LOCK})`);
                release();
                await new Promise((resolve) => setTimeout(resolve, 30));
              });
              await held;
              expect(sum(await round())).toBe(0);
              await holder;
              // Round 4: released; the period's 60 s jobs are appended once.
              const fourth = await round();
              expect(sum(fourth)).toBe(sixty);
              // The one that appended is the leader: close it mid-period.
              const leader = [...open][fourth.findIndex((n) => n > 0)]!;
              await leader.close();
              open.delete(leader);
              // Round 5: the survivor appends nothing more for this period…
              expect(sum(await round())).toBe(0);
              // Round 6: …and everything for the next (a 300 s boundary: the 60 s and 300 s jobs).
              advance(240_000);
              expect(sum(await round())).toBe(threeHundred);
              // Rounds 7 and 8: idle, then the next 60 s period.
              expect(sum(await round())).toBe(0);
              advance(60_000);
              expect(sum(await round())).toBe(threeSixty);

              const expected = Object.entries(periods).flatMap(([job, starts]) =>
                starts.map((start) => ({ job, periodStart: new Date(start).toISOString() })),
              );
              expect(expected).toHaveLength(HANDOVER_DUE);
              const aggregateIds = expected.map((e) => `${e.job}:${e.periodStart}`);
              const rows = await db
                .select({ aggregateId: schema.outbox.aggregateId, payload: schema.outbox.payload })
                .from(schema.outbox)
                .where(
                  and(
                    eq(schema.outbox.type, 'maintenance.due'),
                    inArray(schema.outbox.aggregateId, aggregateIds),
                  ),
                );
              // One row per job per period — the durable dedupe — with the id-only payload.
              expect(rows.map((row) => row.aggregateId).sort()).toEqual([...aggregateIds].sort());
              expect(rows.map((row) => row.payload)).toEqual(
                expect.arrayContaining(expected.map((e) => ({ ...e }))),
              );

              // The relay publishes each once: one `maintenance` job id per job per period.
              const jobIds = expected.map((e) => `${e.job}.${String(Date.parse(e.periodStart))}`);
              await until('every maintenance.due row to be published', async () => {
                const pending = await db
                  .select({ id: schema.outbox.id })
                  .from(schema.outbox)
                  .where(
                    and(
                      inArray(schema.outbox.aggregateId, aggregateIds),
                      isNull(schema.outbox.publishedAt),
                    ),
                  );
                return pending.length === 0;
              });
              const jobs = await Promise.all(jobIds.map((id) => maintenanceQueue().getJob(id)));
              expect(jobs.map((job) => job?.id)).toEqual(jobIds);
              expect(jobs.map((job) => job!.data.payload)).toEqual(expected);
              const all = await maintenanceQueue().getJobs();
              expect(all.filter((job) => jobIds.includes(job.id!))).toHaveLength(HANDOVER_DUE);
            } finally {
              await Promise.all([...open].map((context) => context.close()));
            }
          },
          LOCKED_BOOT_TIMEOUT_MS,
        );

        /** US5 scenario 3, quickstart row US5 · scenario 3 (FR-019, FR-033). */
        it(
          'a resume refused five times dead-letters with its chain and fails the waiting run',
          async () => {
            const { daytonaId, projectId, row } = await hibernatedProject('Refused');
            const worker = registry().workers.find((w) => w.name === SANDBOX_OPS_QUEUE)!;
            const settings = worker.opts.settings!;
            const strategy = settings.backoffStrategy;
            // Five refusals for five attempts; a 500 ms backoff so the chain lands in test time
            // while the run's wait, shorter, runs out during it.
            for (let n = 0; n < 5; n += 1) fake.refuseNext('start', 400);
            settings.backoffStrategy = () => 500;
            Object.assign(SANDBOX, { runWaitMs: 400 });
            fake.requests.splice(0);

            try {
              const created = await createRun(projectId, 'Wake up, please');
              await waitFor(projectId, created.id, 'failed');

              const all = await events(created.id);
              expect(all.filter((e) => e.type === 'sandbox.preparing').map((e) => e.data)).toEqual([
                { transition: 'resuming' },
              ]);
              expect(all.filter((e) => e.type === 'state').at(-1)!.data).toMatchObject({
                reason: 'sandbox unavailable: resuming',
                to: 'failed',
              });

              let letter: DeadLetter | undefined;
              await until(
                'the resume job to be dead-lettered',
                async () => {
                  letter = (await opsDlq().getJob(await opJobId(row.id, 'resume')))?.data;
                  return letter !== undefined;
                },
                RUN_TIMEOUT_MS * 2,
              );
              expect(letter).toMatchObject({
                jobId: await opJobId(row.id, 'resume'),
                payload: {
                  payload: { op: 'resume', orgId: world.alpha.orgId, sandboxId: row.id },
                  type: 'sandbox.op.requested',
                },
                poison: false,
                sourceQueue: SANDBOX_OPS_QUEUE,
              });
              expect(letter!.attempts.map((a) => [a.attempt, a.classification, a.reason])).toEqual(
                [1, 2, 3, 4, 5].map((n) => [n, 'retryable', 'upstream-5xx']),
              );
              expect(letter!.errors).toHaveLength(5);
              expect(fake.requests.filter((r) => r.path.endsWith('/start'))).toHaveLength(5);
              expect(fake.sandboxes.get(daytonaId)!.state).toBe('stopped');

              await until(
                'the row to carry the failure',
                async () => (await sandboxRow(projectId))?.failureReason !== null,
              );
              const failed = (await sandboxRow(projectId))!;
              expect(failed).toMatchObject({
                daytonaId,
                state: 'hibernated',
                transition: null,
                transitionSince: null,
              });
              expect(failed.failureReason).toMatch(/^daytona:upstream: /);
              expect((await opsFor(row.id)).map((op) => op.op)).toEqual(['resume']);
              expect(await opsQueue().getJob(await opJobId(row.id, 'resume'))).toBeUndefined();
            } finally {
              settings.backoffStrategy = strategy;
              Object.assign(SANDBOX, { runWaitMs: RUN_TIMEOUT_MS });
            }
          },
          RUN_TIMEOUT_MS * 3,
        );

        /** SC-013, quickstart row SC-013 (FR-032): every job either queue received in this suite. */
        it('every queued payload is ids and a target state only', async () => {
          const shapes = {
            'maintenance.due': Object.keys(EVENTS['maintenance.due'].payload.shape),
            'sandbox.op.requested': Object.keys(EVENTS['sandbox.op.requested'].payload.shape),
          };
          const envelopes: Envelope[] = [];
          for (const queue of [opsQueue(), maintenanceQueue()]) {
            for (const job of await queue.getJobs()) envelopes.push(job.data);
          }
          for (const letter of await opsDlq().getJobs()) envelopes.push(letter.data.payload);

          // What the queues still hold after SC-009's flush: enough to make the walk mean something.
          const ops = envelopes.filter(
            (e): e is Envelope<'sandbox.op.requested'> => e.type === 'sandbox.op.requested',
          );
          expect([...new Set(ops.map((e) => e.payload.op))].sort()).toEqual([
            'hibernate',
            'label',
            'resume',
          ]);
          // SC-011's walk left its jobs queued (no worker there): exactly those, and no others.
          expect(envelopes.filter((e) => e.type === 'maintenance.due')).toHaveLength(HANDOVER_DUE);
          for (const envelope of envelopes) {
            const keys = Object.keys(envelope.payload);
            const allowed = shapes[envelope.type as keyof typeof shapes];
            expect(keys.filter((k) => !allowed.includes(k))).toEqual([]);
            expect(keys).not.toContain('content');
            expect(keys).not.toContain('prompt');
            expect(keys).not.toContain('key');
          }
        });
      });
    },
  );
});
