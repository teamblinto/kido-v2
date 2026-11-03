import { type INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  type MockInstance,
  vi,
} from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { QUEUE_REDIS } from '../src/common/redis/redis.constants';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../src/modules/identity/password/breached-password.port';
import { PoolRefill } from '../src/modules/sandbox/pool-refill';
import { PoolSettingsService } from '../src/modules/sandbox/pool-settings';
import {
  DEFAULT_SANDBOX_TIMINGS,
  poolFrontKey,
  SANDBOX_TIMINGS,
  type SandboxTimings,
} from '../src/modules/sandbox/sandbox.constants';
import { SandboxClaim } from '../src/modules/sandbox/sandbox-claim';
import { ProjectService } from '../src/modules/tenancy/services/project.service';
import { parseArgs, run } from '../src/scripts/sandbox-pool';
import { type FakeDaytona, startFakeDaytona } from './support/fake-daytona';
import { dropFakeVersions, publishFakeVersion } from './support/template-versions';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

/** Before any import, as `sandbox-lifecycle.e2e-spec.ts`: `api` for the fixture, `events` for the ops. */
const FAKE = vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  process.env.RUN_PROFILES = 'api,events';
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

const LOCKED_BOOT_TIMEOUT_MS = 600_000;
const STEP_TIMEOUT_MS = 15_000;
/** The lifecycle e2e's template too; both suites hold the outbox suite lock, so never at once. */
const TEMPLATE = 'vite-react' as const;
/** A template this suite leaves without a published version (scenario 5); the claim spec's, under the same lock. */
const BARE_TEMPLATE = 'python' as const;
const SNAPSHOT = `forge/pool-e2e:${randomUUID().slice(0, 8)}`;
const SANDBOX: SandboxTimings = {
  ...DEFAULT_SANDBOX_TIMINGS,
  readyBudgetMs: 5_000,
  readyPollMs: 50,
};

class ScriptedBreachPort implements BreachedPasswordPort {
  isBreached(_password: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}

async function until(what: string, predicate: () => Promise<boolean>, ms = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + ms;

  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Spec 014 US3 (quickstart § Integration, the US3 rows): the `sandbox:pool` command's module
 * function in-process against the booted application, `PoolRefill.refill()` per step the way
 * the maintenance job calls it, the `sandbox.ops` consumer settling creates and releases at a
 * fake Daytona.
 */
describe('Sandbox pool dial (e2e)', () => {
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
      let claim: SandboxClaim;
      let settings: PoolSettingsService;
      let suiteLock: { release: () => Promise<void> } | undefined;
      let log: MockInstance<typeof console.log>;
      let error: MockInstance<typeof console.error>;
      let warn: MockInstance<Logger['warn']>;

      /** The command, argv as the operator would type it after `sandbox:pool --`. */
      const pool = (...argv: string[]) => run(app, parseArgs(argv));
      const printed = () => log.mock.calls.map(([line]) => String(line));

      const poolRows = () =>
        db.select().from(schema.sandboxPool).where(eq(schema.sandboxPool.snapshot, SNAPSHOT));
      const ready = async () => (await poolRows()).filter((r) => r.state === 'ready');

      /** `refill()` then the fake's runner catching up; resolves once `n` rows are on the front. */
      async function refillTo(n: number) {
        await refill.refill();
        for (const row of await poolRows()) fake.settle(row.daytonaId);
        await until(
          `${String(n)} ready pool rows`,
          async () =>
            (await ready()).length === n && (await queue.llen(poolFrontKey(TEMPLATE))) >= n,
        );
      }

      async function releaseOpsFor(poolIds: readonly string[]) {
        if (poolIds.length === 0) return [];
        const rows = await db
          .select({ payload: schema.outbox.payload })
          .from(schema.outbox)
          .where(
            and(
              eq(schema.outbox.type, 'sandbox.op.requested'),
              inArray(schema.outbox.aggregateId, [...poolIds]),
            ),
          );

        return rows.filter((row) => (row.payload as { op: string }).op === 'release');
      }

      async function anotherProject(name: string): Promise<string> {
        const { orgId, owner, workspaceId } = world.alpha;
        const project = await transactions.runInTenantScope({ orgId, userId: owner.userId }, () =>
          app
            .get(ProjectService)
            .create({ actorId: owner.userId, name, orgId, ownerId: owner.userId, workspaceId }),
        );

        return project.id;
      }

      const sandboxRow = (projectId: string) =>
        transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx.query.sandboxes.findFirst({
            where: and(
              eq(schema.sandboxes.orgId, world.alpha.orgId),
              eq(schema.sandboxes.projectId, projectId),
            ),
          }),
        );

      beforeAll(async () => {
        suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
        fake = await startFakeDaytona({ port: FAKE.port });

        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(BREACHED_PASSWORD_PORT)
          .useClass(ScriptedBreachPort)
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
        claim = app.get(SandboxClaim, { strict: false });
        settings = app.get(PoolSettingsService, { strict: false });
        await queue.del(poolFrontKey(TEMPLATE));
        await db
          .delete(schema.sandboxPoolSettings)
          .where(inArray(schema.sandboxPoolSettings.template, [TEMPLATE, BARE_TEMPLATE]));
        // Spec 015 (R8): the pool's source is the template's current version, not a dial.
        await dropFakeVersions(db, BARE_TEMPLATE);
        await publishFakeVersion(db, TEMPLATE, SNAPSHOT);
        world = await createTwoTenantWorld(app);
      }, LOCKED_BOOT_TIMEOUT_MS);

      beforeEach(() => {
        fake.requests.splice(0);
        log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      });

      afterAll(async () => {
        vi.restoreAllMocks();
        if (world) await destroyTwoTenantWorld(app, world);
        await db?.delete(schema.sandboxPool).where(eq(schema.sandboxPool.snapshot, SNAPSHOT));
        await db
          ?.delete(schema.sandboxPoolSettings)
          .where(inArray(schema.sandboxPoolSettings.template, [TEMPLATE, BARE_TEMPLATE]));
        if (db) await dropFakeVersions(db, TEMPLATE);
        await queue?.del(poolFrontKey(TEMPLATE));
        await app?.close();
        await fake?.close();
        await suiteLock?.release();
      });

      /** SC-007, quickstart row US3 · SC-007. */
      it(
        'the dial moves the pool both ways without a restart',
        async () => {
          expect(await pool('set', TEMPLATE, '--depth', '4')).toBe(0);
          await refillTo(4);
          expect((await poolRows()).map((r) => r.state)).toEqual(Array(4).fill('ready'));

          // A project row created in between: the dial never takes a sandbox from a project.
          const projectId = await anotherProject('Bystander');
          const daytonaId = fake.seedSandbox({ state: 'started' });
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
          const bystander = await sandboxRow(projectId);

          // Up: 4 → 12 in one pass (the batch is 8), no restart, nothing but this template.
          expect(await pool('set', TEMPLATE, '--depth', '12')).toBe(0);
          fake.requests.splice(0);
          await refillTo(12);
          const creates = fake.requests.filter(
            (r) => r.method === 'POST' && r.path === '/api/sandbox',
          );
          expect(creates).toHaveLength(8);
          expect(
            creates.map((r) => (JSON.parse(r.body) as { labels: Record<string, string> }).labels),
          ).toEqual(
            Array(8).fill({
              'forge.kind': 'pool',
              'forge.owner': 'forge-test',
              'forge.template': TEMPLATE,
            }),
          );
          const twelve = await ready();
          expect(twelve).toHaveLength(12);
          // The operator's view: target, ready, creating, releasing, last refilled.
          log.mockClear();
          expect(await pool('show')).toBe(0);
          const view = printed().find((line) => line.startsWith(`${TEMPLATE} `));
          expect(view).toBe(
            `${TEMPLATE} 12 12 0 0 ${new Date(
              Math.max(...twelve.map((r) => r.readyAt!.getTime())),
            ).toISOString()}`,
          );

          // Down: 12 → 1; 11 `release` ops, 11 deletes at the provider, the project row untouched.
          expect(await pool('set', TEMPLATE, '--depth', '1')).toBe(0);
          fake.requests.splice(0);
          await refill.refill();
          const releasing = (await poolRows()).filter((r) => r.state === 'releasing');
          expect(releasing).toHaveLength(11);
          expect(await releaseOpsFor(releasing.map((r) => r.id))).toHaveLength(11);
          await until('11 releases to land', async () => (await poolRows()).length === 1);
          expect((await poolRows()).map((r) => r.state)).toEqual(['ready']);
          // The front is a hint (research R3): the released ids stay until a claim discards them.
          expect(await queue.lrange(poolFrontKey(TEMPLATE), 0, -1)).toContain(
            (await poolRows())[0]!.id,
          );
          expect(fake.requests.filter((r) => r.method === 'DELETE')).toHaveLength(11);
          for (const row of releasing) expect(fake.sandboxes.has(row.daytonaId)).toBe(false);
          expect(fake.sandboxes.get(daytonaId)?.state).toBe('started');
          expect(await sandboxRow(projectId)).toEqual(bystander);
        },
        STEP_TIMEOUT_MS * 4,
      );

      /** US3 scenario 3, quickstart row US3 · scenario 3: a Daytona outage during refill. */
      it(
        'a provider outage mid-refill keeps what succeeded, retries the rest, and a claim still succeeds',
        async () => {
          expect(await ready()).toHaveLength(1);
          expect(await pool('set', TEMPLATE, '--depth', '4')).toBe(0);
          fake.refuseNext('create', 503);

          // The refused `POST` propagates as retryable: the pass ends, what stands stands.
          await expect(refill.refill()).rejects.toMatchObject({ retryable: true });
          const held = await poolRows();
          expect(held).toHaveLength(1);
          expect(held[0]).toMatchObject({ state: 'ready' });

          // A claim against the pool succeeds meanwhile, on the one that is ready.
          const projectId = await anotherProject('Meanwhile');
          const ref = { orgId: world.alpha.orgId, projectId };
          expect(
            await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
              claim.claim(tx, ref, TEMPLATE, { leaseEpoch: 1, operationId: 'run-1/step-0' }),
            ),
          ).toEqual({ ready: true });
          expect(await sandboxRow(projectId)).toMatchObject({
            daytonaId: held[0]!.daytonaId,
            state: 'active',
          });
          expect(await poolRows()).toEqual([]);

          // The next pass fills the rest.
          fake.requests.splice(0);
          await refillTo(4);
          expect(
            fake.requests.filter((r) => r.method === 'POST' && r.path === '/api/sandbox'),
          ).toHaveLength(4);
          expect(await ready()).toHaveLength(4);
        },
        STEP_TIMEOUT_MS * 2,
      );

      /** US3 scenario 4, quickstart row US3 · scenario 4/5, first half. */
      it('a depth outside 0..64 is refused naming the range', async () => {
        const before = await settings.read(TEMPLATE);

        expect(await pool('set', TEMPLATE, '--depth', '65')).toBe(1);
        expect(await pool('set', TEMPLATE, '--depth', '-1')).toBe(1);

        const refusals = error.mock.calls.map(([line]) => String(line));
        expect(refusals).toHaveLength(2);
        for (const line of refusals) expect(line).toContain('0..64');
        expect(await settings.read(TEMPLATE)).toEqual(before);
        expect(printed()).toEqual([]);
      });

      /** US3 scenario 5, quickstart row US3 · scenario 4/5, second half. */
      it(
        'a template with no published version stays empty with a recorded reason while the others refill',
        async () => {
          expect(await pool('set', BARE_TEMPLATE, '--depth', '2')).toBe(0);
          expect(printed()).toEqual([`${BARE_TEMPLATE} 2 0 0 0 -`]);
          expect(await pool('set', TEMPLATE, '--depth', '6')).toBe(0);
          fake.requests.splice(0);

          await refillTo(6);

          expect(
            warn.mock.calls.filter(([line]) =>
              String(line).startsWith(`pool ${BARE_TEMPLATE}: no current version (target 2)`),
            ),
          ).toHaveLength(1);
          expect(
            await db
              .select()
              .from(schema.sandboxPool)
              .where(eq(schema.sandboxPool.template, BARE_TEMPLATE)),
          ).toEqual([]);
          // The other template refilled normally: 4 ready → 6, every create labelled for it.
          const creates = fake.requests.filter(
            (r) => r.method === 'POST' && r.path === '/api/sandbox',
          );
          expect(creates).toHaveLength(2);
          expect(
            creates.map(
              (r) =>
                (JSON.parse(r.body) as { labels: Record<string, string> }).labels['forge.template'],
            ),
          ).toEqual([TEMPLATE, TEMPLATE]);
        },
        STEP_TIMEOUT_MS * 2,
      );
    },
  );
});
