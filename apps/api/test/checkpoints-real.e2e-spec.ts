import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  type Checkpoint,
  checkpointDiffResponseSchema,
  checkpointListResponseSchema,
  problemDetailSchema,
  type RunResponse,
  runResponseSchema,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { asc, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
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
import { DaytonaAdapter } from '../src/modules/sandbox/daytona.adapter';
import {
  DEFAULT_SANDBOX_TIMINGS,
  poolFrontKey,
  SANDBOX_TIMINGS,
  type SandboxTimings,
} from '../src/modules/sandbox/sandbox.constants';
import { SandboxService } from '../src/modules/sandbox/sandbox.service';
import { TemplatePublisher } from '../src/modules/sandbox/template-publisher';
import { run as repoVerify } from '../src/scripts/repo-verify';
import { unsafe } from './support/csrf-client';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import { seedProviderKey } from './support/seed-provider-key';
import { ScriptedProvider } from './support/scripted-provider';
import { dropFakeVersions } from './support/template-versions';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  http,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

/** Every sandbox this walk creates carries this owner, so it never touches another's. */
const OWNER = `forge-016-walk-${String(process.pid)}`;

/**
 * Before any import, as `sandbox-lifecycle-real.e2e-spec.ts`: `DAYTONA_*` and `OBJECT_STORE_*`
 * are *not* set here — `developer-dotenv` above fills them from `apps/api/.env` (what is already
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
  process.env.SANDBOX_OWNER = `forge-016-walk-${String(process.pid)}`;
});

const configured = Boolean(process.env.DAYTONA_API_URL && process.env.DAYTONA_API_KEY);
/** Quickstart § 3 applies only with a real store; without it the mirror is a `warn` and skipped. */
const mirrorConfigured = Boolean(
  process.env.OBJECT_STORE_ENDPOINT &&
  process.env.OBJECT_STORE_ACCESS_KEY_ID &&
  process.env.OBJECT_STORE_SECRET_ACCESS_KEY &&
  process.env.OBJECT_STORE_BUCKET_REPOS,
);

// Same banner as `sandbox-real.e2e-spec.ts`: not the `SKIPPING` word CI greps for.
if (!configured) {
  process.stderr.write(
    'DAYTONA-SKIP "checkpoints-real": DAYTONA_API_URL / DAYTONA_API_KEY not set\n',
  );
}

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const ORGS = '/api/v1/orgs';
const LOCKED_BOOT_TIMEOUT_MS = 600_000;
/** A cold create (~13 s), three runs and two reverts over a real daemon: minutes at most. */
const WALK_TIMEOUT_MS = 300_000;
/** The real build (`npm ci` in the sandbox) on first publish; a rerun adopts in seconds. */
const PUBLISH_TIMEOUT_MS = 900_000;
/** Quickstart § 3 step 1: within 60 s. */
const MIRROR_TIMEOUT_MS = 60_000;
/** The executor waits `runWaitMs` (180 s) on a cold create before it turns; the poll outlives it. */
const RUN_TIMEOUT_MS = 200_000;
const TEMPLATE = 'vite-react' as const;
const APP_TSX = 'src/App.tsx';
const SCAFFOLD_APP = 'export function App() {\n  return <h1>Hello from Vite + React</h1>;\n}\n';
const EDITED_APP = `export function App() {\n  return <h1>Edited by ${OWNER}</h1>;\n}\n`;
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
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Spec 016 quickstart § 2–3 against the self-hosted Daytona (infra/daytona): a sandbox from the
 * published `vite-react` version, real git in the sandbox, real turns through the real port —
 * only the model is scripted. The mirror and `repo:verify` run when `OBJECT_STORE_*` is set.
 * Records the run ids and the revert's wall time (SC-002) on stderr.
 */
describe('Checkpoints against a real Daytona (e2e)', () => {
  describe.skipIf(!configured || !postgres || !redis)(
    'against the self-hosted stack, Postgres and the queue Redis',
    () => {
      let app: INestApplication;
      let world: TwoTenantWorld;
      let db: ForgeDatabase;
      let queue: Redis;
      let transactions: TenantTransactionRunner;
      let daytona: DaytonaAdapter;
      let port: SandboxService;
      let suiteLock: { release: () => Promise<void> } | undefined;
      const provider = new ScriptedProvider();

      const note = (line: string) => process.stderr.write(`checkpoints-real ${line}\n`);
      const cookie = () => world.alpha.owner.cookie;
      const base = () => `${ORGS}/${world.alpha.orgId}/projects/${world.alpha.projectId}`;
      const inAlpha = <T>(work: () => Promise<T>) =>
        transactions.runInTenantScope({ orgId: world.alpha.orgId, userId: null }, work);
      const appTsx = () =>
        inAlpha(() =>
          port.read({ orgId: world.alpha.orgId, projectId: world.alpha.projectId }, APP_TSX),
        );

      async function runToEnd(prompt: string): Promise<RunResponse> {
        const created = runResponseSchema.parse(
          (
            await unsafe(http(app).post(`${base()}/runs`), [cookie()])
              .send({ prompt })
              .expect(201)
          ).body,
        );
        let run = created;
        await until(
          `run ${created.id} to succeed`,
          async () => {
            run = runResponseSchema.parse(
              (
                await http(app)
                  .get(`${base()}/runs/${created.id}`)
                  .set('Cookie', cookie())
                  .expect(200)
              ).body,
            );
            if (run.status === 'failed' || run.status === 'cancelled') {
              throw new Error(
                `run ${created.id} ended ${run.status}: ${JSON.stringify(await events(created.id))}`,
              );
            }
            return run.status === 'succeeded';
          },
          RUN_TIMEOUT_MS,
        );
        note(`run ${run.id}: ${prompt}`);
        return run;
      }

      const events = (runId: string) =>
        transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx
            .select({ data: schema.runEvents.data, type: schema.runEvents.type })
            .from(schema.runEvents)
            .where(eq(schema.runEvents.runId, runId))
            .orderBy(asc(schema.runEvents.seq)),
        );

      async function checkpointEvents(runId: string): Promise<{ checkpointId: string }[]> {
        return (await events(runId))
          .filter((row) => row.type === 'checkpoint')
          .map((row) => row.data as { checkpointId: string });
      }

      async function list(): Promise<Checkpoint[]> {
        const response = await http(app)
          .get(`${base()}/checkpoints`)
          .set('Cookie', cookie())
          .expect(200);
        return checkpointListResponseSchema.parse(response.body).items;
      }

      const revert = (id: string, key = randomUUID()) =>
        unsafe(http(app).post(`${base()}/checkpoints/${id}/revert`), [cookie()])
          .set('Idempotency-Key', key)
          .send();

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
        port = app.get(SandboxService, { strict: false });
        await queue.del(poolFrontKey(TEMPLATE));

        // As `sandbox-lifecycle-real`: the version is real — built once, adopted on a rerun.
        const since = Date.now();
        const outcome = await app.get(TemplatePublisher, { strict: false }).publish(TEMPLATE);
        note(`publish (${outcome.kind}): ${String(Date.now() - since)} ms`);
        expect(['built', 'adopted']).toContain(outcome.kind);
        world = await createTwoTenantWorld(app);
        // Run create resolves a credential: the organisation's own key (platform credits are
        // retired), which only the scripted provider ever receives.
        await seedProviderKey(app, world.alpha);
      }, PUBLISH_TIMEOUT_MS);

      afterAll(async () => {
        for (const dto of (await daytona?.listByLabels({ 'forge.owner': OWNER })) ?? []) {
          await daytona.remove(dto.id).catch(() => undefined);
        }
        if (world) await destroyTwoTenantWorld(app, world);
        if (db) await dropFakeVersions(db, TEMPLATE);
        await queue?.del(poolFrontKey(TEMPLATE));
        await app?.close();
        await suiteLock?.release();
      }, LOCKED_BOOT_TIMEOUT_MS);

      it(
        'baselines a real sandbox, commits the turn, reverts to the baseline and back, and verifies the mirror',
        async () => {
          // § 2 step 1–2: the cold claim, the baseline pre-flight, the turn's edit and commit.
          provider.script(
            {
              toolCalls: [
                { id: 'call-1', input: { content: EDITED_APP, path: APP_TSX }, name: 'fs_edit' },
              ],
            },
            { text: 'Edited.' },
          );
          const edit = await runToEnd(`Edit ${APP_TSX}`);
          expect(await appTsx()).toBe(EDITED_APP);

          let items = await list();
          expect(items.map((item) => item.kind)).toEqual(['turn', 'baseline']);
          const [turn, baseline] = items as [Checkpoint, Checkpoint];
          expect(baseline).toMatchObject({ parentId: null, runId: null, turn: null });
          expect(baseline.label).toMatch(/^Baseline: vite-react forge-tpl-/);
          expect(baseline.files.map((file) => file.path)).toContain(APP_TSX);
          expect(turn).toMatchObject({ kind: 'turn', parentId: baseline.id, runId: edit.id });
          expect(turn.files).toEqual([
            { bytes: Buffer.byteLength(EDITED_APP), path: APP_TSX, status: 'M' },
          ]);
          expect(await checkpointEvents(edit.id)).toMatchObject([{ checkpointId: turn.id }]);
          note(`baseline ${baseline.id} (${baseline.gitSha}), turn ${turn.id} (${turn.gitSha})`);

          // § 2 step 3: a turn that changes nothing records no row and re-emits the head id.
          provider.script({ text: 'Hello.' });
          const hello = await runToEnd('Say hello');
          expect((await list()).map((item) => item.id)).toEqual([turn.id, baseline.id]);
          expect(await checkpointEvents(hello.id)).toMatchObject([{ checkpointId: turn.id }]);

          // § 2 step 4: revert to the baseline — SC-002 times it.
          const key = randomUUID();
          let since = Date.now();
          const toBaseline = (await revert(baseline.id, key).expect(201)).body as Checkpoint;
          note(`revert to baseline ${toBaseline.id}: ${String(Date.now() - since)} ms`);
          expect(await appTsx()).toBe(SCAFFOLD_APP);
          expect(toBaseline).toMatchObject({
            kind: 'revert',
            parentId: turn.id,
            revertsId: baseline.id,
            runId: null,
          });
          expect(toBaseline.files).toEqual([
            { bytes: Buffer.byteLength(SCAFFOLD_APP), path: APP_TSX, status: 'M' },
          ]);
          const diff = checkpointDiffResponseSchema.parse(
            (
              await http(app)
                .get(`${base()}/checkpoints/${toBaseline.id}/diff`)
                .set('Cookie', cookie())
                .expect(200)
            ).body,
          );
          expect(diff.files).toHaveLength(1);
          expect(diff.files[0]!.binary || diff.files[0]!.patch).toContain(
            `-  return <h1>Edited by`,
          );

          // § 2 step 5: the same key replays the same row.
          const replay = (await revert(baseline.id, key).expect(201)).body as Checkpoint;
          expect({ ...replay, mirroredAt: null }).toEqual({ ...toBaseline, mirroredAt: null });
          expect(await list()).toHaveLength(3);

          // § 2 step 6: redo — the edit is back, four rows.
          since = Date.now();
          const toTurn = (await revert(turn.id).expect(201)).body as Checkpoint;
          note(`revert to turn ${toTurn.id}: ${String(Date.now() - since)} ms`);
          expect(await appTsx()).toBe(EDITED_APP);
          expect(toTurn).toMatchObject({
            kind: 'revert',
            parentId: toBaseline.id,
            revertsId: turn.id,
          });
          items = await list();
          expect(items.map((item) => item.id)).toEqual([
            toTurn.id,
            toBaseline.id,
            turn.id,
            baseline.id,
          ]);

          // § 2 step 8: the head is already where the workspace is.
          const refused = await revert(toTurn.id).expect(409);
          expect(problemDetailSchema.parse(refused.body).detail).toBe(
            'Already at this checkpoint.',
          );

          // § 3 steps 1–2: with a real store every row mirrors and `repo:verify` is current.
          if (!mirrorConfigured) {
            note('OBJECT_STORE_* not set: the mirror and repo:verify are not walked');
            return;
          }
          await until(
            'every checkpoint to be mirrored',
            async () => (await list()).every((item) => item.mirroredAt !== null),
            MIRROR_TIMEOUT_MS,
          );
          const { orgId, projectId } = world.alpha;
          expect(await repoVerify(app, { mirrorNow: false, orgId, projectId })).toBe(0);
          expect(await repoVerify(app, { mirrorNow: true, orgId, projectId })).toBe(0);
        },
        WALK_TIMEOUT_MS,
      );
    },
  );
});
