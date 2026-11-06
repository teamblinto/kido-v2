import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { type NewSandbox, schema } from '@repo/db';
import { and, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { decodeJwt } from 'jose';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from 'vitest';

import {
  type ExecuteRequest,
  type FakeDaytona,
  startFakeDaytona,
} from '../../../test/support/fake-daytona';
import { holdOutboxSuiteLock } from '../../../test/support/outbox-suite-lock';
import { AppModule } from '../../app.module';
import { MemoryObjectStore } from '../../common/object-store/memory-object-store';
import { mirrorKey, OBJECT_STORE } from '../../common/object-store/object-store.port';
import { QUEUE_REDIS } from '../../common/redis/redis.constants';
import { APP_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { RetryableFailure } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import type { EventPayload } from '../outbox/events';
import { OrgService } from '../tenancy/services/org.service';
import { ProjectService } from '../tenancy/services/project.service';
import {
  DAYTONA_TIMINGS,
  DEFAULT_DAYTONA_TIMINGS,
  DEFAULT_DEV_SERVER_TIMINGS,
  DEFAULT_SANDBOX_TIMINGS,
  SANDBOX_CALLBACK_ENV_PATH,
  SANDBOX_PROJECT_ENV_PATH,
  SANDBOX_DEV_SUPERVISOR_PATH,
  SANDBOX_TIMINGS,
  poolFrontKey,
} from './sandbox.constants';
import { DaytonaError } from './sandbox.errors';
import { SandboxOpsConsumer } from './sandbox-ops.consumer';

/** Before any import, as `sandbox-registration.e2e-spec.ts`: `ConfigModule` reads the env once. */
const FAKE = vi.hoisted(() => {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  process.env.DAYTONA_API_URL = `http://127.0.0.1:${port}/api`;
  process.env.DAYTONA_API_KEY = 'dtn_fake_key';
  process.env.SANDBOX_OWNER = 'forge-spec';
  process.env.SANDBOX_CALLBACK_URL = 'https://api.forge.test/api/v1/internal/sandbox-callbacks';

  return { port };
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

type Payload = EventPayload<'sandbox.op.requested'>;
/** Booting waits on the outbox suite lock, which another relay suite may hold for minutes. */
const LOCKED_BOOT_TIMEOUT_MS = 600_000;
/** Read here: the suite's `process()` helper below shadows the global. */
const DATABASE_URL = process.env.DATABASE_URL ?? '';
/** A launch as the supervisor performs it: it re-spawns itself detached and exits `0` (§ 2). */
const launched = () => ({ exitCode: 0, result: '' });

/**
 * Spec 014 contract § 4, the `create` and `label` rows: `handle` re-reads the row and returns
 * early when there is nothing to do; `effect` drives Daytona and settles the record in its own
 * transaction — the project row under its tenant, the pool row on the platform handle plus the
 * Redis front. Against the real database because the settle transactions are the money path.
 */
describe('SandboxOpsConsumer', () => {
  describe.skipIf(!postgres || !redis)(
    'against Postgres, the queue Redis and a fake Daytona',
    () => {
      let moduleRef: TestingModule;
      let database: ForgeDatabase;
      let transactions: TenantTransactionRunner;
      let queue: Redis;
      let consumer: SandboxOpsConsumer;
      let fake: FakeDaytona;
      let orgId: string;
      let projectId: string;
      /** A second project on `python`, the one template that declares no dev server (FR-004). */
      let pythonProjectId: string;
      let userId: string;
      let suiteLock: { release: () => Promise<void> } | undefined;
      const poolIds: string[] = [];
      const repos = new MemoryObjectStore();

      function envelope(payload: Payload): Envelope<'sandbox.op.requested'> {
        return {
          aggregate: 'sandbox',
          aggregateId: payload.sandboxId ?? payload.poolId ?? 'none',
          eventId: randomUUID(),
          occurredAt: new Date().toISOString(),
          orgId: payload.orgId ?? null,
          payload,
          traceId: null,
          type: 'sandbox.op.requested',
        };
      }

      /** `handle` on a fresh transaction, as `ConsumerBase` opens one. */
      function handle(payload: Payload) {
        return database.transaction((tx) => consumer.handle(envelope(payload), tx));
      }

      /** The two phases back to back, as the base runs them. */
      async function process(payload: Payload, attempt?: number): Promise<void> {
        const prepared = await handle(payload);
        await consumer.effect(envelope(payload), prepared, attempt);
      }

      async function seedProjectRow(transition: 'creating' | null, daytonaState = 'creating') {
        const daytonaId = fake.seedSandbox({ state: daytonaState });
        const [row] = await transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .insert(schema.sandboxes)
            .values({
              daytonaId,
              orgId,
              projectId,
              transition,
              transitionSince: transition === null ? null : new Date(),
            })
            .returning({ id: schema.sandboxes.id }),
        );

        return { daytonaId, id: row!.id };
      }

      /** Any project row the story needs, its Daytona twin in `daytonaState`; one per project, so
       * the previous one goes. */
      async function seedRow(values: Partial<NewSandbox>, daytonaState = 'started') {
        await transactions.runInTenantTransaction(orgId, (tx) => tx.delete(schema.sandboxes));
        const daytonaId = values.daytonaId ?? fake.seedSandbox({ state: daytonaState });
        const [row] = await transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .insert(schema.sandboxes)
            .values({ orgId, projectId, workspaceRoot: fake.workDir, ...values, daytonaId })
            .returning({ id: schema.sandboxes.id }),
        );

        return { daytonaId, id: row!.id };
      }

      async function seedPoolRow() {
        const daytonaId = fake.seedSandbox({ state: 'creating' });
        const [row] = await database
          .insert(schema.sandboxPool)
          .values({ daytonaId, snapshot: 'snap', template: 'vite-react' })
          .returning({ id: schema.sandboxPool.id });

        poolIds.push(row!.id);

        return { daytonaId, id: row!.id };
      }

      async function projectRow(id: string) {
        const [row] = await transactions.runInTenantTransaction(orgId, (tx) =>
          tx.select().from(schema.sandboxes).where(eq(schema.sandboxes.id, id)),
        );

        return row!;
      }

      async function poolRow(id: string) {
        const [row] = await database
          .select()
          .from(schema.sandboxPool)
          .where(eq(schema.sandboxPool.id, id));

        return row!;
      }

      const describes = () =>
        fake.requests.filter((r) => r.method === 'GET' && /^\/api\/sandbox\/[^/]+$/.test(r.path));
      const workDirs = () => fake.requests.filter((r) => r.path.endsWith('/work-dir'));
      const uploads = () => fake.requests.filter((r) => r.path.endsWith('/files/upload'));
      const uploadsTo = (absPath: string) => uploads().filter((r) => r.query.path === absPath);
      /** Every platform-originated `execute`, as the daemon received it (spec 023 contract § 2). */
      const launches = () =>
        fake.requests
          .filter((r) => r.path.endsWith('/process/execute'))
          .map((r) => JSON.parse(r.body) as ExecuteRequest);

      /** The env file as the sandbox will read it: one `KEY=value` per line, split on the first `=`. */
      function deliveredEnv(): Record<string, string> {
        const entry = fake.workspace.get(SANDBOX_CALLBACK_ENV_PATH);
        expect(entry?.kind).toBe('file');
        return Object.fromEntries(
          (entry as { content: Buffer }).content
            .toString()
            .trim()
            .split('\n')
            .map((line) => line.split(/=(.*)/s).slice(0, 2)),
        ) as Record<string, string>;
      }

      /** The callback token as the sandbox will read it (spec 017 R11): the env file's two lines. */
      function deliveredToken(): { claims: Record<string, unknown>; url: string } {
        const file = deliveredEnv();
        return { claims: decodeJwt(file.FORGE_CALLBACK_TOKEN!), url: file.FORGE_CALLBACK_URL! };
      }

      beforeAll(async () => {
        // `AppModule` boots a relay against the shared outbox table: one relay-running suite at a time.
        suiteLock = await holdOutboxSuiteLock(DATABASE_URL);
        fake = await startFakeDaytona({ port: FAKE.port });
        moduleRef = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(OBJECT_STORE)
          .useValue(repos)
          .overrideProvider(DAYTONA_TIMINGS)
          .useValue({ ...DEFAULT_DAYTONA_TIMINGS, lookupTtlMs: 0 })
          .overrideProvider(SANDBOX_TIMINGS)
          .useValue({ ...DEFAULT_SANDBOX_TIMINGS, readyBudgetMs: 200, readyPollMs: 10 })
          .compile();
        await moduleRef.init();

        database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
        transactions = moduleRef.get(TenantTransactionRunner);
        queue = moduleRef.get<Redis>(QUEUE_REDIS);
        consumer = moduleRef.get(SandboxOpsConsumer, { strict: false });

        const [user] = await database
          .insert(schema.users)
          .values({ email: `014ops-${randomUUID()}@example.test`, passwordHash: 'x' })
          .returning({ id: schema.users.id });
        userId = user!.id;

        const org = await moduleRef
          .get(OrgService)
          .create(userId, { name: 'Ops fixture', slug: `014ops-${randomUUID().slice(0, 8)}` });
        orgId = org.id;

        const [workspace] = await transactions.runInTenantTransaction(orgId, (tx) =>
          tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
        );
        const project = await transactions.runInTenantScope({ orgId, userId }, () =>
          moduleRef.get(ProjectService).create({
            actorId: userId,
            name: 'Ops',
            orgId,
            ownerId: userId,
            template: 'node-api',
            workspaceId: workspace!.id,
          }),
        );
        projectId = project.id;

        const python = await transactions.runInTenantScope({ orgId, userId }, () =>
          moduleRef.get(ProjectService).create({
            actorId: userId,
            name: 'Ops Python',
            orgId,
            ownerId: userId,
            template: 'python',
            workspaceId: workspace!.id,
          }),
        );
        pythonProjectId = python.id;

        fake.onExecute(launched);
      }, LOCKED_BOOT_TIMEOUT_MS);

      afterEach(async () => {
        await transactions.runInTenantTransaction(orgId, (tx) => tx.delete(schema.sandboxes));
        for (const id of poolIds.splice(0)) {
          await database.delete(schema.sandboxPool).where(eq(schema.sandboxPool.id, id));
        }
        await queue.del(poolFrontKey('vite-react'));
        fake.workspace.delete(SANDBOX_CALLBACK_ENV_PATH);
        fake.workspace.delete(SANDBOX_DEV_SUPERVISOR_PATH);
        fake.requests.length = 0;
      });

      afterAll(async () => {
        await database.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
        await database.delete(schema.users).where(eq(schema.users.id, userId));
        await moduleRef?.close();
        await fake?.close();
        await suiteLock?.release();
      });

      it('is the sandbox.ops consumer on the events profile, 16 wide, 5 attempts, one job per target and op', () => {
        expect(consumer).toMatchObject({
          attempts: 5,
          concurrency: 16,
          profile: 'events',
          queue: 'sandbox.ops',
          types: ['sandbox.op.requested'],
        });
        expect(consumer.jobId(envelope({ op: 'create', orgId, sandboxId: projectId }))).toBe(
          `${projectId}.create`,
        );
        expect(consumer.jobId(envelope({ op: 'create', poolId: userId }))).toBe(`${userId}.create`);
      });

      it('is one job per transition cycle: the same cycle collapses, the next is new (spec 043)', () => {
        const first = '2026-11-03T16:10:29.257Z';
        const at = (since: string) =>
          consumer.jobId(envelope({ op: 'hibernate', orgId, sandboxId: projectId, since }));

        expect(at(first)).toBe(`${projectId}.hibernate.${String(Date.parse(first))}`);
        expect(at(first)).toBe(at(first));
        expect(at('2026-11-03T19:36:04.374Z')).not.toBe(at(first));
        expect(at(first)).not.toContain(':');
      });

      describe('create', () => {
        it('handle returns early for a missing row and for a row not in the creating transition', async () => {
          expect(await handle({ op: 'create', orgId, sandboxId: randomUUID() })).toBeUndefined();
          expect(await handle({ op: 'create', poolId: randomUUID() })).toBeUndefined();

          const { id } = await seedProjectRow(null);
          expect(await handle({ op: 'create', orgId, sandboxId: id })).toBeUndefined();
          expect(describes()).toEqual([]);
        });

        it('polls describe until started, asks the work dir, then settles the project row active under its tenant', async () => {
          const { daytonaId, id } = await seedProjectRow('creating');
          const before = new Date();
          const prepared = await handle({ op: 'create', orgId, sandboxId: id });
          expect(prepared).toBeDefined();

          const settle = sleep(40).then(() => fake.settle(daytonaId));
          await consumer.effect(envelope({ op: 'create', orgId, sandboxId: id }), prepared);
          await settle;

          expect(describes().length).toBeGreaterThanOrEqual(2);
          expect(workDirs()).toHaveLength(1);
          const row = await projectRow(id);
          expect(row).toMatchObject({
            failureReason: null,
            node: fake.runnerId,
            state: 'active',
            transition: null,
            transitionSince: null,
            workspaceRoot: fake.workDir,
          });
          expect(row.stateEnteredAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
        });

        describe('restoring a replaced sandbox (a project with checkpoints)', () => {
          // The app role cannot delete a checkpoint, so each test seeds its own.
          let HEAD = '';
          const key = () => mirrorKey(orgId, projectId);
          const commands = () => launches().map(({ command }) => command);

          async function seedCheckpoint() {
            HEAD = randomUUID().replaceAll('-', '').padEnd(40, '0');
            await transactions.runInTenantTransaction(orgId, (tx) =>
              tx.insert(schema.checkpoints).values({
                files: [],
                gitSha: HEAD,
                kind: 'baseline',
                label: 'Baseline',
                orgId,
                projectId,
              }),
            );
          }

          async function create(id: string, daytonaId: string, attempt?: number) {
            const prepared = await handle({ op: 'create', orgId, sandboxId: id });
            fake.settle(daytonaId);
            await consumer.effect(
              envelope({ op: 'create', orgId, sandboxId: id }),
              prepared,
              attempt,
            );
          }

          afterEach(() => repos.delete(key()));

          it('puts the mirror back before the dev server starts and before the row settles', async () => {
            await seedCheckpoint();
            await repos.put(key(), Buffer.from('bundle'), { head: HEAD });
            fake.onExecute(() => ({ exitCode: 0, result: '' }));
            const { daytonaId, id } = await seedProjectRow('creating');

            await create(id, daytonaId);

            const ran = commands();
            const reset = ran.indexOf(`git reset -q --hard ${HEAD}`);

            expect(ran.indexOf('git init -q')).toBeLessThan(reset);
            expect(reset).toBeGreaterThan(-1);
            expect(ran.indexOf('git clean -fdq')).toBeGreaterThan(reset);
            expect(ran.indexOf('npm ci')).toBeGreaterThan(reset);
            expect(ran.findIndex((command) => command.includes('devserver'))).toBeGreaterThan(
              reset,
            );
            expect(await projectRow(id)).toMatchObject({ state: 'active', transition: null });
          });

          it('retries a restore that fails, keeping the row in transition', async () => {
            await seedCheckpoint();
            await repos.put(key(), Buffer.from('bundle'), { head: HEAD });
            fake.onExecute(() => ({ exitCode: 128, result: 'fatal: bad bundle' }));
            const { daytonaId, id } = await seedProjectRow('creating');

            await expect(create(id, daytonaId, 1)).rejects.toBeInstanceOf(RetryableFailure);

            expect(await projectRow(id)).toMatchObject({ lostAt: null, transition: 'creating' });
          });

          it('on the last attempt loses the row rather than serve a blank template', async () => {
            await seedCheckpoint();
            await repos.put(key(), Buffer.from('bundle'), { head: HEAD });
            fake.onExecute(() => ({ exitCode: 128, result: 'fatal: bad bundle' }));
            const { daytonaId, id } = await seedProjectRow('creating');

            await expect(create(id, daytonaId, consumer.attempts)).rejects.toBeDefined();

            const row = await projectRow(id);

            expect(row.lostAt).not.toBeNull();
            expect(row).toMatchObject({ transition: null });
          });

          it('comes up without a restore when no mirror exists', async () => {
            await seedCheckpoint();
            fake.onExecute(() => ({ exitCode: 0, result: '' }));
            const { daytonaId, id } = await seedProjectRow('creating');

            await create(id, daytonaId);

            expect(commands()).not.toContain('git init -q');
            expect(await projectRow(id)).toMatchObject({ lostAt: null, state: 'active' });
          });
        });

        it('writes the project env file on create, empty for a project with no bindings (spec 030)', async () => {
          const { daytonaId, id } = await seedProjectRow('creating');
          const prepared = await handle({ op: 'create', orgId, sandboxId: id });
          const settle = sleep(40).then(() => fake.settle(daytonaId));
          await consumer.effect(envelope({ op: 'create', orgId, sandboxId: id }), prepared);
          await settle;

          expect(uploadsTo(SANDBOX_PROJECT_ENV_PATH)).toHaveLength(1);
          const entry = fake.workspace.get(SANDBOX_PROJECT_ENV_PATH) as { content: Buffer };
          expect(entry.content.toString()).toBe('');
        });

        it('delivers the callback token to the started sandbox (spec 017 R11: minted at claim)', async () => {
          const { daytonaId, id } = await seedProjectRow('creating');
          const prepared = await handle({ op: 'create', orgId, sandboxId: id });
          const settle = sleep(40).then(() => fake.settle(daytonaId));
          await consumer.effect(envelope({ op: 'create', orgId, sandboxId: id }), prepared);
          await settle;

          expect(uploadsTo(SANDBOX_CALLBACK_ENV_PATH)).toHaveLength(1);
          const { claims, url } = deliveredToken();
          expect(url).toBe('https://api.forge.test/api/v1/internal/sandbox-callbacks');
          expect(claims).toMatchObject({
            aud: 'forge-sandbox-callback',
            leaseEpoch: 0,
            org: orgId,
            project: projectId,
            sandbox: daytonaId,
          });
        });

        it('settles a pool row ready with its work dir and node, and pushes it onto the front', async () => {
          const { daytonaId, id } = await seedPoolRow();
          const settle = sleep(40).then(() => fake.settle(daytonaId));
          await process({ op: 'create', poolId: id });
          await settle;

          expect(workDirs()).toHaveLength(1);
          expect(await poolRow(id)).toMatchObject({
            failureReason: null,
            node: fake.runnerId,
            state: 'ready',
            workspaceRoot: fake.workDir,
          });
          expect((await poolRow(id)).readyAt).not.toBeNull();
          expect(await queue.lrange(poolFrontKey('vite-react'), 0, -1)).toEqual([id]);
        });

        it('retries on an unreachable or upstream Daytona and on an exhausted readiness budget, leaving the row in transition', async () => {
          const { id } = await seedProjectRow('creating');
          fake.refuseNext('describe', 503);
          await expect(process({ op: 'create', orgId, sandboxId: id })).rejects.toMatchObject({
            name: 'RetryableFailure',
            reason: 'upstream-5xx',
          });

          // Never settled by the fake: `creating` outlives the budget.
          await expect(process({ op: 'create', orgId, sandboxId: id })).rejects.toMatchObject({
            name: 'RetryableFailure',
            reason: 'timeout',
          });

          expect(await projectRow(id)).toMatchObject({
            failureReason: null,
            state: 'active',
            transition: 'creating',
            workspaceRoot: null,
          });
        });

        it('settles the record with a retryable failure on the last attempt, since that one is dead-lettered', async () => {
          const { id } = await seedProjectRow('creating');
          fake.refuseNext('describe', 503);
          await expect(
            process({ op: 'create', orgId, sandboxId: id }, consumer.attempts),
          ).rejects.toMatchObject({ name: 'RetryableFailure', reason: 'upstream-5xx' });

          expect(await projectRow(id)).toMatchObject({
            failureReason: expect.stringContaining('upstream') as string,
            transition: null,
            transitionSince: null,
          });
        });

        it('dead-letters any other failure after recording the reason and clearing the transition', async () => {
          const { id } = await seedProjectRow('creating');
          fake.refuseNext('describe', 401);
          const error: unknown = await process({ op: 'create', orgId, sandboxId: id }).catch(
            (e: unknown) => e,
          );

          expect(error).toBeInstanceOf(DaytonaError);
          expect(error).not.toBeInstanceOf(RetryableFailure);
          expect(await projectRow(id)).toMatchObject({
            failureReason: expect.stringContaining('unauthorised') as string,
            transition: null,
            transitionSince: null,
            workspaceRoot: null,
          });

          const pool = await seedPoolRow();
          fake.refuseNext('describe', 401);
          await expect(process({ op: 'create', poolId: pool.id })).rejects.toBeInstanceOf(
            DaytonaError,
          );
          expect(await poolRow(pool.id)).toMatchObject({
            failureReason: expect.stringContaining('unauthorised') as string,
            state: 'creating',
          });
          expect(await queue.lrange(poolFrontKey('vite-react'), 0, -1)).toEqual([]);
        });
      });

      describe('label', () => {
        it('handle returns early for a missing row', async () => {
          expect(await handle({ op: 'label', orgId, sandboxId: randomUUID() })).toBeUndefined();
        });

        it("replaces the whole label map with the owner, the project's template, the kind and the project id", async () => {
          const { daytonaId, id } = await seedProjectRow(null, 'started');
          fake.sandboxes.get(daytonaId)!.labels = { stale: 'yes' };

          await process({ op: 'label', orgId, sandboxId: id });

          expect(fake.sandboxes.get(daytonaId)!.labels).toEqual({
            'forge.kind': 'project',
            'forge.owner': 'forge-spec',
            'forge.project': projectId,
            'forge.template': 'node-api',
          });
        });

        it('delivers the callback token on a pool claim (the row is active) and not while a cold one is still creating', async () => {
          const { daytonaId, id } = await seedProjectRow(null, 'started');
          await process({ op: 'label', orgId, sandboxId: id });
          expect(uploadsTo(SANDBOX_CALLBACK_ENV_PATH)).toHaveLength(1);
          expect(uploadsTo(SANDBOX_PROJECT_ENV_PATH)).toHaveLength(1);
          expect(deliveredToken().claims).toMatchObject({ project: projectId, sandbox: daytonaId });

          fake.workspace.delete(SANDBOX_CALLBACK_ENV_PATH);
          await transactions.runInTenantTransaction(orgId, (tx) => tx.delete(schema.sandboxes));
          const cold = await seedProjectRow('creating');
          await process({ op: 'label', orgId, sandboxId: cold.id });
          expect(uploadsTo(SANDBOX_CALLBACK_ENV_PATH)).toHaveLength(1);
          expect(fake.workspace.has(SANDBOX_CALLBACK_ENV_PATH)).toBe(false);
        });
      });

      describe('hibernate', () => {
        const stops = () => fake.requests.filter((r) => r.path.endsWith('/stop'));

        it('handle returns early for a missing row, a hibernated row and a row not in the hibernating transition', async () => {
          expect(await handle({ op: 'hibernate', orgId, sandboxId: randomUUID() })).toBeUndefined();

          const done = await seedRow(
            { hibernatedAt: new Date(), state: 'hibernated', transition: null },
            'stopped',
          );
          expect(await handle({ op: 'hibernate', orgId, sandboxId: done.id })).toBeUndefined();

          const settled = await seedRow({ state: 'idle', transition: null });
          expect(await handle({ op: 'hibernate', orgId, sandboxId: settled.id })).toBeUndefined();

          const resuming = await seedRow({
            state: 'idle',
            transition: 'resuming',
            transitionSince: new Date(),
          });
          expect(await handle({ op: 'hibernate', orgId, sandboxId: resuming.id })).toBeUndefined();
          expect(stops()).toEqual([]);
        });

        it('stops the sandbox, polls until stopped, then settles hibernated with hibernated_at and no transition', async () => {
          const { daytonaId, id } = await seedRow({
            state: 'idle',
            transition: 'hibernating',
            transitionSince: new Date(),
          });
          const before = new Date();
          const settle = sleep(40).then(() => fake.settle(daytonaId));

          await process({ op: 'hibernate', orgId, sandboxId: id });
          await settle;

          expect(stops()).toHaveLength(1);
          expect(describes().length).toBeGreaterThanOrEqual(2);
          expect(fake.sandboxes.get(daytonaId)!.state).toBe('stopped');
          const row = await projectRow(id);
          expect(row).toMatchObject({
            failureReason: null,
            state: 'hibernated',
            transition: null,
            transitionSince: null,
          });
          expect(row.hibernatedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
          expect(row.stateEnteredAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
        });

        it('marks the row lost and dead-letters when Daytona has no such sandbox', async () => {
          const { id } = await seedRow({
            daytonaId: `ghost-${randomUUID()}`,
            state: 'idle',
            transition: 'hibernating',
            transitionSince: new Date(),
          });

          await expect(process({ op: 'hibernate', orgId, sandboxId: id })).rejects.toMatchObject({
            kind: 'sandbox-not-found',
            name: 'DaytonaError',
          });

          const row = await projectRow(id);
          expect(row).toMatchObject({
            failureReason: expect.stringContaining('sandbox-not-found') as string,
            state: 'idle',
            transition: null,
          });
          expect(row.lostAt).not.toBeNull();
        });
      });

      describe('resume', () => {
        const starts = () => fake.requests.filter((r) => r.path.endsWith('/start'));

        it('handle returns early for a missing row, a row not hibernated and a row not in the resuming transition', async () => {
          expect(await handle({ op: 'resume', orgId, sandboxId: randomUUID() })).toBeUndefined();

          const active = await seedRow({
            state: 'active',
            transition: 'resuming',
            transitionSince: new Date(),
          });
          expect(await handle({ op: 'resume', orgId, sandboxId: active.id })).toBeUndefined();

          const settled = await seedRow(
            { hibernatedAt: new Date(), state: 'hibernated', transition: null },
            'stopped',
          );
          expect(await handle({ op: 'resume', orgId, sandboxId: settled.id })).toBeUndefined();
          expect(starts()).toEqual([]);
        });

        it('is a new job every cycle: the last wake’s finished job cannot swallow this one', () => {
          const at = (since: string) =>
            consumer.jobId(envelope({ op: 'resume', orgId, sandboxId: projectId, since }));

          expect(at('2026-11-05T09:52:03.000Z')).not.toBe(at('2026-11-06T03:21:26.000Z'));
        });

        it('handle returns early for a cycle the row has left, and takes the one it is in', async () => {
          const since = new Date('2026-11-06T03:21:26.779Z');
          const { id } = await seedRow(
            {
              hibernatedAt: new Date(),
              state: 'hibernated',
              transition: 'resuming',
              transitionSince: since,
            },
            'stopped',
          );
          const ask = (at: string | undefined) =>
            handle({
              op: 'resume',
              orgId,
              sandboxId: id,
              ...(at === undefined ? {} : { since: at }),
            });

          expect(await ask('2026-11-06T03:00:00.000Z')).toBeUndefined();
          expect(await ask(since.toISOString())).toBeDefined();
          expect(await ask(undefined)).toBeDefined();
        });

        it('takes a wake at epoch 0 after a run resumed the sandbox at a higher epoch', async () => {
          const since = new Date();
          const { id } = await seedRow(
            {
              hibernatedAt: new Date(),
              state: 'hibernated',
              transition: 'resuming',
              transitionSince: since,
            },
            'stopped',
          );
          await database.insert(schema.outbox).values({
            aggregate: 'sandbox',
            aggregateId: id,
            occurredAt: new Date(),
            originOrgId: orgId,
            payload: { leaseEpoch: 7, op: 'resume', orgId, sandboxId: id },
            publishedAt: new Date(),
            type: 'sandbox.op.requested',
          });

          expect(
            await handle({
              leaseEpoch: 0,
              op: 'resume',
              orgId,
              sandboxId: id,
              since: since.toISOString(),
            }),
          ).toBeDefined();
        });

        it('starts the sandbox, polls until started, asks the work dir, then settles active with hibernated_at cleared', async () => {
          const { daytonaId, id } = await seedRow(
            {
              hibernatedAt: new Date(),
              lastSeenAt: new Date(0),
              state: 'hibernated',
              stateEnteredAt: new Date(0),
              transition: 'resuming',
              transitionSince: new Date(),
              workspaceRoot: null,
            },
            'stopped',
          );
          const before = new Date();

          await process({ leaseEpoch: 1, op: 'resume', orgId, sandboxId: id });

          expect(starts()).toHaveLength(1);
          expect(describes().length).toBeGreaterThanOrEqual(1);
          expect(workDirs()).toHaveLength(1);
          expect(fake.sandboxes.get(daytonaId)!.state).toBe('started');
          const row = await projectRow(id);
          expect(row).toMatchObject({
            failureReason: null,
            hibernatedAt: null,
            node: fake.runnerId,
            state: 'active',
            transition: null,
            transitionSince: null,
            workspaceRoot: fake.workDir,
          });
          expect(row.stateEnteredAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
          expect(row.lastSeenAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
        });

        it('re-mints the callback token: the started sandbox holds a fresh one, not the claim-time one', async () => {
          const { daytonaId, id } = await seedRow(
            {
              hibernatedAt: new Date(),
              state: 'hibernated',
              transition: 'resuming',
              transitionSince: new Date(),
            },
            'stopped',
          );
          fake.workspace.set(SANDBOX_CALLBACK_ENV_PATH, {
            content: Buffer.from('FORGE_CALLBACK_TOKEN=stale\n'),
            kind: 'file',
          });

          await process({ leaseEpoch: 1, op: 'resume', orgId, sandboxId: id });

          expect(uploadsTo(SANDBOX_CALLBACK_ENV_PATH)).toHaveLength(1);
          const { claims } = deliveredToken();
          expect(claims).toMatchObject({ leaseEpoch: 0, org: orgId, sandbox: daytonaId });
          expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
        });

        it('marks the row lost and dead-letters when Daytona has no such sandbox', async () => {
          const { id } = await seedRow({
            daytonaId: `ghost-${randomUUID()}`,
            hibernatedAt: new Date(),
            state: 'hibernated',
            transition: 'resuming',
            transitionSince: new Date(),
          });

          await expect(process({ op: 'resume', orgId, sandboxId: id })).rejects.toMatchObject({
            kind: 'sandbox-not-found',
            name: 'DaytonaError',
          });

          const row = await projectRow(id);
          expect(row).toMatchObject({ state: 'hibernated', transition: null });
          expect(row.lostAt).not.toBeNull();
        });
      });

      /**
       * Spec 023 US1: the three moments a sandbox becomes this project's each deliver the whole
       * runtime — the dev server lines on the env file, the supervisor beside it, and the one
       * launch above the agent's allowlist (FR-005). The fixture project is on `node-api`, which
       * declares `npm run dev` on `3000`.
       */
      describe('the dev server', () => {
        beforeEach(() => {
          fake.onExecute(launched);
        });

        /** Everything the delivery owes a template that declares a dev server, whichever op ran. */
        function expectDelivered(daytonaId: string): void {
          const env = deliveredEnv();
          expect(env.FORGE_DEV_COMMAND).toBe('npm run dev');
          expect(env.FORGE_DEV_PORT).toBe('3000');
          expect(JSON.parse(env.FORGE_DEV_TIMINGS!)).toEqual(DEFAULT_DEV_SERVER_TIMINGS);
          expect(env.FORGE_CALLBACK_URL).toBe(
            'https://api.forge.test/api/v1/internal/sandbox-callbacks',
          );

          const supervisorUploads = uploadsTo(SANDBOX_DEV_SUPERVISOR_PATH);
          expect(supervisorUploads).toHaveLength(1);
          expect(supervisorUploads[0]!.path).toContain(daytonaId);
          const supervisor = fake.workspace.get(SANDBOX_DEV_SUPERVISOR_PATH);
          expect(supervisor?.kind).toBe('file');
          expect((supervisor as { content: Buffer }).content.byteLength).toBeGreaterThan(0);

          expect(launches()).toHaveLength(1);
          expect(launches()[0]).toMatchObject({
            command: `node ${SANDBOX_DEV_SUPERVISOR_PATH}`,
            cwd: fake.workDir,
          });
        }

        it('writes the dev server lines, uploads the supervisor and launches it on create', async () => {
          const { daytonaId, id } = await seedProjectRow('creating');
          const prepared = await handle({ op: 'create', orgId, sandboxId: id });
          const settle = sleep(40).then(() => fake.settle(daytonaId));
          await consumer.effect(envelope({ op: 'create', orgId, sandboxId: id }), prepared);
          await settle;

          expectDelivered(daytonaId);
          expect(await projectRow(id)).toMatchObject({ state: 'active', transition: null });
        });

        it('writes the dev server lines, uploads the supervisor and launches it on a pool claim', async () => {
          const { daytonaId, id } = await seedRow({ state: 'active', transition: null });

          await process({ op: 'label', orgId, sandboxId: id });

          expectDelivered(daytonaId);
        });

        it('writes the dev server lines, uploads the supervisor and launches it on resume', async () => {
          const { daytonaId, id } = await seedRow(
            {
              hibernatedAt: new Date(),
              state: 'hibernated',
              transition: 'resuming',
              transitionSince: new Date(),
            },
            'stopped',
          );

          await process({ leaseEpoch: 1, op: 'resume', orgId, sandboxId: id });

          expectDelivered(daytonaId);
          // Spec 030: the project env file is rewritten at resume as well.
          expect(uploadsTo(SANDBOX_PROJECT_ENV_PATH)).toHaveLength(1);
        });

        it('clears the last start’s dev server reports on resume, so a hibernated listening never reads as ready', async () => {
          const { id } = await seedRow(
            {
              hibernatedAt: new Date(),
              ports: { 3000: { observedAt: '2026-11-03T10:00:00.000Z', state: 'listening' } },
              state: 'hibernated',
              transition: 'resuming',
              transitionSince: new Date(),
            },
            'stopped',
          );

          await process({ leaseEpoch: 1, op: 'resume', orgId, sandboxId: id });

          expect(launches()).toHaveLength(1);
          expect(await projectRow(id)).toMatchObject({ ports: {}, state: 'active' });
        });

        it('delivers the callback token alone to a project on python, which declares no dev server', async () => {
          const { daytonaId, id } = await seedRow({
            projectId: pythonProjectId,
            state: 'active',
            transition: null,
          });

          await process({ op: 'label', orgId, sandboxId: id });

          const env = deliveredEnv();
          expect(Object.keys(env)).toEqual(['FORGE_CALLBACK_TOKEN', 'FORGE_CALLBACK_URL']);
          expect(decodeJwt(env.FORGE_CALLBACK_TOKEN!)).toMatchObject({
            project: pythonProjectId,
            sandbox: daytonaId,
          });
          expect(uploadsTo(SANDBOX_DEV_SUPERVISOR_PATH)).toEqual([]);
          expect(launches()).toEqual([]);
        });

        it('settles the claim active when the launch fails, since a sandbox serving nothing yet is a working state', async () => {
          fake.onExecute(() => ({ exitCode: 1, result: 'node: no such file\n' }));
          const { daytonaId, id } = await seedProjectRow('creating');
          const prepared = await handle({ op: 'create', orgId, sandboxId: id });
          const settle = sleep(40).then(() => fake.settle(daytonaId));

          await expect(
            consumer.effect(envelope({ op: 'create', orgId, sandboxId: id }), prepared),
          ).resolves.toBeUndefined();
          await settle;

          expect(launches()).toHaveLength(1);
          expect(await projectRow(id)).toMatchObject({
            failureReason: null,
            state: 'active',
            transition: null,
            transitionSince: null,
            workspaceRoot: fake.workDir,
          });
        });
      });

      describe('release', () => {
        const removes = () => fake.requests.filter((r) => r.method === 'DELETE');

        async function auditsFor(target: string) {
          return transactions.runInTenantTransaction(orgId, (tx) =>
            tx
              .select({ action: schema.auditLog.action, metadata: schema.auditLog.metadata })
              .from(schema.auditLog)
              .where(
                and(
                  eq(schema.auditLog.target, target),
                  eq(schema.auditLog.action, 'sandbox.released'),
                ),
              ),
          );
        }

        it('handle returns early for a missing row', async () => {
          expect(await handle({ op: 'release', orgId, sandboxId: randomUUID() })).toBeUndefined();
          expect(await handle({ op: 'release', poolId: randomUUID() })).toBeUndefined();
        });

        it('deletes at Daytona with force, then deletes the project row and audits sandbox.released', async () => {
          const { daytonaId, id } = await seedRow({
            state: 'active',
            transition: 'releasing',
            transitionSince: new Date(),
          });

          await process({ op: 'release', orgId, sandboxId: id });

          expect(removes().map((r) => r.url)).toEqual([`/api/sandbox/${daytonaId}?force=true`]);
          expect(fake.sandboxes.has(daytonaId)).toBe(false);
          const [row] = await transactions.runInTenantTransaction(orgId, (tx) =>
            tx.select().from(schema.sandboxes).where(eq(schema.sandboxes.id, id)),
          );
          expect(row).toBeUndefined();
          expect(await auditsFor(id)).toEqual([
            { action: 'sandbox.released', metadata: { daytonaId, projectId } },
          ]);
        });

        it('treats a 404 as released, and deletes a pool row without an audit entry', async () => {
          const gone = await seedRow({ daytonaId: `ghost-${randomUUID()}`, state: 'active' });
          await process({ op: 'release', orgId, sandboxId: gone.id });
          const [row] = await transactions.runInTenantTransaction(orgId, (tx) =>
            tx.select().from(schema.sandboxes).where(eq(schema.sandboxes.id, gone.id)),
          );
          expect(row).toBeUndefined();

          const pool = await seedPoolRow();
          await process({ op: 'release', poolId: pool.id });

          expect(fake.sandboxes.has(pool.daytonaId)).toBe(false);
          expect(await poolRow(pool.id)).toBeUndefined();
          expect(await auditsFor(pool.id)).toEqual([]);
        });
      });
    },
  );
});
