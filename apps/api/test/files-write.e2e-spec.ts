import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  type Checkpoint,
  checkpointListResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  problemDetailSchema,
  runResponseSchema,
  writeFileResponseSchema,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import {
  AGENT_TIMINGS,
  type AgentTimings,
  LLM_PROVIDER,
} from '../src/modules/agent/agent.constants';
import { CheckpointService } from '../src/modules/checkpoints/checkpoint.service';
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
  type Principal,
  signUpAndIn,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

/**
 * Before any import, as `checkpoints.e2e-spec.ts`: `ConfigModule.forRoot` reads the environment
 * when `AppModule` is loaded. `agent` and `events` are on because one case races a save against a
 * real run's commit, which needs the executor actually running.
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

/**
 * The gate every e2e suite here honours: Postgres and both Redis roles are probed once in
 * `global-setup.ts` and the result injected. Unreachable means skipped, not failed — and
 * `EXPECT_INTEGRATION` in CI turns the probe's failure into a hard error there, so a skip can
 * never be how these cases quietly stop running.
 */
const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const ORGS = '/api/v1/orgs';
const LOCKED_BOOT_TIMEOUT_MS = 600_000;
const RUN_TIMEOUT_MS = 20_000;
/** The slow model call's shape: long enough to hold a run open while a save is attempted. */
const SLOW_CHUNKS = ['Thinking', ' about', ' it', ' a', ' little', ' longer', '.'];
const SLOW_GAP_MS = 300;

class ScriptedBreachPort implements BreachedPasswordPort {
  isBreached(_password: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/** Thrown to roll the caller's transaction back after the workspace has already been written. */
class Rollback extends Error {
  constructor(readonly checkpointId: string) {
    super('rollback');
    this.name = 'Rollback';
  }
}

/**
 * Spec 024 US3 over the API (FR-014 to FR-017, SC-004, SC-005): the concurrency the unit suite
 * cannot prove. `checkpoint.service.spec.ts` asserts the *order* of the lock and the active-run
 * check against a fake repository; only a real Postgres row lock, taken by two real requests in
 * two real transactions, shows what that order buys. Everything here is deliberately racy: the
 * cases fire requests concurrently and assert on what the database and the workspace are left
 * holding, never on which of the two racers won.
 */
describe('Saving a file, concurrently (e2e)', () => {
  describe.skipIf(!postgres || !redis)(
    'against Postgres, both Redis roles and a fake Daytona',
    () => {
      let app: INestApplication;
      let fake: FakeDaytona;
      let git: FakeGit;
      let world: TwoTenantWorld;
      let transactions: TenantTransactionRunner;
      let suiteLock: { release: () => Promise<void> } | undefined;
      /** A second editor of alpha's project: the other member in every two-member race. */
      let editor: Principal;
      const provider = new ScriptedProvider();

      const projectPath = () => `${ORGS}/${world.alpha.orgId}/projects/${world.alpha.projectId}`;

      /** One save as one member. A fresh `Idempotency-Key` each time: these are distinct writes. */
      const save = (
        who: Principal,
        body: { baseCheckpointId: string; content: string; path: string },
      ) =>
        unsafe(http(app).put(`${projectPath()}/files/content`), [who.cookie])
          .set(IDEMPOTENCY_KEY_HEADER, randomUUID())
          .send(body);

      async function history(): Promise<Checkpoint[]> {
        const response = await http(app)
          .get(`${projectPath()}/checkpoints`)
          .set('Cookie', world.alpha.owner.cookie)
          .expect(200);
        return checkpointListResponseSchema.parse(response.body).items;
      }

      const head = async (): Promise<Checkpoint> => (await history())[0]!;

      /** What the workspace holds right now, as bytes the sandbox would serve. */
      function fileAt(path: string): string | undefined {
        const entry = fake.workspace.get(`${fake.workDir}/${path}`);
        return entry?.kind === 'file' ? entry.content.toString('utf8') : undefined;
      }

      /** What the commit at `sha` holds — the recorded tree, as opposed to the live workspace. */
      function committed(sha: string, path: string): string | undefined {
        return git.commits.get(sha)?.tree.get(path)?.toString('utf8');
      }

      /** The rows the database actually holds for this project, whatever the API answered. */
      function checkpointRows() {
        return transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx
            .select({ gitSha: schema.checkpoints.gitSha, id: schema.checkpoints.id })
            .from(schema.checkpoints)
            .where(eq(schema.checkpoints.projectId, world.alpha.projectId)),
        );
      }

      const conflictReason = (response: Response): unknown =>
        (problemDetailSchema.parse(response.body) as Record<string, unknown>).reason;

      async function until(predicate: () => Promise<boolean>, ms: number): Promise<boolean> {
        const deadline = Date.now() + ms;
        for (;;) {
          if (await predicate()) return true;
          if (Date.now() > deadline) return false;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }

      beforeAll(async () => {
        // The fake's sandbox ids are shared with the other sandbox suites: one at a time.
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
          .useValue({
            batchMs: 10,
            batchSize: 32,
            cancelPollMs: 20,
            heartbeatMs: 200,
            leaseTtlMs: 5_000,
            providerAttempts: 3,
            providerBackoffBaseMs: 10,
            providerBackoffCapMs: 50,
            reaperMs: 60_000,
            staleAfterMs: 60_000,
            summaryMs: 30_000,
          } satisfies AgentTimings)
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

        // A second member holding `project:files.write` — the `editor` role's permission. Admitted
        // straight into `memberships` as `preview.e2e-spec.ts` does: this suite is about the lock,
        // not about the mail lane.
        editor = await signUpAndIn(app, 'editor');
        await transactions.runInTenantTransaction(orgId, async (tx) => {
          await tx
            .insert(schema.memberships)
            .values({ acceptedAt: new Date(), orgId, role: 'member', userId: editor.userId });
          await tx
            .insert(schema.projectGrants)
            .values({ orgId, projectId, role: 'editor', userId: editor.userId });
        });

        // The baseline every save hangs from, made by the product's own pre-flight rather than by
        // inserting a row: a hand edit is refused outright on a project with no checkpoint.
        await transactions.runInTenantScope({ orgId, userId: null }, (tx) =>
          app
            .get(CheckpointService)
            .ensureRepository(
              { orgId, projectId },
              { leaseEpoch: 0, operationId: `baseline/${randomUUID()}` },
              tx,
            ),
        );
      }, LOCKED_BOOT_TIMEOUT_MS);

      afterAll(async () => {
        if (world) await destroyTwoTenantWorld(app, world);
        await app?.close();
        await fake?.close();
        await suiteLock?.release();
      });

      /**
       * T034, FR-017 and SC-004. Two people, one file, one base, at the same moment. The lock
       * makes them sequential; the base check then refuses whichever arrives second, because by
       * then the head it read is no longer the head. The property under test is not which one
       * wins — that is the scheduler's business — but that the two are never both applied and
       * never blended: the file holds one person's text, whole.
       */
      it('two members saving the same file: one 201, one 409 base-moved, one row, no merge', async () => {
        const base = await head();
        const before = (await checkpointRows()).length;
        const mine = '# Demo\n\nWritten by the owner.\n';
        const theirs = '# Demo\n\nWritten by the editor.\n';

        const [ownerSave, editorSave] = await Promise.all([
          save(world.alpha.owner, {
            baseCheckpointId: base.id,
            content: mine,
            path: 'README.md',
          }),
          save(editor, { baseCheckpointId: base.id, content: theirs, path: 'README.md' }),
        ]);

        const statuses = [ownerSave.status, editorSave.status].sort((a, b) => a - b);
        expect(statuses).toEqual([201, 409]);

        // Which one won is the scheduler's business; that exactly one did is the requirement.
        const [winner, lost] = ownerSave.status === 201 ? [ownerSave, theirs] : [editorSave, mine];
        const loser = ownerSave.status === 201 ? editorSave : ownerSave;
        expect(conflictReason(loser)).toBe('base-moved');

        const applied = writeFileResponseSchema.parse(winner.body);
        expect(applied.saved).toBe(true);
        expect(applied.checkpoint.parentId).toBe(base.id);

        // One save, one row: the refusal recorded nothing at all.
        expect((await checkpointRows()).length).toBe(before + 1);
        expect((await head()).id).toBe(applied.checkpoint.id);

        // The file holds one person's text whole — never a merge of the two.
        const held = fileAt('README.md');
        expect([mine, theirs]).toContain(held);
        expect(held).not.toContain(lost.split('\n')[2]);
        expect(committed(applied.checkpoint.gitSha, 'README.md')).toBe(held);
      });

      /**
       * T035. Two people, two different files, one base. A different file is no exemption: the
       * base a save carries is the project's head, not that file's, and FR-018 is a project-level
       * rule. So the second is still refused, and what this case proves is that the refusal costs
       * nothing but a round trip. The loser reloads the head it was told about and saves again,
       * and the two edits end up as one chain, in the order they landed, with both files present
       * and neither overwritten.
       */
      it('two members saving different files: serialised into one chain, both files kept', async () => {
        const base = await head();
        const before = (await checkpointRows()).length;

        const [ownerSave, editorSave] = await Promise.all([
          save(world.alpha.owner, {
            baseCheckpointId: base.id,
            content: 'export const a = 1;\n',
            path: 'src/a.ts',
          }),
          save(editor, {
            baseCheckpointId: base.id,
            content: 'export const b = 2;\n',
            path: 'src/b.ts',
          }),
        ]);

        expect([ownerSave.status, editorSave.status].sort((a, b) => a - b)).toEqual([201, 409]);

        // Both entries carry the same members, so the loser keeps its own refusal to assert on.
        const ownerEntry = {
          content: 'export const a = 1;\n',
          path: 'src/a.ts',
          response: ownerSave,
          who: world.alpha.owner,
        };
        const editorEntry = {
          content: 'export const b = 2;\n',
          path: 'src/b.ts',
          response: editorSave,
          who: editor,
        };
        const [winner, loser] =
          ownerSave.status === 201 ? [ownerEntry, editorEntry] : [editorEntry, ownerEntry];

        // A different file is no exemption: the base is the project's head, not the file's.
        expect(conflictReason(loser.response)).toBe('base-moved');
        const first = writeFileResponseSchema.parse(winner.response.body);
        expect(first.saved).toBe(true);
        expect(first.checkpoint.parentId).toBe(base.id);

        // The retry, against the head the refusal's own answer told the client to reload to.
        const retry = await save(loser.who, {
          baseCheckpointId: first.checkpoint.id,
          content: loser.content,
          path: loser.path,
        }).expect(201);
        const second = writeFileResponseSchema.parse(retry.body);
        expect(second.saved).toBe(true);

        // One chain, in the order they landed: no fork, no second root.
        expect(second.checkpoint.parentId).toBe(first.checkpoint.id);
        expect((await checkpointRows()).length).toBe(before + 2);
        expect((await head()).id).toBe(second.checkpoint.id);

        // Serialising lost nothing: both files are in the tree, each holding its author's text.
        expect(fileAt('src/a.ts')).toBe('export const a = 1;\n');
        expect(fileAt('src/b.ts')).toBe('export const b = 2;\n');
        expect(committed(second.checkpoint.gitSha, 'src/a.ts')).toBe('export const a = 1;\n');
        expect(committed(second.checkpoint.gitSha, 'src/b.ts')).toBe('export const b = 2;\n');
      });

      /**
       * T036, FR-015 and FR-016 — the case the lock alone cannot carry. A run writes files through
       * the sandbox port all turn long and only commits at the end, and those writes take no lock,
       * so a save landing mid-turn would write into a tree the agent is halfway through changing.
       * The run here is held open on a slow model call *after* its `fs_edit` has already landed in
       * the workspace: exactly the window in which a blended tree would be possible. The save is
       * attempted inside it, and must be refused `run-active` rather than serialised into it.
       */
      it(
        'a save attempted while a run is mid-turn is refused, and the tree is never half-and-half',
        async () => {
          const base = await head();
          const before = (await checkpointRows()).length;
          const byAgent = '# Demo\n\nWritten by the agent.\n';
          const byHand = '# Demo\n\nWritten by hand during the run.\n';

          provider.script(
            {
              toolCalls: [
                { id: 'call-1', input: { content: byAgent, path: 'README.md' }, name: 'fs_edit' },
              ],
            },
            // The window: the edit is in the workspace, nothing is committed, the run is running.
            { slow: { chunks: SLOW_CHUNKS, gapMs: SLOW_GAP_MS } },
          );

          const runs = `${projectPath()}/runs`;
          const cookie = world.alpha.owner.cookie;
          const created = runResponseSchema.parse(
            (
              await unsafe(http(app).post(runs), [cookie])
                .send({ prompt: 'Edit README.md' })
                .expect(201)
            ).body,
          );
          const runStatus = async () =>
            runResponseSchema.parse(
              (await http(app).get(`${runs}/${created.id}`).set('Cookie', cookie).expect(200)).body,
            ).status;

          // Wait until the agent's write is actually in the workspace: before that the race this
          // case is about has not started, and a refusal would prove nothing.
          const inTheWindow = await until(
            async () => fileAt('README.md') === byAgent && (await runStatus()) === 'running',
            RUN_TIMEOUT_MS,
          );
          expect(inTheWindow).toBe(true);

          const refused = await save(editor, {
            baseCheckpointId: base.id,
            content: byHand,
            path: 'README.md',
          });

          expect(refused.status).toBe(409);
          // Not `base-moved`: the head has not moved yet — the run has not committed. The reason
          // the web shows is "wait for the run", and this is the only thing that produces it.
          expect(conflictReason(refused)).toBe('run-active');
          // Nothing of the hand edit reached the workspace, mid-turn or otherwise (FR-015).
          expect(fileAt('README.md')).toBe(byAgent);

          const ended = await until(
            async () => (await runStatus()) === 'succeeded',
            RUN_TIMEOUT_MS,
          );
          expect(ended).toBe(true);

          // The run's commit holds the agent's write whole, and nothing of the refused save.
          const after = await head();
          expect((await checkpointRows()).length).toBe(before + 1);
          expect(after.parentId).toBe(base.id);
          expect(committed(after.gitSha, 'README.md')).toBe(byAgent);
          expect(fileAt('README.md')).toBe(byAgent);
          expect(committed(after.gitSha, 'README.md')).not.toContain('by hand');
        },
        RUN_TIMEOUT_MS * 3,
      );

      /**
       * T037, FR-006 and SC-005 — deliberately last, because it leaves the workspace ahead of the
       * history and the cases above assume it is not.
       *
       * The workspace write and the row are not one atom and cannot be: the sandbox is not in the
       * caller's transaction. What FR-006 requires is the direction that matters — a save that
       * does not commit its transaction is not reported as a success and leaves no record of
       * itself. The residue is an orphan commit in the workspace, which is 016's known SC-007
       * case and is spanned by the next checkpoint's summary; a row without a workspace, the
       * direction that would lie to the person, is what cannot happen.
       */
      it('a transaction rolled back after the workspace write reports no success and leaves no row', async () => {
        const { orgId, projectId } = world.alpha;
        const base = await head();
        const before = await checkpointRows();

        const failure = await transactions
          .runInTenantScope({ orgId, userId: editor.userId }, async (tx) => {
            const result = await app.get(CheckpointService).save(
              { orgId, projectId },
              editor.userId,
              {
                baseCheckpointId: base.id,
                content: '# Demo\n\nNever recorded.\n',
                path: 'README.md',
              },
              tx,
            );
            // The workspace has been written and committed by now, and the row is in the
            // transaction. Whatever fails after this point — the audit write, the outbox append,
            // the connection — takes the row with it.
            throw new Rollback(result.checkpoint.id);
          })
          .catch((error: unknown) => error);

        // No success was reported to anybody: the caller got the failure, not a checkpoint.
        expect(failure).toBeInstanceOf(Rollback);
        const attemptedId = (failure as Rollback).checkpointId;

        // And no row survived it — not the checkpoint, not its audit entry, not its event.
        const after = await checkpointRows();
        expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
        expect(after.map((row) => row.id)).not.toContain(attemptedId);
        expect((await head()).id).toBe(base.id);

        const audits = await transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .select({ target: schema.auditLog.target })
            .from(schema.auditLog)
            .where(
              and(
                eq(schema.auditLog.orgId, orgId),
                eq(schema.auditLog.action, 'checkpoint.edited'),
                eq(schema.auditLog.target, attemptedId),
              ),
            ),
        );
        expect(audits).toEqual([]);

        const events = await transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .select({ aggregateId: schema.outbox.aggregateId })
            .from(schema.outbox)
            .where(
              and(eq(schema.outbox.originOrgId, orgId), eq(schema.outbox.aggregateId, attemptedId)),
            ),
        );
        expect(events).toEqual([]);
      });
    },
  );
});
