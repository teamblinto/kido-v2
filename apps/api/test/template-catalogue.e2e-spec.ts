import { type INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  problemDetailSchema,
  PROJECT_TEMPLATES,
  type ProjectTemplate,
  templateCatalogueResponseSchema,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import path from 'node:path';
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
import { SANDBOX_LIFECYCLE, type SandboxLifecycle } from '../src/modules/sandbox/sandbox-lifecycle';
import { TEMPLATES_DIR, TemplateCatalogue } from '../src/modules/sandbox/template-catalogue';
import { TemplateVersions } from '../src/modules/sandbox/template-versions';
import { ProjectService } from '../src/modules/tenancy/services/project.service';
import { parseArgs, run } from '../src/scripts/template-publish';
import { type FakeDaytona, startFakeDaytona } from './support/fake-daytona';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  http,
  signUpAndIn,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';
import { dropFakeVersions, publishFakeVersion } from './support/template-versions';

/**
 * Before any import, as `sandbox-pool.e2e-spec.ts`: `api` for the publisher, `events` for the
 * ops the later stories settle. `trace` so the key check below runs at the level that emits most.
 * The key is syntactically real and unique to this run, so a leak cannot be masked by a value that
 * happens to appear elsewhere.
 */
const FAKE = vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  process.env.RUN_PROFILES = 'api,events';
  process.env.LOG_LEVEL = 'trace';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.THROTTLE_LIMIT = '100000';

  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const apiKey = `dtn_e2e_${'7c1f'.repeat(8)}${String(port)}`;
  process.env.DAYTONA_API_URL = `http://127.0.0.1:${port}/api`;
  process.env.DAYTONA_API_KEY = apiKey;

  return { apiKey, port };
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const LOCKED_BOOT_TIMEOUT_MS = 600_000;
const STEP_TIMEOUT_MS = 20_000;
/** The four fixture definitions the catalogue is pointed at; the real `templates/` is for T030. */
const FIXTURES = path.join(__dirname, 'fixtures/templates/good');
/** The template whose version the failure, race, takeover and `show` cases turn over. */
const TEMPLATE = 'nextjs' as const;
const SANDBOX: SandboxTimings = {
  ...DEFAULT_SANDBOX_TIMINGS,
  buildTimeoutMs: 5_000,
  readyBudgetMs: 5_000,
  readyPollMs: 10,
  snapshotPollMs: 10,
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
 * Spec 015 US2 (quickstart § Integration, the US2 rows): the `template:publish` / `template:show`
 * command driven in-process through `run(app, args)` against the real `TemplatePublisher`, real
 * Postgres and `queue` Redis, and a fake Daytona whose runner is caught up by a ticker — a
 * capture settles by `settleSnapshot`, never by wall-clock time. Later stories extend this file
 * with their own `describe` blocks.
 */
describe('Template catalogue (e2e)', () => {
  describe.skipIf(!postgres || !redis)(
    'against Postgres, the queue Redis and a fake Daytona',
    () => {
      let app: INestApplication;
      let fake: FakeDaytona;
      let db: ForgeDatabase;
      let queue: Redis;
      let catalogue: TemplateCatalogue;
      let suiteLock: { release: () => Promise<void> } | undefined;
      let ticker: NodeJS.Timeout;
      /** Snapshot names the runner fails instead of settling, with the reason. */
      const failing = new Map<string, string>();
      /** While true the runner leaves pool sandboxes `creating` — a refill pass caught mid-way. */
      let holdPool = false;
      let world: TwoTenantWorld | undefined;
      let log: MockInstance<typeof console.log>;
      let error: MockInstance<typeof console.error>;

      const publish = (...argv: string[]) => run(app, parseArgs(['publish', ...argv]));
      const show = () => run(app, parseArgs(['show']));
      const printed = () => log.mock.calls.map(([line]) => String(line));
      const def = (template: ProjectTemplate) => catalogue.get(template);

      const versionRows = (template: ProjectTemplate) =>
        db
          .select()
          .from(schema.templateVersions)
          .where(eq(schema.templateVersions.template, template));
      const currentOf = async (template: ProjectTemplate) =>
        (await versionRows(template)).find((row) => row.current) ?? null;
      const dropVersion = (template: ProjectTemplate, digest: string) =>
        db
          .delete(schema.templateVersions)
          .where(
            and(
              eq(schema.templateVersions.template, template),
              eq(schema.templateVersions.digest, digest),
            ),
          );

      const snapshotPosts = () =>
        fake.requests.filter(
          (r) => r.method === 'POST' && /^\/api\/sandbox\/[^/]+\/snapshot$/.test(r.path),
        );
      const buildSandboxes = () =>
        [...fake.sandboxes.values()].filter((s) => s.labels['forge.kind'] === 'build');

      beforeAll(async () => {
        suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
        fake = await startFakeDaytona({ apiKey: FAKE.apiKey, port: FAKE.port });
        fake.onExecute(() => ({ exitCode: 0, result: 'added 1 package in 1s\n' }));
        // The fake's runner: every `creating`/`stopping` sandbox and `pending` snapshot settles.
        ticker = setInterval(() => {
          for (const sandbox of fake.sandboxes.values()) {
            if (holdPool && sandbox.labels['forge.kind'] === 'pool') continue;
            fake.settle(sandbox.id);
          }
          for (const snapshot of fake.snapshots.values()) {
            const reason = failing.get(snapshot.name);
            if (reason !== undefined) fake.failSnapshot(snapshot.name, reason);
            else fake.settleSnapshot(snapshot.name);
          }
        }, 5);

        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(BREACHED_PASSWORD_PORT)
          .useClass(ScriptedBreachPort)
          .overrideProvider(SANDBOX_TIMINGS)
          .useValue(SANDBOX)
          .overrideProvider(TEMPLATES_DIR)
          .useValue(FIXTURES)
          .compile();

        app = moduleRef.createNestApplication();
        configureApplication(app);
        await app.init();

        db = app.get<ForgeDatabase>(APP_DATABASE);
        queue = app.get<Redis>(QUEUE_REDIS);
        catalogue = app.get(TemplateCatalogue, { strict: false });
        // The token override took: the fixtures, not `apps/api/templates`.
        expect(catalogue.get(TEMPLATE).manifest.name).toBe('Good nextjs');
        for (const template of PROJECT_TEMPLATES) {
          await dropFakeVersions(db, template);
          await queue.del(poolFrontKey(template));
        }
      }, LOCKED_BOOT_TIMEOUT_MS);

      beforeEach(() => {
        fake.requests.splice(0);
        failing.clear();
        log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      });

      afterAll(async () => {
        vi.restoreAllMocks();
        clearInterval(ticker);
        if (world) await destroyTwoTenantWorld(app, world);
        await db?.delete(schema.sandboxPool).where(eq(schema.sandboxPool.template, TEMPLATE));
        await db
          ?.delete(schema.sandboxPoolSettings)
          .where(eq(schema.sandboxPoolSettings.template, TEMPLATE));
        for (const template of PROJECT_TEMPLATES) {
          if (db) await dropFakeVersions(db, template);
          await queue?.del(poolFrontKey(template));
        }
        await app?.close();
        await fake?.close();
        await suiteLock?.release();
      });

      describe('US2 · publish', () => {
        /** SC-010, quickstart row US2 · SC-010. */
        it(
          'publish all builds four ready current versions and exits 0',
          async () => {
            // A stale front entry from before the publish: the flip clears it (research R5).
            await queue.rpush(poolFrontKey(TEMPLATE), 'stale-pool-id');

            expect(await publish('all')).toBe(0);

            expect(printed()).toEqual(
              PROJECT_TEMPLATES.map((t) => `${t} ${def(t).digest.slice(0, 12)} built`),
            );
            for (const template of PROJECT_TEMPLATES) {
              const rows = await versionRows(template);
              expect(rows).toHaveLength(1);
              expect(rows[0]).toMatchObject({
                current: true,
                digest: def(template).digest,
                failureReason: null,
                snapshot: def(template).snapshot,
                state: 'ready',
              });
              expect(rows[0]!.readyAt).not.toBeNull();
              expect(fake.snapshots.get(def(template).snapshot)?.state).toBe('active');
            }
            // One capture per template, from a sandbox created off the manifest's base with the
            // build labels; every build sandbox removed afterwards.
            expect(
              snapshotPosts().map((r) => (JSON.parse(r.body) as { name: string }).name),
            ).toEqual(PROJECT_TEMPLATES.map((t) => def(t).snapshot));
            const creates = fake.requests.filter(
              (r) => r.method === 'POST' && r.path === '/api/sandbox',
            );
            expect(
              creates.map(
                (r) => JSON.parse(r.body) as { labels: Record<string, string>; snapshot: string },
              ),
            ).toEqual(
              PROJECT_TEMPLATES.map((t) => ({
                autoArchiveInterval: 0,
                autoStopInterval: 0,
                labels: { 'forge.kind': 'build', 'forge.owner': 'forge-test', 'forge.template': t },
                snapshot: def(t).manifest.base,
              })),
            );
            expect(buildSandboxes()).toEqual([]);
            expect(await queue.llen(poolFrontKey(TEMPLATE))).toBe(0);
          },
          STEP_TIMEOUT_MS,
        );

        /** SC-003, quickstart row US1 sc.5 · SC-003. */
        it(
          'publishing an unchanged catalogue builds nothing',
          async () => {
            expect(await publish()).toBe(0);

            expect(printed()).toEqual(
              PROJECT_TEMPLATES.map((t) => `${t} ${def(t).digest.slice(0, 12)} already-current`),
            );
            expect(snapshotPosts()).toEqual([]);
            expect(fake.requests.filter((r) => r.method === 'POST')).toEqual([]);
            for (const template of PROJECT_TEMPLATES)
              expect(await versionRows(template)).toHaveLength(1);
          },
          STEP_TIMEOUT_MS,
        );

        /** SC-004, quickstart row US2 sc.2–3 · SC-004. */
        it(
          'a failed build is recorded with its reason and the current version is untouched',
          async () => {
            // The definition changed since the last publish: the catalogue's digest is new to the
            // table, and an older version is what the pool creates from today.
            const previous = `forge-tpl-${TEMPLATE}-previous0000`;
            await dropVersion(TEMPLATE, def(TEMPLATE).digest);
            fake.snapshots.delete(def(TEMPLATE).snapshot);
            await publishFakeVersion(db, TEMPLATE, previous);
            failing.set(def(TEMPLATE).snapshot, 'runner out of disk');

            expect(await publish('all')).toBe(1);

            expect(printed()).toEqual(
              PROJECT_TEMPLATES.map((t) =>
                t === TEMPLATE
                  ? `${t} ${def(t).digest.slice(0, 12)} failed runner out of disk`
                  : `${t} ${def(t).digest.slice(0, 12)} already-current`,
              ),
            );
            const rows = await versionRows(TEMPLATE);
            expect(rows.find((r) => r.digest === def(TEMPLATE).digest)).toMatchObject({
              current: false,
              failureReason: 'runner out of disk',
              state: 'failed',
            });
            expect(await currentOf(TEMPLATE)).toMatchObject({ snapshot: previous, state: 'ready' });
            expect(snapshotPosts()).toHaveLength(1);
            expect(buildSandboxes()).toEqual([]);

            await dropVersion(TEMPLATE, def(TEMPLATE).digest);
          },
          STEP_TIMEOUT_MS,
        );

        /** SC-003, quickstart row US2 sc.4 · SC-003. */
        it(
          'two publishes of one digest perform one build',
          async () => {
            fake.snapshots.delete(def(TEMPLATE).snapshot);
            expect(await Promise.all([publish(TEMPLATE), publish(TEMPLATE)])).toEqual([0, 0]);

            expect(
              printed()
                .map((line) => line.split(' ')[2])
                .sort(),
            ).toEqual(['building-elsewhere', 'built']);
            expect(snapshotPosts()).toHaveLength(1);
            const rows = await versionRows(TEMPLATE);
            expect(rows.filter((r) => r.digest === def(TEMPLATE).digest)).toHaveLength(1);
            expect(await currentOf(TEMPLATE)).toMatchObject({
              digest: def(TEMPLATE).digest,
              state: 'ready',
            });
            expect(buildSandboxes()).toEqual([]);
          },
          STEP_TIMEOUT_MS,
        );

        /** Edge "killed mid-build", quickstart row of the same name. */
        it(
          'a stale building row is taken over',
          async () => {
            await dropVersion(TEMPLATE, def(TEMPLATE).digest);
            fake.snapshots.delete(def(TEMPLATE).snapshot);
            const crashed = new Date(Date.now() - SANDBOX.buildTimeoutMs - 60_000);
            await db.insert(schema.templateVersions).values({
              createdAt: crashed,
              digest: def(TEMPLATE).digest,
              snapshot: def(TEMPLATE).snapshot,
              state: 'building',
              template: TEMPLATE,
              updatedAt: crashed,
            });

            expect(await publish(TEMPLATE)).toBe(0);

            expect(printed()).toEqual([`${TEMPLATE} ${def(TEMPLATE).digest.slice(0, 12)} built`]);
            expect(snapshotPosts()).toHaveLength(1);
            expect(await currentOf(TEMPLATE)).toMatchObject({
              digest: def(TEMPLATE).digest,
              state: 'ready',
            });
          },
          STEP_TIMEOUT_MS,
        );
      });

      describe('US2 · show', () => {
        /** FR-016: the operator's view tells the truth about the provider. */
        it(
          'show names a current snapshot the provider no longer has',
          async () => {
            fake.snapshots.delete(def(TEMPLATE).snapshot);

            expect(await show()).toBe(0);

            const lines = printed();
            expect(lines).toHaveLength(PROJECT_TEMPLATES.length);
            const [current] = await versionRows(TEMPLATE).then((rows) =>
              rows.filter((r) => r.current),
            );
            expect(lines.find((line) => line.startsWith(`${TEMPLATE} `))).toBe(
              `${TEMPLATE} ${def(TEMPLATE).digest.slice(0, 12)} ${current!.readyAt!.toISOString()} - - 0 ` +
                'unavailable: snapshot not found at the provider',
            );
            for (const template of PROJECT_TEMPLATES.filter((t) => t !== TEMPLATE)) {
              expect(lines.find((line) => line.startsWith(`${template} `))).not.toContain(
                'unavailable',
              );
            }
          },
          STEP_TIMEOUT_MS,
        );
      });

      describe('FR-019 · the key', () => {
        /** The pattern of `test/log-redaction.e2e-spec.ts`: what the process would have written. */
        it(
          'publish output and logs carry no provider key',
          async () => {
            const template = 'node-api' as const;
            await dropVersion(template, def(template).digest);
            fake.snapshots.delete(def(template).snapshot);
            const chunks: string[] = [];
            const stdout = vi
              .spyOn(process.stdout, 'write')
              .mockImplementation((chunk: Uint8Array | string): boolean => {
                chunks.push(
                  typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
                );
                return true;
              });
            const logged: string[] = [];
            const sink = (line: unknown) => logged.push(String(line));
            const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
              vi.spyOn(Logger.prototype, level).mockImplementation(sink),
            );

            try {
              expect(await publish(template)).toBe(0);
              await new Promise<void>((resolve) => setImmediate(resolve));
            } finally {
              stdout.mockRestore();
              for (const spy of spies) spy.mockRestore();
            }

            // The fake saw the key on every request — so a leak would be a real one.
            expect(fake.requests.length).toBeGreaterThan(0);
            for (const request of fake.requests) {
              expect(request.headers.authorization).toBe(`Bearer ${FAKE.apiKey}`);
            }
            const output = [...printed(), ...error.mock.calls.map(([l]) => String(l))].join('\n');
            expect(output).toContain(`${template} ${def(template).digest.slice(0, 12)} built`);
            for (const text of [output, chunks.join(''), logged.join('\n')]) {
              expect(text).not.toContain(FAKE.apiKey);
            }
          },
          STEP_TIMEOUT_MS,
        );
      });

      describe('US3 · listing', () => {
        const TEMPLATES = '/api/v1/templates';

        /** SC-007, quickstart row US3 · SC-007. */
        it(
          'lists the four templates with names, descriptions and readiness in order',
          async () => {
            const who = await signUpAndIn(app, 'catalogue');
            try {
              for (const template of PROJECT_TEMPLATES) {
                await publishFakeVersion(db, template, `forge-tpl-${template}-listed0000`);
              }
              await dropFakeVersions(db, 'python');

              const response = await http(app).get(TEMPLATES).set('Cookie', who.cookie).expect(200);

              // `strictObject` at both levels: an extra key is a parse failure.
              const body = templateCatalogueResponseSchema.parse(response.body);
              expect(body).toEqual({
                default: 'vite-react',
                templates: PROJECT_TEMPLATES.map((t) => ({
                  description: def(t).manifest.description,
                  id: t,
                  name: def(t).manifest.name,
                  ready: t !== 'python',
                })),
              });
              expect(body.templates[0]!.id).toBe('vite-react');
            } finally {
              await db.delete(schema.users).where(eq(schema.users.email, who.email));
            }
          },
          STEP_TIMEOUT_MS,
        );

        /** SC-007: the global `SessionGuard` applies, as on the `models` precedent. */
        it('refuses an anonymous listing', async () => {
          const response = await http(app)
            .get(TEMPLATES)
            .expect(401)
            .expect('Content-Type', /application\/problem\+json/);

          expect(problemDetailSchema.parse(response.body)).toMatchObject({
            status: 401,
            type: 'https://forge.dev/problems/unauthorized',
          });
        });
      });

      describe('US1 · rollover', () => {
        const A = `forge-tpl-${TEMPLATE}-rollover-a`;
        /** B is the catalogue's own digest: the real publisher flips it, so the front `DEL` is real. */
        const B = () => def(TEMPLATE).snapshot;
        let transactions: TenantTransactionRunner;
        let refill: PoolRefill;
        let claim: SandboxClaim;
        let versions: TemplateVersions;
        let tenant: TwoTenantWorld['alpha'];
        /** The project sandbox created from A before the publish, as SC-005 reads it back. */
        let before: { projectId: string; row: unknown };

        const poolRows = () =>
          db
            .select()
            .from(schema.sandboxPool)
            .where(eq(schema.sandboxPool.template, TEMPLATE))
            .orderBy(schema.sandboxPool.readyAt);
        const readyOn = async (snapshot: string) =>
          (await poolRows()).filter((r) => r.state === 'ready' && r.snapshot === snapshot);
        const creates = (kind: string) =>
          fake.requests.filter(
            (r) =>
              r.method === 'POST' &&
              r.path === '/api/sandbox' &&
              (JSON.parse(r.body) as { labels: Record<string, string> }).labels['forge.kind'] ===
                kind,
          );
        const releaseOps = async () => {
          const ids = (await poolRows()).map((r) => r.id);
          if (ids.length === 0) return [];
          return db
            .select({ id: schema.outbox.id })
            .from(schema.outbox)
            .where(
              and(
                eq(schema.outbox.type, 'sandbox.op.requested'),
                inArray(schema.outbox.aggregateId, ids),
                sql`${schema.outbox.payload}->>'op' = 'release'`,
              ),
            );
        };

        async function project(name: string): Promise<string> {
          const { orgId, owner, workspaceId } = tenant;
          const created = await transactions.runInTenantScope({ orgId, userId: owner.userId }, () =>
            app
              .get(ProjectService)
              .create({ actorId: owner.userId, name, orgId, ownerId: owner.userId, workspaceId }),
          );
          return created.id;
        }
        const claimFor = (projectId: string) =>
          transactions.runInTenantTransaction(tenant.orgId, (tx) =>
            claim.claim(tx, { orgId: tenant.orgId, projectId }, TEMPLATE, {
              leaseEpoch: 1,
              operationId: `run-${projectId}/step-0`,
            }),
          );
        const sandboxRow = (projectId: string) =>
          transactions.runInTenantTransaction(tenant.orgId, (tx) =>
            tx.query.sandboxes.findFirst({
              where: and(
                eq(schema.sandboxes.orgId, tenant.orgId),
                eq(schema.sandboxes.projectId, projectId),
              ),
            }),
          );

        beforeAll(async () => {
          transactions = app.get(TenantTransactionRunner);
          refill = app.get(PoolRefill, { strict: false });
          claim = app.get(SandboxClaim, { strict: false });
          versions = app.get(TemplateVersions, { strict: false });
          world = await createTwoTenantWorld(app);
          tenant = world.alpha;
          // Only this template refills: the others have no version, so the pass skips them.
          for (const template of PROJECT_TEMPLATES) {
            if (template !== TEMPLATE) await dropFakeVersions(db, template);
          }
          await db.delete(schema.sandboxPool).where(eq(schema.sandboxPool.template, TEMPLATE));
          await app.get(PoolSettingsService, { strict: false }).upsert(TEMPLATE, { depth: 4 });
        }, LOCKED_BOOT_TIMEOUT_MS);

        /** SC-001, SC-002, quickstart rows US1 sc.1–2. */
        it(
          'a version change fills the new version before draining the old and never empties the pool',
          async () => {
            await publishFakeVersion(db, TEMPLATE, A);
            await refill.refill();
            await until('4 ready on A', async () => (await readyOn(A)).length === 4);
            // A project claims from A before the publish (SC-005's fixture).
            const projectId = await project('On A');
            expect(await claimFor(projectId)).toEqual({ ready: true });
            before = { projectId, row: await sandboxRow(projectId) };
            expect(before.row).toMatchObject({ templateSnapshot: A });
            await refill.refill();
            await until('4 ready on A again', async () => (await readyOn(A)).length === 4);
            await until(
              'the front to hold A',
              async () => (await queue.llen(poolFrontKey(TEMPLATE))) > 0,
            );

            // The flip: the real publisher builds the catalogue's digest, makes it current, DELs
            // the front.
            await dropVersion(TEMPLATE, def(TEMPLATE).digest);
            fake.snapshots.delete(B());
            expect(await publish(TEMPLATE)).toBe(0);
            expect(printed()).toEqual([`${TEMPLATE} ${def(TEMPLATE).digest.slice(0, 12)} built`]);
            expect(await currentOf(TEMPLATE)).toMatchObject({ snapshot: B() });
            expect(await queue.llen(poolFrontKey(TEMPLATE))).toBe(0);

            // Pass 1: fill on B, drain nothing.
            fake.requests.splice(0);
            holdPool = true;
            await refill.refill();
            expect(creates('pool')).toHaveLength(4);
            for (const r of creates('pool')) {
              expect((JSON.parse(r.body) as { snapshot: string }).snapshot).toBe(B());
            }
            expect(await releaseOps()).toEqual([]);
            const rows = await poolRows();
            expect(rows.filter((r) => r.snapshot === A).map((r) => r.state)).toEqual(
              Array(4).fill('ready'),
            );
            expect(rows.filter((r) => r.snapshot === B()).map((r) => r.state)).toEqual(
              Array(4).fill('creating'),
            );

            // Between passes, B still creating and the front wiped: a ready row, never a cold create.
            const between = await project('Between passes');
            expect(await claimFor(between)).toEqual({ ready: true });
            expect(await sandboxRow(between)).toMatchObject({ templateSnapshot: A });
            expect(creates('project')).toEqual([]);
            expect(await readyOn(A)).toHaveLength(3);

            holdPool = false;
            await until('4 ready on B', async () => (await readyOn(B())).length === 4);

            // Pass 2: B meets the target, so every A row goes; B is untouched.
            await refill.refill();
            const after = await poolRows();
            expect(after.filter((r) => r.snapshot === A).map((r) => r.state)).toEqual(
              Array(3).fill('releasing'),
            );
            expect(after.filter((r) => r.snapshot === B()).map((r) => r.state)).toEqual(
              Array(4).fill('ready'),
            );
            expect(await releaseOps()).toHaveLength(3);
            await until('the A releases to land', async () => (await poolRows()).length === 4);
            expect((await poolRows()).every((r) => r.snapshot === B() && r.state === 'ready')).toBe(
              true,
            );
            expect((await queue.lrange(poolFrontKey(TEMPLATE), 0, -1)).sort()).toEqual(
              (await poolRows()).map((r) => r.id).sort(),
            );
          },
          STEP_TIMEOUT_MS * 3,
        );

        /** SC-005, quickstart row US1 sc.3. */
        it(
          "a project's sandbox created from the old version is untouched and records its version",
          async () => {
            expect(await sandboxRow(before.projectId)).toEqual(before.row);
            expect(before.row).toMatchObject({ templateSnapshot: A });

            const fresh = await project('On B');
            expect(await claimFor(fresh)).toEqual({ ready: true });
            expect(await sandboxRow(fresh)).toMatchObject({ templateSnapshot: B() });
            expect(creates('project')).toEqual([]);
          },
          STEP_TIMEOUT_MS,
        );

        /** The partial unique index `template_versions_current_idx`, two overlapping transactions. */
        it(
          'two concurrent flips cannot both win',
          async () => {
            const C = `forge-tpl-${TEMPLATE}-rollover-c`;
            const D = `forge-tpl-${TEMPLATE}-rollover-d`;
            await publishFakeVersion(db, TEMPLATE, C, { current: false });
            await publishFakeVersion(db, TEMPLATE, D, { current: false });
            const tv = schema.templateVersions;
            // `flip` as `TemplateVersions` runs it — clear the template's current, set this row —
            // with a pause between so the second transaction overlaps the first. The second is
            // started only once the first has cleared the row: under load, two transactions started
            // together can reach the pool in either order, and the wrong one then wins the flip.
            const flip = (snapshot: string, pauseMs: number, cleared?: () => void) =>
              db.transaction(async (tx) => {
                await tx
                  .update(tv)
                  .set({ current: false })
                  .where(and(eq(tv.template, TEMPLATE), eq(tv.current, true)));
                cleared?.();
                await new Promise((resolve) => setTimeout(resolve, pauseMs));
                await tx
                  .update(tv)
                  .set({ current: true })
                  .where(and(eq(tv.template, TEMPLATE), eq(tv.snapshot, snapshot)));
              });

            let firstCleared!: () => void;
            const cleared = new Promise<void>((resolve) => (firstCleared = resolve));
            const firstFlip = flip(C, 300, firstCleared);
            await cleared;
            const [first, second] = await Promise.allSettled([firstFlip, flip(D, 0)]);

            expect(first, String((first as PromiseRejectedResult).reason)).toMatchObject({
              status: 'fulfilled',
            });
            expect(second.status).toBe('rejected');
            expect((second as PromiseRejectedResult).reason).toMatchObject({
              cause: { code: '23505', constraint: 'template_versions_current_idx' },
            });
            const current = (await versionRows(TEMPLATE)).filter((r) => r.current);
            expect(current.map((r) => r.snapshot)).toEqual([C]);
            expect(await versions.current(TEMPLATE)).toMatchObject({ snapshot: C });

            // Back to B for the rows that follow.
            await db.transaction(async (tx) => {
              await tx.update(tv).set({ current: false }).where(eq(tv.template, TEMPLATE));
              await tx
                .update(tv)
                .set({ current: true })
                .where(and(eq(tv.template, TEMPLATE), eq(tv.snapshot, B())));
            });
            await db.delete(tv).where(and(eq(tv.template, TEMPLATE), inArray(tv.snapshot, [C, D])));
          },
          STEP_TIMEOUT_MS,
        );

        /** Edge "deleted by hand", quickstart row of the same name. */
        it(
          'a missing current image fails the create loudly and never falls back',
          async () => {
            // `strictSnapshots` is a boot option of the fake: the same port, a strict one.
            await fake.close();
            fake = await startFakeDaytona({
              apiKey: FAKE.apiKey,
              port: FAKE.port,
              strictSnapshots: true,
            });
            fake.onExecute(() => ({ exitCode: 0, result: 'added 1 package in 1s\n' }));
            fake.snapshots.delete(B());
            expect(await currentOf(TEMPLATE)).toMatchObject({ snapshot: B() });
            await app.get(PoolSettingsService, { strict: false }).upsert(TEMPLATE, { depth: 6 });
            const held = await poolRows();

            // The create is refused with the provider's answer: the pass ends there, no row is
            // written for a sandbox that does not exist, and nothing is created from A instead.
            await expect(refill.refill()).rejects.toMatchObject({
              kind: 'upstream',
              name: 'DaytonaError',
              retryable: true,
              status: 400,
            });
            expect(creates('pool')).toHaveLength(1);
            expect((JSON.parse(creates('pool')[0]!.body) as { snapshot: string }).snapshot).toBe(
              B(),
            );
            expect(await poolRows()).toEqual(held);
            expect(await currentOf(TEMPLATE)).toMatchObject({ snapshot: B(), state: 'ready' });

            log.mockClear();
            expect(await show()).toBe(0);
            expect(printed().find((line) => line.startsWith(`${TEMPLATE} `))).toContain(
              'unavailable: snapshot not found at the provider',
            );
          },
          STEP_TIMEOUT_MS,
        );

        /** Edge "fresh install", quickstart row of the same name. */
        it(
          'with no published version a claim fails no-sandbox and the refill records the reason',
          async () => {
            await dropFakeVersions(db, TEMPLATE);
            await db.delete(schema.sandboxPool).where(eq(schema.sandboxPool.template, TEMPLATE));
            await queue.del(poolFrontKey(TEMPLATE));
            const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

            const projectId = await project('Fresh install');
            await expect(claimFor(projectId)).rejects.toMatchObject({
              kind: 'no-sandbox',
              message: 'The pool is empty and the template has no published version.',
            });
            expect(await sandboxRow(projectId)).toBeUndefined();
            expect(creates('project')).toEqual([]);

            await refill.refill();
            expect(
              warn.mock.calls.filter(([line]) =>
                String(line).startsWith(`pool ${TEMPLATE}: no current version (target 6)`),
              ),
            ).toHaveLength(1);
            expect(await poolRows()).toEqual([]);
            expect(creates('pool')).toEqual([]);
          },
          STEP_TIMEOUT_MS,
        );
      });

      describe('US4 · retirement', () => {
        /** A is the catalogue's own version, published for real: the revert republishes its digest. */
        const A = () => def(TEMPLATE).snapshot;
        const B = `forge-tpl-${TEMPLATE}-retire-b`;
        const active = (name: string) =>
          fake.snapshots.set(name, { errorReason: null, name, state: 'active' });
        let transactions: TenantTransactionRunner;
        let refill: PoolRefill;
        let lifecycle: SandboxLifecycle;
        let tenant: TwoTenantWorld['alpha'];
        /** The project sandbox claimed from A before B superseded it. */
        let onA: { daytonaId: string; projectId: string };

        const poolRows = () =>
          db.select().from(schema.sandboxPool).where(eq(schema.sandboxPool.template, TEMPLATE));
        const readyOn = async (snapshot: string) =>
          (await poolRows()).filter((r) => r.state === 'ready' && r.snapshot === snapshot);
        const rowOf = async (snapshot: string) =>
          (await versionRows(TEMPLATE)).find((r) => r.snapshot === snapshot);
        const snapshotDeletes = () =>
          fake.requests.filter(
            (r) => r.method === 'DELETE' && r.path.startsWith('/api/snapshots/'),
          );
        const sandboxRow = (projectId: string) =>
          transactions.runInTenantTransaction(tenant.orgId, (tx) =>
            tx.query.sandboxes.findFirst({
              where: and(
                eq(schema.sandboxes.orgId, tenant.orgId),
                eq(schema.sandboxes.projectId, projectId),
              ),
            }),
          );

        beforeAll(async () => {
          transactions = app.get(TenantTransactionRunner);
          refill = app.get(PoolRefill, { strict: false });
          lifecycle = app.get<SandboxLifecycle>(SANDBOX_LIFECYCLE, { strict: false });
          world ??= await createTwoTenantWorld(app);
          tenant = world.alpha;
          // The fake is the strict one from US1: the base image the publisher builds from must exist.
          active(def(TEMPLATE).manifest.base);
          await app.get(PoolSettingsService, { strict: false }).upsert(TEMPLATE, { depth: 2 });
        }, LOCKED_BOOT_TIMEOUT_MS);

        /** SC-006, quickstart row US4 · SC-006; sc.2 on the way (a `releasing` row still counts). */
        it(
          'a superseded version is retired and its image removed once nothing references it',
          async () => {
            expect(await publish(TEMPLATE)).toBe(0);
            await refill.refill();
            await until('2 ready on A', async () => (await readyOn(A())).length === 2);
            const { orgId, owner, workspaceId } = tenant;
            const project = await transactions.runInTenantScope(
              { orgId, userId: owner.userId },
              () =>
                app.get(ProjectService).create({
                  actorId: owner.userId,
                  name: 'Retired later',
                  orgId,
                  ownerId: owner.userId,
                  template: TEMPLATE,
                  workspaceId,
                }),
            );
            const ctx = { leaseEpoch: 1, operationId: `run-${project.id}/step-0` as const };
            expect(
              await transactions.runInTenantTransaction(orgId, (tx) =>
                lifecycle.ensureReady(tx, { orgId, projectId: project.id }, ctx),
              ),
            ).toEqual({ ready: true });
            const row = (await sandboxRow(project.id))!;
            expect(row).toMatchObject({ state: 'active', templateSnapshot: A() });
            onA = { daytonaId: row.daytonaId, projectId: project.id };

            // B supersedes A; the pool fills on B, then drains A.
            active(B);
            await publishFakeVersion(db, TEMPLATE, B);
            fake.requests.splice(0);
            await refill.refill();
            await until('2 ready on B', async () => (await readyOn(B)).length === 2);
            await refill.refill();
            // The A row released this pass is still a reference: no retirement yet (sc.2).
            expect(
              (await poolRows()).filter((r) => r.snapshot === A()).map((r) => r.state),
            ).toEqual(['releasing']);
            expect(await rowOf(A())).toMatchObject({
              current: false,
              retiredAt: null,
              state: 'ready',
            });
            expect(snapshotDeletes()).toEqual([]);
            await until('the A release to land', async () =>
              (await poolRows()).every((r) => r.snapshot === B),
            );

            await refill.refill();

            expect(await rowOf(A())).toMatchObject({ current: false, state: 'retired' });
            expect((await rowOf(A()))!.retiredAt).toBeInstanceOf(Date);
            expect(snapshotDeletes().map((r) => r.path)).toEqual([
              `/api/snapshots/${encodeURIComponent(A())}`,
            ]);
            expect(fake.snapshots.has(A())).toBe(false);

            // A second pass has nothing to reclaim; B is current, ready and still at the provider.
            await refill.refill();
            expect(snapshotDeletes()).toHaveLength(1);
            expect(await rowOf(B)).toMatchObject({
              current: true,
              retiredAt: null,
              state: 'ready',
            });
            expect(fake.snapshots.get(B)?.state).toBe('active');
            expect((await poolRows()).map((r) => r.state)).toEqual(['ready', 'ready']);
          },
          STEP_TIMEOUT_MS * 3,
        );

        /** US4 sc.4: the sandbox is its own filesystem; resuming never needs the snapshot. */
        it(
          'a hibernated sandbox created from a retired version still resumes',
          async () => {
            const { daytonaId, projectId } = onA;
            const hibernatedAt = new Date(Date.now() - 60_000);
            fake.sandboxes.get(daytonaId)!.state = 'stopped';
            await transactions.runInTenantTransaction(tenant.orgId, (tx) =>
              tx
                .update(schema.sandboxes)
                .set({ hibernatedAt, state: 'hibernated', stateEnteredAt: hibernatedAt })
                .where(eq(schema.sandboxes.projectId, projectId)),
            );
            expect(await rowOf(A())).toMatchObject({ state: 'retired' });
            fake.requests.splice(0);

            // What a run does before its first tool call.
            const ref = { orgId: tenant.orgId, projectId };
            expect(
              await transactions.runInTenantTransaction(tenant.orgId, (tx) =>
                lifecycle.ensureReady(tx, ref, {
                  leaseEpoch: 2,
                  operationId: `run-${projectId}/step-1`,
                }),
              ),
            ).toEqual({ because: 'resuming', ready: false });
            await until(
              'the resume to land',
              async () => (await sandboxRow(projectId))?.state === 'active',
            );

            expect(await sandboxRow(projectId)).toMatchObject({
              daytonaId,
              hibernatedAt: null,
              templateSnapshot: A(),
              transition: null,
            });
            expect(fake.sandboxes.get(daytonaId)!.state).toBe('started');
            expect(fake.requests.filter((r) => r.path.endsWith('/start'))).toHaveLength(1);
            expect(fake.requests.filter((r) => r.path.includes('/snapshots/'))).toEqual([]);
            expect(
              fake.requests.filter((r) => r.method === 'POST' && r.path === '/api/sandbox'),
            ).toEqual([]);
          },
          STEP_TIMEOUT_MS,
        );

        /** Edge "revert", quickstart row of the same name: the retired row is taken over, not duplicated. */
        it(
          'republishing a retired digest rebuilds it under the same version',
          async () => {
            const retired = (await rowOf(A()))!;
            expect(retired).toMatchObject({ digest: def(TEMPLATE).digest, state: 'retired' });
            expect(fake.snapshots.has(A())).toBe(false);
            fake.requests.splice(0);

            expect(await publish(TEMPLATE)).toBe(0);

            expect(printed()).toEqual([`${TEMPLATE} ${def(TEMPLATE).digest.slice(0, 12)} built`]);
            expect(snapshotPosts()).toHaveLength(1);
            expect(fake.snapshots.get(A())?.state).toBe('active');
            const rows = await versionRows(TEMPLATE);
            expect(rows.filter((r) => r.digest === def(TEMPLATE).digest)).toHaveLength(1);
            const rebuilt = (await rowOf(A()))!;
            expect(rebuilt).toMatchObject({ current: true, failureReason: null, state: 'ready' });
            expect(rebuilt.readyAt!.getTime()).toBeGreaterThan(retired.readyAt!.getTime());
            expect(await rowOf(B)).toMatchObject({ current: false, state: 'ready' });
            expect(await currentOf(TEMPLATE)).toMatchObject({ snapshot: A() });
            expect(buildSandboxes()).toEqual([]);
          },
          STEP_TIMEOUT_MS,
        );
      });
    },
  );
});
