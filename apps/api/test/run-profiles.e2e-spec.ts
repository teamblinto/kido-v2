import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule, type TestingModuleBuilder } from '@nestjs/testing';
import { schema } from '@repo/db';
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { RUN_PROFILES_TOKEN } from '../src/common/run-profiles/run-profiles.constants';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import {
  AGENT_TIMINGS,
  DEFAULT_AGENT_TIMINGS,
  RUN_EXECUTOR,
} from '../src/modules/agent/agent.constants';
import { AgentRunConsumer } from '../src/modules/agent/agent-run.consumer';
import { RunControl } from '../src/modules/agent/run-control';
import type { ExecutionContext, RunExecutor } from '../src/modules/agent/run-executor.port';
import { RunReaper } from '../src/modules/agent/run-reaper';
import { MaintenanceScheduler } from '../src/modules/sandbox/maintenance.scheduler';
import { ProjectService } from '../src/modules/tenancy/services/project.service';
import { RunStore } from '../src/modules/agent/run-store';
import { RunService } from '../src/modules/agent/run.service';
import { ScriptedExecutor } from '../src/modules/agent/scripted-executor';
import { SignupService } from '../src/modules/identity/services/signup.service';
import { InMemoryMailer } from '../src/modules/mail/in-memory.mailer';
import { MAILER } from '../src/modules/mail/mailer.port';
import { LivenessServer } from '../src/modules/health/liveness-server';
import { QueueRegistry } from '../src/modules/outbox/queue-registry';
import { OutboxRelay } from '../src/modules/outbox/relay';
import { awaitMail } from './support/mail';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import { seedProviderKey } from './support/seed-provider-key';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  // The environment is validated once per process (research R2); each context below gets its
  // own profile set through `overrideProvider(RUN_PROFILES_TOKEN)`, never through this line.
  process.env.RUN_PROFILES = 'api';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.THROTTLE_LIMIT = '100000';
  // US5 signs up through `SignupService`; the breach check would be a network call.
  process.env.BREACH_CHECK_ENABLED = 'false';
  // US3: a worker without `agent` boots with no model key at all (SC-011).
  delete process.env.ANTHROPIC_API_KEY;
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

/** Booting waits on the outbox suite lock, which another relay suite may hold for minutes. */
const LOCKED_BOOT_TIMEOUT_MS = 600_000;
/** The relay ticks at 50 ms in tests, so a scripted run is over in well under this. */
const RUN_TIMEOUT_MS = 10_000;
/** `OUTBOX_RELAY_TICK_MS` under test (`support/test-environment.ts`). */
const RELAY_TICK_MS = 50;
/** US4: a sweep holds the reaper lock at least this long, so two concurrent ticks always meet. */
const SWEEP_HOLD_MS = 30;
/** US5: how long the scripted executor holds each run on the saturated `agent` context. */
const RUN_HOLD_MS = 2_000;
/** US5: timer slack on top of the measured idle bound plus one relay tick. */
const SLACK_MS = 500;
const PASSWORD = 'thermos-quibble-tundra-vellum';

/**
 * Spec 013 US1 (SC-001, FR-021): two application contexts over one database and one queue. The
 * `api` context only accepts and enqueues; the `agent,events` context relays and executes. The
 * proof is by construction — the `api` context's executor is a spy that is never called, its
 * registry built no worker and its relay never started, while the worker context's executor ran
 * the run to `succeeded`. With no worker context at all, the run and its outbox row simply wait.
 * US3–US5 boot further single-profile contexts the same way, beside the one `api` context.
 */
describe('Run profiles (e2e)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and the queue Redis role', () => {
    let api: INestApplication;
    let db: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    let world: TwoTenantWorld;
    let suiteLock: { release: () => Promise<void> } | undefined;
    let apiRelayStart: ReturnType<typeof vi.spyOn>;
    const contexts: TestingModule[] = [];
    const signedUp: string[] = [];
    const scripted = new ScriptedExecutor();
    const apiExecute = vi.fn();
    const workerExecute = vi.fn((context: ExecutionContext) => scripted.execute(context));
    const apiExecutor: RunExecutor = { execute: apiExecute };
    const workerExecutor: RunExecutor = { execute: workerExecute };

    /** A run created the product's way, through the `api` context, on alpha's project. */
    /**
     * Each run on a project of its own (031): a project has one holder, so runs meant to occupy
     * the agent context at the same time must not share one.
     */
    async function createRun(prompt = 'run me'): Promise<string> {
      const { orgId, owner, workspaceId } = world.alpha;
      const run = await transactions.runInTenantScope({ orgId, userId: owner.userId }, async () => {
        const project = await api.get(ProjectService).create({
          actorId: owner.userId,
          name: `Profiles ${randomUUID().slice(0, 8)}`,
          orgId,
          ownerId: owner.userId,
          workspaceId,
        });

        return api.get(RunService).create(orgId, project.id, owner.userId, prompt);
      });

      return run.id;
    }

    async function status(runId: string): Promise<string> {
      const [row] = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
        tx
          .select({ status: schema.agentRuns.status })
          .from(schema.agentRuns)
          .where(eq(schema.agentRuns.id, runId)),
      );

      return row!.status;
    }

    async function outboxRow(runId: string) {
      const [row] = await db
        .select({ publishedAt: schema.outbox.publishedAt })
        .from(schema.outbox)
        .where(
          and(eq(schema.outbox.type, 'agent-run.requested'), eq(schema.outbox.aggregateId, runId)),
        );

      return row!;
    }

    async function untilStatus(runId: string, wanted: string): Promise<void> {
      const deadline = Date.now() + RUN_TIMEOUT_MS;

      for (;;) {
        const current = await status(runId);

        if (current === wanted) {
          return;
        }

        if (Date.now() > deadline) {
          throw new Error(`run ${runId} is ${current}, not ${wanted}, after ${RUN_TIMEOUT_MS} ms`);
        }

        await sleep(50);
      }
    }

    /**
     * A worker: `AppModule` as an application context, the way `main.ts` boots one (R2), with the
     * profile set given and whatever else the case overrides. Closed after the case.
     */
    async function boot(
      profiles: readonly string[],
      configure: (builder: TestingModuleBuilder) => TestingModuleBuilder = (builder) => builder,
    ): Promise<TestingModule> {
      const context = await configure(
        Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(RUN_PROFILES_TOKEN)
          .useValue(new Set(profiles))
          // Every worker context would bind `PORT`; the listener has its own spec and is not the point here.
          .overrideProvider(LivenessServer)
          .useValue({}),
      ).compile();

      await context.init();
      contexts.push(context);

      return context;
    }

    function bootWorker(): Promise<TestingModule> {
      return boot(['agent', 'events'], (builder) =>
        builder.overrideProvider(RUN_EXECUTOR).useValue(workerExecutor),
      );
    }

    /** A `cron` context whose sweeps hold the lock long enough for a concurrent tick to meet it. */
    async function bootCron(): Promise<{ context: TestingModule; sweeps: () => number }> {
      const context = await boot(['cron'], (builder) =>
        builder
          .overrideProvider(AGENT_TIMINGS)
          // The rounds below are the ticks; the timer must not add ticks of its own between them.
          .useValue({ ...DEFAULT_AGENT_TIMINGS, reaperMs: 3_600_000 }),
      );
      const store = context.get(RunStore);
      const staleRuns = store.staleRuns.bind(store);
      const spy = vi.spyOn(store, 'staleRuns').mockImplementation(async (tx, before) => {
        await sleep(SWEEP_HOLD_MS);

        return staleRuns(tx, before);
      });

      return { context, sweeps: () => spy.mock.calls.length };
    }

    /** Every cron context ticks at once; returns the indexes of those that swept. */
    async function round(crons: Awaited<ReturnType<typeof bootCron>>[]): Promise<number[]> {
      const before = crons.map(({ sweeps }) => sweeps());

      await Promise.all(crons.map(({ context }) => context.get(RunReaper).tick()));

      return crons.flatMap(({ sweeps }, index) => (sweeps() > before[index]! ? [index] : []));
    }

    async function signUp(): Promise<string> {
      const email = `profiles-${Date.now()}-${signedUp.length}@example.test`;

      signedUp.push(email);
      await api.get(SignupService).register({ email, password: PASSWORD });

      return email;
    }

    /** Milliseconds from a signup on the `api` context to its verification mail landing in `mailer`. */
    async function mailLatency(mailer: InMemoryMailer): Promise<number> {
      const started = performance.now();
      const email = await signUp();

      await awaitMail(
        mailer,
        (message) => message.to === email && message.template === 'email-verification',
        { timeoutMs: RUN_HOLD_MS * 2 },
      );

      return performance.now() - started;
    }

    beforeAll(async () => {
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(RUN_PROFILES_TOKEN)
        .useValue(new Set(['api']))
        .overrideProvider(RUN_EXECUTOR)
        .useValue(apiExecutor)
        .compile();

      apiRelayStart = vi.spyOn(moduleRef.get(OutboxRelay), 'start');
      api = moduleRef.createNestApplication();
      configureApplication(api);
      await api.init();

      db = api.get<ForgeDatabase>(APP_DATABASE);
      transactions = api.get(TenantTransactionRunner);
      world = await createTwoTenantWorld(api);
      // 020: run create resolves a credential, and no process holds a model key (US3; platform
      // credits are retired): the organisation's own, which the scripted executor never reads.
      await seedProviderKey(api, world.alpha);
    }, LOCKED_BOOT_TIMEOUT_MS);

    afterEach(async () => {
      await Promise.all(contexts.splice(0).map((context) => context.close()));
    });

    afterAll(async () => {
      if (signedUp.length > 0) {
        await db.delete(schema.users).where(inArray(schema.users.email, signedUp));
      }

      await destroyTwoTenantWorld(api, world);
      await api?.close();
      await suiteLock?.release();
    });

    it(
      'executes a run the api context only enqueued, on the worker context',
      async () => {
        const runId = await createRun();

        expect(await status(runId)).toBe('queued');

        await bootWorker();

        await untilStatus(runId, 'succeeded');

        expect(apiExecute).not.toHaveBeenCalled();
        expect(api.get(QueueRegistry).workers).toEqual([]);
        expect(apiRelayStart).not.toHaveBeenCalled();
        expect(workerExecute).toHaveBeenCalledTimes(1);
        expect(workerExecute.mock.calls[0]![0].run.id).toBe(runId);
        expect((await outboxRow(runId)).publishedAt).not.toBeNull();
      },
      RUN_TIMEOUT_MS + 5_000,
    );

    it('leaves a run queued and its outbox row unpublished when only the api profile is running', async () => {
      const runId = await createRun();

      // Three ticks, plus one for the timer's slack.
      await sleep(4 * RELAY_TICK_MS);

      expect((await outboxRow(runId)).publishedAt).toBeNull();
      expect(await status(runId)).toBe('queued');
      expect(apiExecute).not.toHaveBeenCalled();
    });

    /** Spec 013 US3 (SC-011): a worker without `agent` needs no model key and holds no run state. */
    it('boots an events context with no model key', async () => {
      const events = await boot(['events']);

      expect(events.get(ConfigService).get('ANTHROPIC_API_KEY')).toBeUndefined();
      expect(events.get(QueueRegistry).workers.map((worker) => worker.name)).toEqual([
        'mail',
        'byok.health',
        'byos.health',
        'repo.mirror',
        'sandbox.ops',
        'deploy.lifecycle',
        'deploy.sweep',
        'domain.check',
        'domain.sweep',
        'connector.health',
        'connector.ops',
        'connector.sync',
        'connector.webhook',
        'integration.out',
        'webhook.fanout',
        'webhook.notice',
        'webhook.sweep',
      ]);
      // `start` ran at bootstrap; `running` is the loop it began, cleared only by `stop`.
      expect(events.get(OutboxRelay)).toMatchObject({ running: true });
      expect(events.get(RunControl)).toMatchObject({ enabled: false, subscriber: undefined });
      expect(events.get(RunReaper)).toMatchObject({ enabled: false, timer: undefined });
      expect(events.get(MaintenanceScheduler)).toMatchObject({ enabled: false, timer: undefined });
    });

    /**
     * Spec 013 US4 (SC-006): two `cron` contexts tick together N times; each round exactly one of
     * them takes `RUN_REAPER_LOCK` and sweeps, so the swept rounds sum to N, not 2N.
     */
    it('sweeps once per tick across two cron contexts', async () => {
      const crons = [await bootCron(), await bootCron()];
      const rounds = 8;
      let swept = 0;

      for (let n = 0; n < rounds; n += 1) {
        const sweepers = await round(crons);

        expect(sweepers).toHaveLength(1);
        swept += sweepers.length;
      }

      expect(swept).toBe(rounds);
    });

    it('hands the sweep to the other cron context when the holder closes', async () => {
      const crons = [await bootCron(), await bootCron()];
      const [holder] = await round(crons);
      const other = crons[1 - holder!]!;

      await crons[holder!]!.context.close();
      contexts.splice(contexts.indexOf(crons[holder!]!.context), 1);

      expect(await round([other])).toEqual([0]);
    });

    /**
     * Spec 013 US5 (SC-007): every slot of the `agent` context is holding a run; a signup's mail
     * still lands from the `events` context within the bound measured idle plus one relay tick.
     */
    it(
      'delivers mail from the events context while the agent context is saturated',
      async () => {
        const mailer = new InMemoryMailer();

        await boot(['events'], (builder) => builder.overrideProvider(MAILER).useValue(mailer));

        const idleMs = await mailLatency(mailer);
        const agent = await boot(['agent'], (builder) =>
          builder.overrideProvider(RUN_EXECUTOR).useValue(workerExecutor),
        );
        const slots = agent.get(AgentRunConsumer).concurrency;
        const script = JSON.stringify({ script: [{ kind: 'sleep', ms: RUN_HOLD_MS }] });
        const runs = await Promise.all(Array.from({ length: slots }, () => createRun(script)));

        await Promise.all(runs.map((runId) => untilStatus(runId, 'running')));

        const busyMs = await mailLatency(mailer);

        expect(busyMs).toBeLessThan(idleMs + RELAY_TICK_MS + SLACK_MS);
        // The mail did not wait for a slot: every run is still in flight.
        expect(await Promise.all(runs.map(status))).toEqual(runs.map(() => 'running'));
      },
      RUN_TIMEOUT_MS * 3,
    );
  });
});
