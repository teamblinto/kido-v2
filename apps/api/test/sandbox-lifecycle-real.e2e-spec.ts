import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type RunResponse, runResponseSchema } from '@repo/contracts';
import { schema } from '@repo/db';
import { and, asc, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import './support/developer-dotenv';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { QUEUE_REDIS } from '../src/common/redis/redis.constants';
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
import { OutboxWriter } from '../src/modules/outbox/outbox-writer';
import { DaytonaAdapter } from '../src/modules/sandbox/daytona.adapter';
import { PoolRefill } from '../src/modules/sandbox/pool-refill';
import { PoolSettingsService } from '../src/modules/sandbox/pool-settings';
import {
  DEFAULT_SANDBOX_TIMINGS,
  poolFrontKey,
  SANDBOX_TIMINGS,
  type SandboxTimings,
} from '../src/modules/sandbox/sandbox.constants';
import { DaytonaError } from '../src/modules/sandbox/sandbox.errors';
import { SandboxService } from '../src/modules/sandbox/sandbox.service';
import { SandboxReconciler } from '../src/modules/sandbox/sandbox-reconciler';
import { SandboxSweep } from '../src/modules/sandbox/sandbox-sweep';
import { TemplateCatalogue } from '../src/modules/sandbox/template-catalogue';
import { TemplatePublisher } from '../src/modules/sandbox/template-publisher';
import { unsafe } from './support/csrf-client';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import { ScriptedProvider } from './support/scripted-provider';
import { dropFakeVersions } from './support/template-versions';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  http,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

/** Every sandbox this walk creates carries this owner, so it never touches another's (R2). */
const OWNER = `forge-014-walk-${String(process.pid)}`;

/**
 * Before any import, as `sandbox-lifecycle.e2e-spec.ts`. `DAYTONA_API_URL` / `DAYTONA_API_KEY`
 * are *not* set here: `developer-dotenv` above fills them from `apps/api/.env` (what is already
 * set wins, which is why the owner and the model key are pinned first).
 */
vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  process.env.RUN_PROFILES = 'api,agent,events';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.THROTTLE_LIMIT = '100000';
  process.env.SANDBOX_OWNER = `forge-014-walk-${String(process.pid)}`;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-fake-sandbox-lifecycle-real-e2e';
});

const configured = Boolean(process.env.DAYTONA_API_URL && process.env.DAYTONA_API_KEY);

// Same banner as `sandbox-real.e2e-spec.ts`: not the `SKIPPING` word CI greps for.
if (!configured) {
  process.stderr.write(
    'DAYTONA-SKIP "sandbox-lifecycle-real": DAYTONA_API_URL / DAYTONA_API_KEY not set\n',
  );
}

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const ORGS = '/api/v1/orgs';
const LOCKED_BOOT_TIMEOUT_MS = 600_000;
/** A real create can take ~13 s cold (research R1); the whole walk is a handful of those. */
const WALK_TIMEOUT_MS = 300_000;
const TEMPLATE = 'vite-react' as const;
/** The real build (`npm ci` in the sandbox) plus the walk: minutes, not seconds (spec 015 T030). */
const PUBLISH_TIMEOUT_MS = 900_000;
const MINUTE = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);
/** Real clocks, tighter polls so the recorded timings are the provider's, not the poll's. */
const SANDBOX: SandboxTimings = {
  ...DEFAULT_SANDBOX_TIMINGS,
  readyPollMs: 250,
  runWaitPollMs: 250,
};
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

async function until(what: string, predicate: () => Promise<boolean>, ms = 120_000) {
  const deadline = Date.now() + ms;

  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Spec 014 quickstart § Real Daytona: one walk of the lifecycle against the self-hosted stack
 * (infra/daytona), nothing faked but the model. Records the timings SC-001 / SC-005 ask for and
 * leaves the fleet as it was found — 010's unlabelled `forge-local` included.
 */
describe('Sandbox lifecycle against a real Daytona (e2e)', () => {
  describe.skipIf(!configured || !postgres || !redis)(
    'against the self-hosted stack, Postgres and the queue Redis',
    () => {
      let app: INestApplication;
      let world: TwoTenantWorld;
      let db: ForgeDatabase;
      let queue: Redis;
      let transactions: TenantTransactionRunner;
      let daytona: DaytonaAdapter;
      /** `forge-tpl-vite-react-<12>`: the catalogue's name for the committed definition (spec 015). */
      let snapshot: string;
      let suiteLock: { release: () => Promise<void> } | undefined;
      const provider = new ScriptedProvider();
      const timings: Record<string, number> = {};

      /** One line per timing, for T047's matrix; `stderr` as the banner, the app owns `console`. */
      const record = (what: string, ms: number) => {
        timings[what] = ms;
        process.stderr.write(`${what}: ${String(ms)} ms\n`);
      };

      const runsPath = () => `${ORGS}/${world.alpha.orgId}/projects/${world.alpha.projectId}/runs`;

      async function createRun(prompt: string): Promise<RunResponse> {
        const response = await unsafe(http(app).post(runsPath()), [world.alpha.owner.cookie])
          .send({ prompt })
          .expect(201);

        return runResponseSchema.parse(response.body);
      }

      async function runStatus(runId: string): Promise<RunResponse['status']> {
        const response = await http(app)
          .get(`${runsPath()}/${runId}`)
          .set('Cookie', world.alpha.owner.cookie)
          .expect(200);

        return runResponseSchema.parse(response.body).status;
      }

      async function events(runId: string) {
        return transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx
            .select({ data: schema.runEvents.data, type: schema.runEvents.type })
            .from(schema.runEvents)
            .where(eq(schema.runEvents.runId, runId))
            .orderBy(asc(schema.runEvents.seq)),
        );
      }

      const sandboxRow = () =>
        transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx.query.sandboxes.findFirst({
            where: and(
              eq(schema.sandboxes.orgId, world.alpha.orgId),
              eq(schema.sandboxes.projectId, world.alpha.projectId),
            ),
          }),
        );

      const poolRows = () =>
        db.select().from(schema.sandboxPool).where(eq(schema.sandboxPool.snapshot, snapshot));

      const inAlpha = <T>(work: () => Promise<T>) =>
        transactions.runInTenantScope({ orgId: world.alpha.orgId, userId: null }, work);

      /** A run created, driven to its first tool call and to `succeeded`; answers the wall time to the tool. */
      async function runToFirstTool(prompt: string): Promise<number> {
        const started = Date.now();
        const created = await createRun(prompt);
        await until('the first tool call', async () =>
          (await events(created.id)).some((e) => e.type === 'tool.start'),
        );
        const toFirstTool = Date.now() - started;
        await until(`run ${created.id} to succeed`, async () => {
          const status = await runStatus(created.id);
          if (status === 'failed') throw new Error(`run ${created.id} failed`);
          return status === 'succeeded';
        });
        expect((await events(created.id)).filter((e) => e.type === 'tool.end')).toMatchObject([
          { data: { ok: true } },
        ]);

        return toFirstTool;
      }

      const gone = async (daytonaId: string) => {
        try {
          await daytona.describe(daytonaId);
          return false;
        } catch (error) {
          if (error instanceof DaytonaError && error.kind === 'sandbox-not-found') return true;
          throw error;
        }
      };

      beforeAll(async () => {
        suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
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
        daytona = app.get(DaytonaAdapter, { strict: false });
        await queue.del(poolFrontKey(TEMPLATE));
        snapshot = app.get(TemplateCatalogue, { strict: false }).get(TEMPLATE).snapshot;

        // Spec 015 § Real Daytona: the version is published for real — create, upload, `npm ci`,
        // stop, capture — and the snapshot stays on the provider afterwards (it is a real version
        // of the committed definition; a rerun adopts it, FR-009, and records `adopted`).
        const since = Date.now();
        const outcome = await app.get(TemplatePublisher, { strict: false }).publish(TEMPLATE);
        record(`publish (${outcome.kind})`, Date.now() - since);
        expect(['built', 'adopted']).toContain(outcome.kind);
        expect((await daytona.describeSnapshot(snapshot))?.state).toBe('active');
        // `remove` answers while the sandbox is still `destroying` (research R1: the 404 follows).
        await until(
          'the build sandbox to be gone',
          async () =>
            (await daytona.listByLabels({ 'forge.kind': 'build', 'forge.owner': OWNER })).length ===
            0,
        );
        expect(
          await db.query.templateVersions.findFirst({
            where: and(
              eq(schema.templateVersions.template, TEMPLATE),
              eq(schema.templateVersions.snapshot, snapshot),
            ),
          }),
        ).toMatchObject({ current: true, state: 'ready' });
        world = await createTwoTenantWorld(app);
      }, PUBLISH_TIMEOUT_MS);

      afterAll(async () => {
        // Best effort: nothing labelled with this walk's owner outlives it.
        for (const dto of (await daytona?.listByLabels({ 'forge.owner': OWNER })) ?? []) {
          await daytona.remove(dto.id).catch(() => undefined);
        }
        if (world) await destroyTwoTenantWorld(app, world);
        if (db && snapshot) {
          await db.delete(schema.sandboxPool).where(eq(schema.sandboxPool.snapshot, snapshot));
        }
        await db
          ?.delete(schema.sandboxPoolSettings)
          .where(eq(schema.sandboxPoolSettings.template, TEMPLATE));
        if (db) await dropFakeVersions(db, TEMPLATE);
        await queue?.del(poolFrontKey(TEMPLATE));
        await app?.close();
        await suiteLock?.release();
      }, LOCKED_BOOT_TIMEOUT_MS);

      it(
        'pools, claims, hibernates, resumes with the file intact, reconciles past forge-local and releases',
        async () => {
          const settings = app.get(PoolSettingsService, { strict: false });
          const refill = app.get(PoolRefill, { strict: false });
          const sweep = app.get(SandboxSweep, { strict: false });
          const reconciler = app.get(SandboxReconciler, { strict: false });
          const port = app.get(SandboxService, { strict: false });
          const outbox = app.get(OutboxWriter, { strict: false });
          const ref = { orgId: world.alpha.orgId, projectId: world.alpha.projectId };

          // The dial, then the refill: one real create, settled `ready` by the ops consumer.
          await settings.upsert(TEMPLATE, { depth: 1 });
          let since = Date.now();
          await refill.refill();
          await until('the pool row to be ready', async () =>
            (await poolRows()).some((r) => r.state === 'ready'),
          );
          record('create→ready', Date.now() - since);
          const [pooled] = await poolRows();
          expect(await queue.lrange(poolFrontKey(TEMPLATE), 0, -1)).toEqual([pooled!.id]);
          expect((await daytona.describe(pooled!.daytonaId)).labels).toEqual({
            'forge.kind': 'pool',
            'forge.owner': OWNER,
            'forge.template': TEMPLATE,
          });

          // SC-001: a run claims it and reaches its first tool call, no operator.
          provider.script(
            { toolCalls: [{ id: 'call-1', input: { path: '.' }, name: 'fs_list' }] },
            { text: 'Listed.' },
          );
          record('claim→first tool call', await runToFirstTool('List the workspace'));
          const row = (await sandboxRow())!;
          expect(row).toMatchObject({ daytonaId: pooled!.daytonaId, state: 'active' });
          expect(await poolRows()).toEqual([]);
          await until(
            'the project label',
            async () =>
              (await daytona.describe(row.daytonaId)).labels?.['forge.project'] === ref.projectId,
          );
          // SC-002: the claimed sandbox carries the captured install — no `npm ci` ran at claim.
          expect(
            await daytona.execute(row.daytonaId, {
              command: 'test -f node_modules/.package-lock.json',
              cwd: row.workspaceRoot!,
              timeoutSeconds: 10,
            }),
          ).toMatchObject({ exitCode: 0 });

          // A file through the port, then hibernate through the sweep and the real `stop`.
          const content = `written before hibernation by ${OWNER}\n`;
          await inAlpha(() =>
            port.edit(ref, { content, path: 'note.txt' }, { leaseEpoch: 1, operationId: 'walk/1' }),
          );
          await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
            tx
              .update(schema.sandboxes)
              .set({ state: 'idle', stateEnteredAt: ago(61 * MINUTE) })
              .where(eq(schema.sandboxes.id, row.id)),
          );
          since = Date.now();
          expect(await sweep.sweep()).toMatchObject({ hibernating: 1 });
          await until(
            'the row to be hibernated',
            async () => (await sandboxRow())?.state === 'hibernated',
          );
          record('stop→stopped', Date.now() - since);
          expect((await daytona.describe(row.daytonaId)).state).toBe('stopped');

          // SC-005: a run resumes it within 10 s and the file is intact.
          provider.script(
            { toolCalls: [{ id: 'call-2', input: { path: 'note.txt' }, name: 'fs_read' }] },
            { text: 'Read it back.' },
          );
          record('start→first tool call', await runToFirstTool('Read the note'));
          expect(timings['start→first tool call']).toBeLessThan(10_000);
          expect(await sandboxRow()).toMatchObject({ hibernatedAt: null, state: 'active' });
          expect((await daytona.describe(row.daytonaId)).state).toBe('started');
          expect(await inAlpha(() => port.read(ref, 'note.txt'))).toBe(content);

          // The reconcile counts 010's unlabelled `forge-local` and leaves it be.
          const before = (await daytona.listByLabels({})).filter(
            (dto) => dto.labels?.['forge.owner'] !== OWNER,
          );
          expect(before.length).toBeGreaterThanOrEqual(1);
          const report = await reconciler.reconcile();
          expect(report.foreign).toBeGreaterThanOrEqual(before.length);
          expect(report).toMatchObject({ lost: 0, orphaned: 0 });
          const after = await daytona.listByLabels({});
          for (const dto of before) expect(after.map((d) => d.id)).toContain(dto.id);
          expect(await sandboxRow()).toMatchObject({ lostAt: null, state: 'active' });

          // Release: the dial to 0 (surplus ready rows go), the project row through `release`.
          await settings.upsert(TEMPLATE, { depth: 0 });
          await refill.refill();
          await transactions.runInTenantTransaction(world.alpha.orgId, async (tx) => {
            await tx
              .update(schema.sandboxes)
              .set({ transition: 'releasing', transitionSince: new Date() })
              .where(eq(schema.sandboxes.id, row.id));
            await outbox.append(tx, {
              aggregateId: row.id,
              orgId: ref.orgId,
              payload: { op: 'release', orgId: ref.orgId, sandboxId: row.id },
              type: 'sandbox.op.requested',
            });
          });
          since = Date.now();
          await until('the row to be released', async () => (await sandboxRow()) === undefined);
          await until('Daytona to answer 404', () => gone(row.daytonaId));
          record('release→404', Date.now() - since);
          expect(await poolRows()).toEqual([]);
          expect(await daytona.listByLabels({ 'forge.owner': OWNER })).toEqual([]);
        },
        WALK_TIMEOUT_MS,
      );
    },
  );
});
