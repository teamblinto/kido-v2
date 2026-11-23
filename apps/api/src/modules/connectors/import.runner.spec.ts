import { schema } from '@repo/db';
import { and, eq, ne } from 'drizzle-orm';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import {
  type ConnectorsHarness,
  startConnectorsHarness,
} from '../../../test/fixtures/connectors-harness';
import type { TenantTransaction } from '../../database/database.types';
import type { Envelope } from '../outbox/envelope';
import { type Readiness, SANDBOX_LIFECYCLE } from '../sandbox/sandbox-lifecycle';
import { type ExecResult, SANDBOX_PORT } from '../sandbox/sandbox.port';
import { SandboxGuardError } from '../sandbox/sandbox.errors';
import { IMPORT_BUNDLE_PATH } from './import.runner';
import { ImportService } from './import.service';
import { SyncConsumer } from './push.consumer';
import { SyncService } from './sync.service';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

let gitOnPath = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitOnPath = false;
}

if (!postgres || !redis || !gitOnPath) {
  console.warn('SKIPPING import.runner.spec.ts: Postgres, Redis or git on PATH is missing');
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_DATE: '2026-09-20T10:00:00Z',
  GIT_AUTHOR_EMAIL: 'forge@example.test',
  GIT_AUTHOR_NAME: 'forge',
  GIT_COMMITTER_DATE: '2026-09-20T10:00:00Z',
  GIT_COMMITTER_EMAIL: 'forge@example.test',
  GIT_COMMITTER_NAME: 'forge',
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();

const REPO_ID = 831;

/**
 * The sandbox as a real git repository on disk, as `pull.consumer.spec.ts` does it: `exec` runs
 * the import's own command strings in the workspace and `upload` writes the bundle there. A real
 * workspace rather than a scripted one is the point — "the workspace equals the cloned tree" is
 * only worth asserting against a git that actually checked the bundle out.
 */
class DiskSandbox {
  dir = '';
  readonly commands: string[] = [];

  exec(_ref: unknown, command: string): Promise<ExecResult> {
    this.commands.push(command);
    const [program, ...args] = command.split(' ') as [string, ...string[]];

    if (program === 'rm') {
      return Promise.all(
        args
          .filter((arg) => !arg.startsWith('-'))
          .map((arg) => rm(join(this.dir, arg), { force: true, recursive: true })),
      ).then(() => ({ exitCode: 0, output: '', timedOut: false, truncated: false }));
    }

    const ran = spawnSync(program, args, { cwd: this.dir, encoding: 'utf8', env: GIT_ENV });

    return Promise.resolve({
      exitCode: ran.status ?? 1,
      output: `${ran.stdout}${ran.stderr}`,
      timedOut: false,
      truncated: false,
    });
  }

  async upload(_ref: unknown, path: string, body: Buffer): Promise<void> {
    await mkdir(join(this.dir, path, '..'), { recursive: true });
    await writeFile(join(this.dir, path), body);
  }
}

/**
 * Spec 026 US1, the clone/bundle/checkout leg (research R4, R5) driven through `SyncConsumer`'s
 * `import` arm: the remote is the fixture's bare repository served only to a one-repository token,
 * the worker's clone is real git, and the workspace is a real repository holding a template's
 * starter files over a prepared `node_modules`.
 */
describe('ImportRunner', () => {
  describe.skipIf(!postgres || !redis || !gitOnPath)('against the fixture GitHub over git', () => {
    let harness: ConnectorsHarness;
    let consumer: SyncConsumer;
    let imports: ImportService;
    let syncs: SyncService;
    let work: string;
    let headSha: string;
    const sandbox = new DiskSandbox();
    const ensureReady = vi.fn((_tx: TenantTransaction): Promise<Readiness> =>
      Promise.resolve({ ready: true }),
    );

    /** The imported project — the one the harness did not create. */
    async function importedProject(): Promise<{ id: string } | undefined> {
      const [row] = await harness.inTenant((tx) =>
        tx
          .select({ id: schema.projects.id })
          .from(schema.projects)
          .where(
            and(
              eq(schema.projects.orgId, harness.orgId),
              ne(schema.projects.id, harness.projectId),
            ),
          ),
      );

      return row;
    }

    /**
     * `start` the import, then run the consumer's two halves by hand, as the queue would.
     *
     * `attempt` is the consumer's retry counter: a transient failure only becomes a row's reason
     * on the last one, so a test about `timed-out` has to say which attempt it is driving.
     * `mutate` runs between the request and the work, which is where a test breaks the thing the
     * runner is about to use.
     */
    async function runImport(
      options: {
        attempt?: number;
        mutate?: (projectId: string) => Promise<void>;
        /** Spec 047: null is a smart import — the repository alone, no template, branch or name. */
        template?: 'python' | 'vite-react' | null;
      } = {},
    ) {
      const { attempt = 1, mutate, template = 'vite-react' } = options;
      const started = await harness.inTenantScope((tx) =>
        imports.start(
          tx,
          harness.orgId,
          harness.workspaceId,
          harness.userId,
          template === null
            ? { repoId: REPO_ID }
            : { branch: 'main', name: 'Imported', repoId: REPO_ID, template },
        ),
      );
      await mutate?.(started.projectId);
      const event: Envelope<'sync.requested'> = {
        aggregate: 'sync-operation',
        aggregateId: started.id,
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        orgId: harness.orgId,
        payload: {
          orgId: harness.orgId,
          projectId: started.projectId,
          syncOperationId: started.id,
        },
        traceId: null,
        type: 'sync.requested',
      };
      const job = await harness.inTenant((tx) => consumer.handle(event, tx));
      await consumer.effect(event, job, attempt);

      return harness.inTenant((tx) =>
        syncs.byId(tx, { orgId: harness.orgId, projectId: started.projectId }, started.id),
      );
    }

    beforeAll(async () => {
      harness = await startConnectorsHarness({
        git: true,
        override: (builder) =>
          builder
            .overrideProvider(SANDBOX_PORT)
            .useValue(sandbox)
            .overrideProvider(SANDBOX_LIFECYCLE)
            .useValue({ ensureReady }),
      });
      consumer = harness.moduleRef.get(SyncConsumer, { strict: false });
      imports = harness.moduleRef.get(ImportService, { strict: false });
      syncs = harness.moduleRef.get(SyncService, { strict: false });
    }, 600_000);

    afterAll(async () => {
      await harness?.close();
      if (work !== undefined) await rm(work, { force: true, recursive: true });
    });

    beforeEach(async () => {
      await harness.reset();
      ensureReady.mockClear();
      ensureReady.mockResolvedValue({ ready: true });
      sandbox.commands.length = 0;
      await harness.inTenant((tx) =>
        tx
          .delete(schema.projects)
          .where(
            and(
              eq(schema.projects.orgId, harness.orgId),
              ne(schema.projects.id, harness.projectId),
            ),
          ),
      );
      await harness.connect();

      // The repository to import: a Vite + React tree, both on the fixture's git and in its API.
      harness.fixture.repositories.set(REPO_ID, {
        branches: {},
        default_branch: 'main',
        full_name: 'acme/site',
        id: REPO_ID,
        name: 'site',
        owner: { login: 'acme' },
        private: false,
      });
      headSha = await harness.fixture.seedRepo(harness.fixture.repositories.get(REPO_ID)!, {
        'README.md': '# imported\n',
        'package.json': JSON.stringify({
          dependencies: { react: '19' },
          devDependencies: { vite: '6' },
          scripts: { dev: 'vite' },
        }),
        'src/main.tsx': 'export const main = 1;\n',
        'vite.config.ts': 'export default {};\n',
      });

      // The sandbox: the prepared layer (`node_modules`) with the template's starter files over it.
      if (work !== undefined) await rm(work, { force: true, recursive: true });
      work = await mkdtemp(join(tmpdir(), 'forge-import-spec-'));
      sandbox.dir = work;
      await mkdir(join(work, 'node_modules', 'react'), { recursive: true });
      await writeFile(join(work, 'node_modules', 'react', 'index.js'), 'module.exports = {};\n');
      await mkdir(join(work, 'src'), { recursive: true });
      await writeFile(join(work, 'src', 'App.tsx'), 'export default function App() {}\n');
      await writeFile(join(work, 'package.json'), '{"name":"starter"}\n');
    });

    it('the workspace becomes the cloned tree, the starter files go, node_modules survives', async () => {
      const operation = await runImport();

      expect(operation).toMatchObject({
        commits: 1,
        kind: 'import',
        reason: null,
        state: 'succeeded',
        toSha: headSha,
      });

      // The workspace is a repository at the cloned sha holding exactly the tracked files.
      expect(git(work, 'rev-parse', 'HEAD')).toBe(headSha);
      expect(git(work, 'ls-files').split('\n').sort()).toEqual([
        'README.md',
        'package.json',
        'src/main.tsx',
        'vite.config.ts',
      ]);
      // FR-018 / SC-002: the template's own starter file is gone, and `package.json` is the
      // repository's rather than the scaffold's.
      expect(git(work, 'show', 'HEAD:package.json')).toContain('react');
      expect(spawnSync('test', ['-e', join(work, 'src', 'App.tsx')]).status).not.toBe(0);
      // R5: the prepared dependency layer was never in the template's file list, so it stays.
      expect(
        spawnSync('test', ['-e', join(work, 'node_modules', 'react', 'index.js')]).status,
      ).toBe(0);
      // No credential of any lifetime entered the sandbox (spec 018 FR-030, inherited).
      for (const token of harness.fixture.tokens.keys()) {
        expect(sandbox.commands.join('\n')).not.toContain(token);
      }
    });

    /**
     * Spec 047: a smart import detects the run profile from the clone, cleans the pool image out of
     * the workspace so the repository installs from scratch, and hands the profile to the sandbox
     * through the event that restarts its dev server — with a readable provisional name.
     */
    it('a smart import detects the run profile, cleans the workspace and asks for a restart and a name', async () => {
      const operation = await runImport({ template: null });
      const project = await importedProject();

      expect(operation).toMatchObject({ reason: null, state: 'succeeded', toSha: headSha });
      const [row] = await harness.inTenant((tx) =>
        tx
          .select({
            name: schema.projects.name,
            namePending: schema.projects.namePending,
            runConfig: schema.projects.runConfig,
            template: schema.projects.template,
          })
          .from(schema.projects)
          .where(eq(schema.projects.id, project!.id)),
      );
      expect(row).toMatchObject({
        name: 'Site',
        namePending: true,
        runConfig: {
          dev: 'npm run dev -- --host 0.0.0.0 --port 3000 --strictPort',
          install: 'npm install --no-audit --no-fund',
          port: 3000,
          root: '.',
          source: 'detected',
          stack: { framework: 'vite-react', language: 'javascript', packageManager: 'npm' },
        },
        template: null,
      });

      // Nothing of the pool image is left: no starter file and no `node_modules` it installed.
      expect(sandbox.commands).toContain('git clean -ffdxq');
      expect(spawnSync('test', ['-e', join(work, 'node_modules')]).status).not.toBe(0);
      expect(spawnSync('test', ['-e', join(work, 'src', 'App.tsx')]).status).not.toBe(0);
      expect(git(work, 'ls-files').split('\n')).toContain('vite.config.ts');

      const events = await harness.inTenant((tx) =>
        tx
          .select({ type: schema.outbox.type })
          .from(schema.outbox)
          .where(eq(schema.outbox.aggregateId, project!.id)),
      );
      expect(events.map(({ type }) => type)).toEqual(
        expect.arrayContaining(['project.env.changed', 'project.naming.requested']),
      );
    });

    it('a template import keeps spec 026’s behaviour: no run profile and no clean', async () => {
      await runImport();
      const project = await importedProject();
      const [row] = await harness.inTenant((tx) =>
        tx
          .select({ runConfig: schema.projects.runConfig, template: schema.projects.template })
          .from(schema.projects)
          .where(eq(schema.projects.id, project!.id)),
      );

      expect(row).toEqual({ runConfig: null, template: 'vite-react' });
      expect(sandbox.commands).not.toContain('git clean -ffdxq');
    });

    /**
     * The production failure (2026-11-16): the clone was `--depth 1`, so its bundle named a parent it
     * did not carry and the sandbox's `git fetch` refused it — every repository with a second commit
     * failed to import, and its project was withdrawn. Seeds only ever had one commit.
     */
    it('imports a repository with history: the whole branch arrives, not a shallow tip', async () => {
      const repo = harness.fixture.repositories.get(REPO_ID)!;
      const extra = await mkdtemp(join(tmpdir(), 'forge-import-history-'));
      git(extra, 'clone', '--quiet', join(harness.fixture.gitRoot!, `${repo.full_name}.git`), '.');
      await writeFile(join(extra, 'CHANGELOG.md'), '# second commit\n');
      git(extra, 'add', '-A');
      git(extra, 'commit', '--quiet', '-m', 'second');
      const second = git(extra, 'rev-parse', 'HEAD');
      git(extra, 'push', '--quiet', 'origin', 'HEAD:main');
      harness.fixture.repositories.set(REPO_ID, {
        ...repo,
        branches: { ...repo.branches, main: second },
      });

      const operation = await runImport({ template: null });

      expect(operation).toMatchObject({ reason: null, state: 'succeeded', toSha: second });
      expect(git(work, 'rev-list', '--count', 'HEAD')).toBe('2');
      // What a later push or pull seeds from: an `--all` bundle of the workspace, complete.
      git(work, 'bundle', 'create', '--quiet', join(extra, 'all.bundle'), '--all');
      git(
        extra,
        'clone',
        '--quiet',
        '--bare',
        join(extra, 'all.bundle'),
        join(extra, 'seeded.git'),
      );
      await rm(extra, { force: true, recursive: true });
    });

    it('the branch the import named is the workspace’s branch, not a detached head', async () => {
      await runImport();

      expect(git(work, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
      expect(sandbox.commands).toContain('git branch -f main FETCH_HEAD');
      // The bundle does not outlive the checkout.
      expect(spawnSync('test', ['-e', join(work, '.git', 'forge-import.bundle')]).status).not.toBe(
        0,
      );
    });

    it('one baseline checkpoint at the cloned sha, sync_operation_id set and actor_id null', async () => {
      const operation = await runImport();
      const project = await importedProject();

      const rows = await harness.inTenant((tx) =>
        tx.select().from(schema.checkpoints).where(eq(schema.checkpoints.projectId, project!.id)),
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorId: null,
        gitSha: headSha,
        kind: 'baseline',
        parentId: null,
        syncOperationId: operation.id,
      });
    });

    it('the link reads level: both positions at the cloned commit (SC-003)', async () => {
      await runImport();
      const project = await importedProject();

      const [link] = await harness.inTenant((tx) =>
        tx.select().from(schema.repoLinks).where(eq(schema.repoLinks.projectId, project!.id)),
      );
      const [checkpoint] = await harness.inTenant((tx) =>
        tx.select().from(schema.checkpoints).where(eq(schema.checkpoints.projectId, project!.id)),
      );

      expect(link).toMatchObject({
        lastPushedCheckpointId: checkpoint!.id,
        remoteHeadSha: headSha,
        state: 'linked',
      });
    });

    /**
     * US5 / quickstart § 4: the same four assertions at each of the three points an import can
     * fail — before the sandbox, during the clone, and after the clone before the checkpoint.
     * The point of driving all three rather than one is that the cleanup path is one path
     * (T070): whichever leg died, the project is soft-deleted, the sandbox is released, the link
     * is gone, and exactly one `failed` operation carries the reason.
     */
    describe('a failure at each of the three points leaves nothing behind (US5, FR-007)', () => {
      /** Everything the workspace could be left holding, read back under the tenant. */
      async function debris(): Promise<{
        archived: number;
        links: number;
        operations: { reason: string | null; state: string }[];
        visibleProjects: number;
        withdrawn: number;
      }> {
        return harness.inTenant(async (tx) => {
          const projects = await tx
            .select({ deletedAt: schema.projects.deletedAt, id: schema.projects.id })
            .from(schema.projects)
            .where(
              and(
                eq(schema.projects.orgId, harness.orgId),
                ne(schema.projects.id, harness.projectId),
              ),
            );
          const links = await tx
            .select({ id: schema.repoLinks.id })
            .from(schema.repoLinks)
            .where(eq(schema.repoLinks.orgId, harness.orgId));
          const operations = await tx
            .select({
              reason: schema.syncOperations.reason,
              state: schema.syncOperations.state,
            })
            .from(schema.syncOperations)
            .where(eq(schema.syncOperations.orgId, harness.orgId));
          // Spec 014 releases a sandbox off `project.archived`; the event being written for this
          // project *is* the release, and it is what "the sandbox is released" can be asserted on
          // without booting 014's consumer inside a connectors spec.
          const archived = await tx
            .select({ id: schema.outbox.id })
            .from(schema.outbox)
            .where(
              and(
                eq(schema.outbox.type, 'project.archived'),
                eq(schema.outbox.aggregateId, projects[0]?.id ?? ''),
              ),
            );

          return {
            archived: archived.length,
            links: links.length,
            operations,
            visibleProjects: projects.filter((row) => row.deletedAt === null).length,
            withdrawn: projects.filter((row) => row.deletedAt !== null).length,
          };
        });
      }

      it('before the sandbox: the workspace never becomes ready (timed-out)', async () => {
        ensureReady.mockResolvedValue({ because: 'creating', ready: false });

        // The last attempt, which is where a transient failure stops being retried and becomes
        // the row's reason.
        const operation = await runImport({ attempt: 3 });

        expect(operation).toMatchObject({ reason: 'timed-out', state: 'failed' });
        expect(await debris()).toMatchObject({
          archived: 1,
          links: 0,
          operations: [{ reason: 'timed-out', state: 'failed' }],
          visibleProjects: 0,
          withdrawn: 1,
        });
      });

      it('during the clone: the repository is not there to clone (git-failed)', async () => {
        const operation = await runImport({
          // The remote the runner will build its clone URL from, pointed at nothing. The failure
          // is the worker's own git, on the leg before the sandbox is ever addressed.
          mutate: (projectId) =>
            harness.inTenant(async (tx) => {
              await tx
                .update(schema.repoLinks)
                .set({ name: 'not-a-repository' })
                .where(eq(schema.repoLinks.projectId, projectId));
            }),
        });

        expect(operation).toMatchObject({ reason: 'git-failed', state: 'failed' });
        expect(await debris()).toMatchObject({
          archived: 1,
          links: 0,
          operations: [{ reason: 'git-failed', state: 'failed' }],
          visibleProjects: 0,
          withdrawn: 1,
        });
        // The sandbox was never touched: the failure is upstream of it.
        expect(sandbox.commands).toEqual([]);
      });

      it('after the clone, before the checkpoint: the checkout is refused (import-checkout-failed)', async () => {
        const broken = vi
          .spyOn(sandbox, 'exec')
          .mockImplementation((ref: unknown, command: string) =>
            command.startsWith('git checkout')
              ? Promise.resolve({
                  exitCode: 128,
                  output: 'fatal: cut here\n',
                  timedOut: false,
                  truncated: false,
                })
              : DiskSandbox.prototype.exec.call(sandbox, ref, command),
          );

        const operation = await runImport();

        expect(operation).toMatchObject({ reason: 'import-checkout-failed', state: 'failed' });
        expect(await debris()).toMatchObject({
          archived: 1,
          links: 0,
          operations: [{ reason: 'import-checkout-failed', state: 'failed' }],
          visibleProjects: 0,
          withdrawn: 1,
        });
        // No checkpoint was written: the failure is before the point the repository is seeded.
        const checkpoints = await harness.inTenant((tx) =>
          tx.select({ id: schema.checkpoints.id }).from(schema.checkpoints),
        );
        expect(checkpoints).toEqual([]);
        broken.mockRestore();
      });

      /**
       * The claim of a warm-pool sandbox is written by `ensureReady` in the transaction it is
       * given. A failed step after the sandbox was touched must not roll it back: that returned the
       * half-imported container to the pool as `ready`, and the next project created on the
       * template inherited a commit-less `.git` without a `.gitignore` (incident: its baseline
       * `git add -A` staged `node_modules` and timed out, failing every run as `checkpoint`).
       */
      it('a failed checkout keeps the sandbox claim it made committed', async () => {
        // What a pool claim leaves in the caller's transaction, observable once the import is over.
        ensureReady.mockImplementation(async (tx: TenantTransaction) => {
          await tx.insert(schema.auditLog).values({
            action: 'sandbox.claimed',
            orgId: harness.orgId,
            target: randomUUID(),
          });
          return { ready: true };
        });
        const broken = vi
          .spyOn(sandbox, 'exec')
          .mockImplementation((ref: unknown, command: string) =>
            command.startsWith('git checkout')
              ? Promise.resolve({
                  exitCode: 128,
                  output: 'fatal: cut here\n',
                  timedOut: false,
                  truncated: false,
                })
              : DiskSandbox.prototype.exec.call(sandbox, ref, command),
          );

        const operation = await runImport();
        broken.mockRestore();

        expect(operation).toMatchObject({ reason: 'import-checkout-failed', state: 'failed' });
        // The claim's write outlived the failed step: the release can find and destroy the sandbox.
        expect(await harness.auditActions()).toContain('sandbox.claimed');
      });

      /**
       * FR-020 / T072: a clone the sandbox cannot represent. The port refuses the bundle, the
       * failure carries spec 018's own `bundle-too-large` rather than a new reason (T071), the
       * path is named on the trail, and — because nothing had been removed yet — the workspace is
       * left exactly as the warm pool prepared it.
       */
      it('a bundle the port refuses names the path and leaves the workspace alone (FR-020)', async () => {
        const refused = vi.spyOn(sandbox, 'upload').mockRejectedValue(
          new SandboxGuardError('bundle-too-large', 'The bundle exceeds the cap.', {
            bytes: 1,
            cap: 0,
          }),
        );

        const operation = await runImport();

        expect(operation).toMatchObject({ reason: 'bundle-too-large', state: 'failed' });
        expect(await debris()).toMatchObject({ links: 0, visibleProjects: 0, withdrawn: 1 });

        // The path the sandbox could not take, on this project's failure entry.
        const project = await importedProject();
        const [failed] = await harness.inTenant((tx) =>
          tx
            .select({ action: schema.auditLog.action, metadata: schema.auditLog.metadata })
            .from(schema.auditLog)
            .where(
              and(
                eq(schema.auditLog.orgId, harness.orgId),
                eq(schema.auditLog.action, 'import.failed'),
                eq(schema.auditLog.target, project!.id),
              ),
            ),
        );
        expect(failed?.metadata).toMatchObject({
          path: IMPORT_BUNDLE_PATH,
          reason: 'bundle-too-large',
        });

        // The workspace is at its previous state: the starter file the import would have removed
        // is still there, and nothing was checked out over it.
        expect(spawnSync('test', ['-e', join(work, 'src', 'App.tsx')]).status).toBe(0);
        expect(spawnSync('test', ['-e', join(work, 'README.md')]).status).not.toBe(0);
        refused.mockRestore();
      });

      /**
       * T070's idempotency, stated directly: a retry that meets a half-cleaned attempt must not
       * throw, must not archive twice and must not write a second `import.failed`.
       */
      it('the cleanup runs twice without a second withdrawal or a second audit entry', async () => {
        const broken = vi
          .spyOn(sandbox, 'exec')
          .mockImplementation((ref: unknown, command: string) =>
            command.startsWith('git checkout')
              ? Promise.resolve({
                  exitCode: 128,
                  output: 'fatal: cut here\n',
                  timedOut: false,
                  truncated: false,
                })
              : DiskSandbox.prototype.exec.call(sandbox, ref, command),
          );
        const operation = await runImport();
        broken.mockRestore();

        const project = await importedProject();
        await harness.inTenantScope((tx) =>
          imports.withdraw(tx, {
            actorId: harness.userId,
            branch: 'main',
            finishedAt: new Date(),
            linkId: null,
            operationId: operation.id,
            orgId: harness.orgId,
            projectId: project!.id,
            reason: 'import-checkout-failed',
            repository: 'acme/site',
          }),
        );

        const after = await debris();
        expect(after).toMatchObject({
          archived: 1,
          links: 0,
          operations: [{ reason: 'import-checkout-failed', state: 'failed' }],
          visibleProjects: 0,
          withdrawn: 1,
        });
        expect((await harness.auditActions()).filter((a) => a === 'import.failed')).toHaveLength(1);
      });
    });

    it('a failed checkout withdraws the project and keeps the operation readable (R2, FR-007)', async () => {
      // The workspace refuses the checkout: a file the clone must write is a directory in the way.
      const broken = vi
        .spyOn(sandbox, 'exec')
        .mockImplementation((ref: unknown, command: string) =>
          command.startsWith('git checkout')
            ? Promise.resolve({
                exitCode: 128,
                output: 'fatal: cut here\n',
                timedOut: false,
                truncated: false,
              })
            : DiskSandbox.prototype.exec.call(sandbox, ref, command),
        );

      const operation = await runImport();

      expect(operation).toMatchObject({ reason: 'import-checkout-failed', state: 'failed' });
      const [project] = await harness.inTenant((tx) =>
        tx
          .select({ deletedAt: schema.projects.deletedAt })
          .from(schema.projects)
          .where(
            and(
              eq(schema.projects.orgId, harness.orgId),
              ne(schema.projects.id, harness.projectId),
            ),
          ),
      );
      expect(project?.deletedAt).not.toBeNull();
      expect(await harness.auditActions()).toContain('import.failed');
      broken.mockRestore();
    });

    it('audits the import as succeeded, naming the repository and the branch (FR-009)', async () => {
      await runImport();

      expect(await harness.auditActions()).toEqual(
        expect.arrayContaining(['import.requested', 'import.succeeded']),
      );
    });
  });
});
