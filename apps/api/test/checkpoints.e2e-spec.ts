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
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { MemoryObjectStore } from '../src/common/object-store/memory-object-store';
import { OBJECT_STORE } from '../src/common/object-store/object-store.port';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import {
  AGENT_TIMINGS,
  type AgentTimings,
  LLM_PROVIDER,
} from '../src/modules/agent/agent.constants';
import { mirrorKey } from '../src/modules/checkpoints/repo-mirror.consumer';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../src/modules/identity/password/breached-password.port';
import { SandboxService } from '../src/modules/sandbox/sandbox.service';
import { unsafe } from './support/csrf-client';
import { type FakeDaytona, startFakeDaytona } from './support/fake-daytona';
import { type FakeGit, fakeGit } from './support/fake-git';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import { seedProviderKey } from './support/seed-provider-key';
import { ScriptedProvider } from './support/scripted-provider';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  http,
  type Tenant,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

/** Before any import, as `agent-core.e2e-spec.ts`: the worker drains `agent.run`, the Daytona is the fake's. */
const FAKE = vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  process.env.RUN_PROFILES = 'api,agent,events,cron';
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
const LOCKED_BOOT_TIMEOUT_MS = 600_000;
const RUN_TIMEOUT_MS = 15_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMINGS: AgentTimings = {
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

/**
 * The mirror's store: in memory, with one PUT that fails the way the S3 SDK's wire error does.
 * The PUT after the failed one waits on `release`, so the case asserts the unmirrored state before
 * the retry — whose jitter has no floor — can land.
 */
class FlakyObjectStore extends MemoryObjectStore {
  failNextPut = false;
  puts = 0;
  release: () => void = () => undefined;
  private gate: Promise<void> | undefined;

  override async put(key: string, body: Buffer, meta: Readonly<Record<string, string>>) {
    this.puts += 1;
    if (this.failNextPut) {
      this.failNextPut = false;
      this.gate = new Promise((resolve) => (this.release = resolve));
      throw Object.assign(new Error('ECONNREFUSED'), { $metadata: {} });
    }
    const gate = this.gate;
    this.gate = undefined;
    await gate;
    return super.put(key, body, meta);
  }
}

async function until(predicate: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

class ScriptedBreachPort implements BreachedPasswordPort {
  isBreached(_password: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/**
 * Spec 016 US1 + US4 over the API (quickstart § 2 steps 1–3): the real executor over the real
 * queue, a scripted model, the fake Daytona with `fakeGit` scripted into its `process/execute`.
 * The cases build on each other in order — the project's history grows as a real one would.
 */
describe('Checkpoints (e2e)', () => {
  describe.skipIf(!postgres || !redis)(
    'against Postgres, the queue and stream Redis roles and a fake Daytona',
    () => {
      let app: INestApplication;
      let fake: FakeDaytona;
      let git: FakeGit;
      let world: TwoTenantWorld;
      let transactions: TenantTransactionRunner;
      let suiteLock: { release: () => Promise<void> } | undefined;
      const provider = new ScriptedProvider();
      const store = new FlakyObjectStore();

      function checkpointsPath(tenant: Tenant = world.alpha): string {
        return `${ORGS}/${tenant.orgId}/projects/${tenant.projectId}/checkpoints`;
      }

      /** A run by alpha's owner, driven to its end by the relay and the worker. */
      async function runToEnd(prompt: string, status: RunResponse['status'] = 'succeeded') {
        const runs = `${ORGS}/${world.alpha.orgId}/projects/${world.alpha.projectId}/runs`;
        const cookie = world.alpha.owner.cookie;
        const created = runResponseSchema.parse(
          (await unsafe(http(app).post(runs), [cookie]).send({ prompt }).expect(201)).body,
        );
        const deadline = Date.now() + RUN_TIMEOUT_MS;
        for (;;) {
          const run = runResponseSchema.parse(
            (await http(app).get(`${runs}/${created.id}`).set('Cookie', cookie).expect(200)).body,
          );
          if (run.status === status) return run;
          if (Date.now() > deadline) throw new Error(`timed out; run is ${run.status}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }

      /** The run's `checkpoint` events' data, in `seq` order. */
      async function checkpointEvents(runId: string): Promise<{ checkpointId: string }[]> {
        const rows = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx
            .select({ data: schema.runEvents.data, type: schema.runEvents.type })
            .from(schema.runEvents)
            .where(eq(schema.runEvents.runId, runId))
            .orderBy(asc(schema.runEvents.seq)),
        );
        return rows
          .filter((row) => row.type === 'checkpoint')
          .map((row) => row.data as { checkpointId: string });
      }

      async function list(query = '', tenant: Tenant = world.alpha) {
        const response = await http(app)
          .get(`${checkpointsPath()}${query}`)
          .set('Cookie', tenant.owner.cookie)
          .expect(200);
        return checkpointListResponseSchema.parse(response.body);
      }

      /** Scripts one turn that writes `content` to README.md and answers. */
      function scriptEdit(content: string): void {
        provider.script(
          {
            toolCalls: [{ id: 'call-1', input: { content, path: 'README.md' }, name: 'fs_edit' }],
          },
          { text: 'Edited.' },
        );
      }

      beforeAll(async () => {
        suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
        fake = await startFakeDaytona({ port: FAKE.port });
        git = fakeGit(fake);
        fake.workspace.set(`${fake.workDir}/README.md`, {
          content: Buffer.from('# Demo\n'),
          kind: 'file',
        });

        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(BREACHED_PASSWORD_PORT)
          .useClass(ScriptedBreachPort)
          .overrideProvider(LLM_PROVIDER)
          .useValue(provider)
          .overrideProvider(AGENT_TIMINGS)
          .useValue(TIMINGS)
          .overrideProvider(OBJECT_STORE)
          .useValue(store)
          .compile();

        app = moduleRef.createNestApplication();
        configureApplication(app);
        await app.init();

        transactions = app.get(TenantTransactionRunner);
        world = await createTwoTenantWorld(app);
        // Run create resolves a credential: the organisation's own key (platform credits are
        // retired), which only the scripted provider ever receives.
        await seedProviderKey(app, world.alpha);

        const { orgId, projectId } = world.alpha;
        await transactions.runInTenantScope({ orgId, userId: null }, (tx) =>
          app.get(SandboxService).register(tx, { daytonaId: fake.sandboxId, orgId, projectId }),
        );
      }, LOCKED_BOOT_TIMEOUT_MS);

      afterAll(async () => {
        if (world) await destroyTwoTenantWorld(app, world);
        await app?.close();
        await fake?.close();
        await suiteLock?.release();
      });

      let baseline: Checkpoint;
      let first: Checkpoint;
      let second: Checkpoint;

      it(
        'a turn that edits a file records a checkpoint whose id the event carries, after the baseline',
        async () => {
          scriptEdit('# Demo\n\nEdited by the agent.\n');
          const run = await runToEnd('Edit README.md');

          const { items, nextCursor } = await list();
          expect(nextCursor).toBeNull();
          expect(items.map((item) => item.kind)).toEqual(['turn', 'baseline']);
          [first, baseline] = items as [Checkpoint, Checkpoint];

          // SC-009: the baseline came first — the workspace as the template left it.
          expect(baseline).toMatchObject({ parentId: null, runId: null, turn: null });
          expect(baseline.label).toMatch(/^Baseline: /);
          expect(baseline.files).toEqual(
            expect.arrayContaining([expect.objectContaining({ path: 'README.md', status: 'A' })]),
          );
          expect(Date.parse(baseline.createdAt)).toBeLessThanOrEqual(Date.parse(first.createdAt));

          // SC-001: the turn row names exactly the file the turn touched. `turn` counts the
          // run's model calls (spec 011): the edit was call 1, the answer that ended it call 2.
          expect(first).toMatchObject({
            gitSha: git.head(),
            label: 'Turn 2',
            parentId: baseline.id,
            runId: run.id,
            turn: 2,
          });
          expect(first.files).toEqual([
            {
              bytes: Buffer.byteLength('# Demo\n\nEdited by the agent.\n'),
              path: 'README.md',
              status: 'M',
            },
          ]);
          expect(first.id).toMatch(UUID);
          expect(await checkpointEvents(run.id)).toEqual([
            { checkpointId: first.id, label: 'Turn 2' },
          ]);
        },
        RUN_TIMEOUT_MS + 5_000,
      );

      it(
        "a second turn's parent is the first",
        async () => {
          scriptEdit('# Demo\n\nEdited twice.\n');
          const run = await runToEnd('Edit README.md again');

          const { items } = await list();
          expect(items).toHaveLength(3);
          second = items[0]!;
          expect(second).toMatchObject({
            gitSha: git.head(),
            kind: 'turn',
            parentId: first.id,
            runId: run.id,
            turn: 2,
          });
          expect(second.files.map((file) => file.path)).toEqual(['README.md']);
          expect(items[1]!.id).toBe(first.id);
        },
        RUN_TIMEOUT_MS + 5_000,
      );

      it(
        'a turn that changes nothing records no row and re-emits the head id',
        async () => {
          provider.script({ text: 'Hello.' });
          const run = await runToEnd('Say hello');

          expect(git.commits.size).toBe(3);
          expect((await list()).items.map((item) => item.id)).toEqual([
            second.id,
            first.id,
            baseline.id,
          ]);
          expect(await checkpointEvents(run.id)).toEqual([
            { checkpointId: second.id, label: second.label },
          ]);
        },
        RUN_TIMEOUT_MS + 5_000,
      );

      it('the list is newest first and paged', async () => {
        const page1 = await list('?limit=2');
        expect(page1.items.map((item) => item.id)).toEqual([second.id, first.id]);
        expect(page1.nextCursor).not.toBeNull();

        const page2 = await list(`?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`);
        expect(page2.items.map((item) => item.id)).toEqual([baseline.id]);
        expect(page2.nextCursor).toBeNull();

        const stamps = [...page1.items, ...page2.items].map((item) => Date.parse(item.createdAt));
        expect([...stamps].sort((a, b) => b - a)).toEqual(stamps);
      });

      it('the diff names the one file the turn touched', async () => {
        const response = await http(app)
          .get(`${checkpointsPath()}/${first.id}/diff`)
          .set('Cookie', world.alpha.owner.cookie)
          .expect(200);
        const diff = checkpointDiffResponseSchema.parse(response.body);

        expect(diff).toMatchObject({ checkpointId: first.id, parentId: baseline.id });
        expect(diff.files).toHaveLength(1);
        expect(diff.files[0]).toMatchObject({
          binary: false,
          path: 'README.md',
          status: 'M',
          truncated: false,
        });
        expect(diff.files[0]!.binary || diff.files[0]!.patch).toContain('+Edited by the agent.');

        const one = await http(app)
          .get(`${checkpointsPath()}/${first.id}`)
          .set('Cookie', world.alpha.owner.cookie)
          .expect(200);
        // Less `mirroredAt`: the mirror below flips it in the background at its own pace.
        expect({ ...one.body, mirroredAt: null }).toEqual({ ...first, mirroredAt: null });
      });

      /**
       * SC-008 on this platform's guard (rbac e2e): a foreign org is refused exactly as an
       * organisation that does not exist, an anonymous caller before permissions are considered;
       * a checkpoint that does not exist in the caller's own project is the service's `not-found`.
       */
      it('a foreign org and an anonymous caller are refused as a project that does not exist', async () => {
        /** The body less what differs per request: the instance and the request id. */
        const shape = (body: unknown) =>
          Object.fromEntries(
            Object.entries(problemDetailSchema.parse(body)).filter(
              ([member]) => member !== 'requestId' && member !== 'instance',
            ),
          );
        const routes = ['', `/${first.id}`, `/${first.id}/diff`];
        for (const route of routes) {
          const unknown = await http(app)
            .get(`${ORGS}/${randomUUID()}/projects/${world.alpha.projectId}/checkpoints${route}`)
            .set('Cookie', world.alpha.owner.cookie)
            .expect(403);
          const foreign = await http(app)
            .get(`${checkpointsPath()}${route}`)
            .set('Cookie', world.beta.owner.cookie)
            .expect(403);
          expect(shape(foreign.body)).toEqual(shape(unknown.body));
          expect(shape(foreign.body).type).toContain('permission-denied');

          await http(app).get(`${checkpointsPath()}${route}`).expect(401);
        }

        for (const route of [`/${randomUUID()}`, `/${randomUUID()}/diff`]) {
          const missing = await http(app)
            .get(`${checkpointsPath()}${route}`)
            .set('Cookie', world.alpha.owner.cookie)
            .expect(404);
          expect(shape(missing.body).type).toContain('not-found');
        }
      });

      /**
       * Spec 016 US3 (FR-017..FR-023, SC-005/SC-006, quickstart § 3) over the rows the cases above
       * left: every checkpoint mirrors through `repo.mirror`, the one object's `head` label is the
       * project's latest sha, and a store outage never touches the turn.
       */
      describe('the mirror', () => {
        /** Up to the first retry's jitter (2 s) plus a relay tick and the fake's git. */
        const MIRROR_TIMEOUT_MS = 10_000;

        function key(): string {
          return mirrorKey(world.alpha.orgId, world.alpha.projectId);
        }

        async function allMirrored(): Promise<boolean> {
          return (await list()).items.every((item) => item.mirroredAt !== null);
        }

        it(
          "every checkpoint is mirrored and the object's head is the latest sha",
          async () => {
            expect(await until(allMirrored, MIRROR_TIMEOUT_MS)).toBe(true);

            const object = await store.get(key());
            expect(object).not.toBeNull();
            expect(object!.meta).toEqual({ head: second.gitSha });
            expect(object!.body).toEqual(git.bundleOf(second.gitSha));
            expect(store.objects.size).toBe(1);
          },
          MIRROR_TIMEOUT_MS + 5_000,
        );

        it(
          'an unreachable store leaves the turn succeeded and the row unmirrored, then a retry mirrors it',
          async () => {
            const putsBefore = store.puts;
            store.failNextPut = true;
            scriptEdit('# Demo\n\nEdited a third time.\n');
            const run = await runToEnd('Edit README.md a third time');
            expect(run.status).toBe('succeeded');

            const [third] = (await list()).items;
            expect(third).toMatchObject({ gitSha: git.head(), runId: run.id });

            // The failed PUT: the turn is over, the row waits for the retry (FR-018, FR-021).
            expect(await until(() => store.puts > putsBefore, MIRROR_TIMEOUT_MS)).toBe(true);
            expect((await list()).items[0]!.mirroredAt).toBeNull();
            expect((await store.get(key()))!.meta).toEqual({ head: second.gitSha });

            store.release();
            expect(await until(allMirrored, MIRROR_TIMEOUT_MS)).toBe(true);
            expect(store.puts).toBe(putsBefore + 2);
            expect((await store.get(key()))!.meta).toEqual({ head: third!.gitSha });
          },
          RUN_TIMEOUT_MS + 2 * MIRROR_TIMEOUT_MS,
        );
      });

      /**
       * Spec 016 US2 (FR-014..FR-016, SC-002..SC-004, quickstart § 2 steps 4–8) over the history
       * the cases above left: the baseline, two turns, and the third turn the mirror case added.
       * A revert is a new commit over the head, never a rewrite (FR-014), so a revert of a revert
       * is the same operation; the workspace says "already there", not the head row (FR-012).
       */
      describe('the revert', () => {
        const readme = () => worktree().get('README.md')?.toString('utf8');

        function revert(id: string, key = randomUUID(), cookie = world.alpha.owner.cookie) {
          return unsafe(http(app).post(`${checkpointsPath()}/${id}/revert`), [cookie])
            .set('Idempotency-Key', key)
            .send();
        }

        /** The worktree as a tree, to compare with a commit's exactly. */
        function worktree(): Map<string, Buffer> {
          const tree = new Map<string, Buffer>();
          for (const [key, entry] of fake.workspace) {
            const path = key.slice(fake.workDir.length + 1);
            const inside = key.startsWith(`${fake.workDir}/`) && !path.startsWith('.git/');
            if (inside && entry.kind === 'file') tree.set(path, entry.content);
          }
          return tree;
        }

        /** The problem's `type` and `detail`, the two things a case asserts on. */
        async function refusal(id: string, status: number, key = randomUUID(), cookie?: string) {
          const response = await revert(id, key, cookie).expect(status);
          const { detail, type } = problemDetailSchema.parse(response.body);
          return { detail, type };
        }

        let third: Checkpoint;
        let toBaseline: Checkpoint;
        let toThird: Checkpoint;
        const firstKey = randomUUID();

        it('revert to the baseline restores the scaffold and records a revert row', async () => {
          third = (await list()).items[0]!;
          expect(readme()).toBe('# Demo\n\nEdited a third time.\n');

          const response = await revert(baseline.id, firstKey).expect(201);
          toBaseline = response.body as Checkpoint;

          expect(readme()).toBe('# Demo\n');
          expect(toBaseline).toMatchObject({
            actorId: world.alpha.owner.userId,
            gitSha: git.head(),
            kind: 'revert',
            label: `Revert to ${baseline.label}`,
            parentId: third.id,
            revertsId: baseline.id,
            runId: null,
            turn: null,
          });
          expect(toBaseline.gitSha).not.toBe(baseline.gitSha);
          expect(toBaseline.files).toEqual([
            { bytes: Buffer.byteLength('# Demo\n'), path: 'README.md', status: 'M' },
          ]);

          // The history only grew (FR-014): every old row still there, the new one on top.
          const { items } = await list();
          expect(items.map((item) => item.id)).toEqual([
            toBaseline.id,
            third.id,
            second.id,
            first.id,
            baseline.id,
          ]);

          // FR-025: the audit entry names the actor and the target.
          const audit = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
            tx
              .select({ actorId: schema.auditLog.actorId, metadata: schema.auditLog.metadata })
              .from(schema.auditLog)
              .where(eq(schema.auditLog.target, toBaseline.id)),
          );
          expect(audit).toEqual([
            {
              actorId: world.alpha.owner.userId,
              metadata: { projectId: world.alpha.projectId, revertsId: baseline.id },
            },
          ]);
        });

        it('revert of the revert redoes the edit', async () => {
          const response = await revert(third.id).expect(201);
          toThird = response.body as Checkpoint;

          expect(readme()).toBe('# Demo\n\nEdited a third time.\n');
          expect(toThird).toMatchObject({
            gitSha: git.head(),
            kind: 'revert',
            label: `Revert to ${third.label}`,
            parentId: toBaseline.id,
            revertsId: third.id,
          });
          expect(toThird.gitSha).not.toBe(third.gitSha);
          expect(git.commits.get(toThird.gitSha)!.tree).toEqual(
            git.commits.get(third.gitSha)!.tree,
          );
          expect(toThird.files).toEqual([
            {
              bytes: Buffer.byteLength('# Demo\n\nEdited a third time.\n'),
              path: 'README.md',
              status: 'M',
            },
          ]);
        });

        it('the same Idempotency-Key returns the same row', async () => {
          const commits = git.commits.size;
          const replay = await revert(baseline.id, firstKey).expect(201);

          // Less `mirroredAt`: the mirror flips it in the background at its own pace.
          expect({ ...(replay.body as Checkpoint), mirroredAt: null }).toEqual({
            ...toBaseline,
            mirroredAt: null,
          });
          // Replayed, not redone: no commit, the workspace where the second revert left it.
          expect(git.commits.size).toBe(commits);
          expect(readme()).toBe('# Demo\n\nEdited a third time.\n');
          expect((await list()).items[0]!.id).toBe(toThird.id);
        });

        it(
          'refused with conflict while a run is running',
          async () => {
            const runs = `${ORGS}/${world.alpha.orgId}/projects/${world.alpha.projectId}/runs`;
            const cookie = world.alpha.owner.cookie;
            // The model never answers (agent-core's stall case): the run stays `running` until
            // the cancel below aborts it.
            provider.script({ hang: true });
            const created = runResponseSchema.parse(
              (await unsafe(http(app).post(runs), [cookie]).send({ prompt: 'Hang' }).expect(201))
                .body,
            );
            const status = async () =>
              runResponseSchema.parse(
                (await http(app).get(`${runs}/${created.id}`).set('Cookie', cookie).expect(200))
                  .body,
              ).status;
            const running = await until(async () => (await status()) === 'running', RUN_TIMEOUT_MS);
            expect(running).toBe(true);

            const commits = git.commits.size;
            expect(await refusal(baseline.id, 409)).toMatchObject({ detail: 'A run is active.' });
            expect((await refusal(baseline.id, 409)).type).toContain('conflict');
            expect(git.commits.size).toBe(commits);

            await unsafe(http(app).post(`${runs}/${created.id}/cancel`), [cookie])
              .send()
              .expect(202);
            const cancelled = await until(
              async () => (await status()) === 'cancelled',
              RUN_TIMEOUT_MS,
            );
            expect(cancelled).toBe(true);
          },
          RUN_TIMEOUT_MS * 2 + 5_000,
        );

        it('refused when already at the target', async () => {
          const commits = git.commits.size;
          // The head row, and the turn whose tree the head reproduces: the workspace is at both.
          for (const id of [toThird.id, third.id]) {
            expect(await refusal(id, 409)).toEqual({
              detail: 'Already at this checkpoint.',
              type: expect.stringContaining('conflict') as string,
            });
          }
          expect(git.commits.size).toBe(commits);
        });

        it('a read-only member gets permission-denied', async () => {
          const { orgId, projectId } = world.alpha;
          await transactions.runInTenantTransaction(orgId, (tx) =>
            tx
              .insert(schema.projectGrants)
              .values({ orgId, projectId, role: 'viewer', userId: world.outsider.userId }),
          );
          // A member of the project: the history is theirs to read.
          await http(app).get(checkpointsPath()).set('Cookie', world.outsider.cookie).expect(200);

          const commits = git.commits.size;
          const refused = await refusal(baseline.id, 403, randomUUID(), world.outsider.cookie);
          expect(refused.type).toContain('permission-denied');
          expect(git.commits.size).toBe(commits);
          expect((await list()).items[0]!.id).toBe(toThird.id);
        });

        it('revert to a non-head checkpoint restores its tree exactly', async () => {
          const response = await revert(first.id).expect(201);
          const row = response.body as Checkpoint;

          const target = git.commits.get(first.gitSha)!.tree;
          expect(worktree()).toEqual(target);
          expect(git.commits.get(row.gitSha)!.tree).toEqual(target);
          expect(readme()).toBe('# Demo\n\nEdited by the agent.\n');
          expect(row).toMatchObject({
            gitSha: git.head(),
            kind: 'revert',
            label: `Revert to ${first.label}`,
            parentId: toThird.id,
            revertsId: first.id,
          });
          expect(row.files).toEqual([
            {
              bytes: Buffer.byteLength('# Demo\n\nEdited by the agent.\n'),
              path: 'README.md',
              status: 'M',
            },
          ]);
        });
      });

      /** FR-004/FR-010: the project's writer lock keeps the chain linear under concurrent runs. */
      it(
        'two concurrent runs on one project both succeed and the history stays one linear chain',
        async () => {
          const runs = `${ORGS}/${world.alpha.orgId}/projects/${world.alpha.projectId}/runs`;
          const cookie = world.alpha.owner.cookie;
          const before = (await list()).items;
          scriptEdit('# Demo\n\nEdited by run A.\n');
          scriptEdit('# Demo\n\nEdited by run B.\n');

          const created = await Promise.all(
            ['Edit as A', 'Edit as B'].map(async (prompt) =>
              runResponseSchema.parse(
                (await unsafe(http(app).post(runs), [cookie]).send({ prompt }).expect(201)).body,
              ),
            ),
          );
          const settled = await until(async () => {
            for (const run of created) {
              const { status } = runResponseSchema.parse(
                (await http(app).get(`${runs}/${run.id}`).set('Cookie', cookie).expect(200)).body,
              );
              if (status !== 'succeeded') return false;
            }
            return true;
          }, RUN_TIMEOUT_MS);
          expect(settled).toBe(true);

          const { items } = await list();
          // Newest first: each row's parent is the next row down — no fork, no orphan.
          for (let i = 0; i + 1 < items.length; i += 1) {
            expect(items[i]!.parentId).toBe(items[i + 1]!.id);
          }
          expect(items.length).toBeGreaterThan(before.length);
          expect(git.commits.size).toBe(items.length);
          const ids = new Set(items.map((item) => item.id));
          for (const run of created) {
            const events = await checkpointEvents(run.id);
            expect(events).toHaveLength(1);
            expect(ids.has(events[0]!.checkpointId)).toBe(true);
          }
        },
        RUN_TIMEOUT_MS + 5_000,
      );
    },
  );
});
