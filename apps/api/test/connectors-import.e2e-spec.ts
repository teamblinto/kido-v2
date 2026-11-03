import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  checkpointListResponseSchema,
  inspectImportResponseSchema,
  type SyncOperation,
  syncOperationSchema,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { eq } from 'drizzle-orm';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import { MAX_IMPORT_REPOSITORY_KIB } from '../src/modules/connectors/import.service';
import { SANDBOX_LIFECYCLE } from '../src/modules/sandbox/sandbox-lifecycle';
import { type ExecResult, SANDBOX_PORT } from '../src/modules/sandbox/sandbox.port';
import { type GithubFixture, startGithubFixture } from './fixtures/github-fixture';
import { unsafe } from './support/csrf-client';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  http,
  type Principal,
  signUpAndIn,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

/** As `connectors.e2e-spec.ts`: `AppModule` reads the environment on load, so it is settled here. */
const FIXTURE = vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.THROTTLE_LIMIT = '100000';
  // `events` so this process drains `connector.sync` itself — the import runs here.
  process.env.RUN_PROFILES = 'api,events';

  const port = 20_000 + Math.floor(Math.random() * 20_000);
  process.env.GITHUB_API_URL = `http://127.0.0.1:${String(port)}`;
  process.env.GITHUB_INSTALL_URL = process.env.GITHUB_API_URL;
  process.env.GITHUB_APP_ID = '1';
  process.env.GITHUB_APP_CLIENT_ID = 'Iv1.example';
  process.env.GITHUB_APP_SLUG = 'forge-local';
  const { readFileSync } = process.getBuiltinModule('node:fs');
  const { join: joinPath } = process.getBuiltinModule('node:path');
  process.env.GITHUB_APP_PRIVATE_KEY = /^# GITHUB_APP_PRIVATE_KEY="(.+)"$/m
    .exec(readFileSync(joinPath(__dirname, '../.env.example'), 'utf8'))![1]!
    .replaceAll('\\n', '\n');

  return { port };
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const INSTALLATION_ID = 7301;
const REPO_ID = 940;
/** Quickstart § 3: a repository matching none of the four (US2). */
const GO_REPO_ID = 941;
const IMPORT_TIMEOUT_MS = 30_000;

let gitOnPath = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitOnPath = false;
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_EMAIL: 'forge@example.test',
  GIT_AUTHOR_NAME: 'forge',
  GIT_COMMITTER_EMAIL: 'forge@example.test',
  GIT_COMMITTER_NAME: 'forge',
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();

/**
 * The `node-api` definition's own file list, read from the catalogue's directory — the same list
 * `templateDigest` is computed over and the same one `import.runner.ts` removes (R5). Read rather
 * than written out, so the FR-014 assertion cannot drift from the template it is about.
 */
const NODE_API_FILES = join(__dirname, '../templates/node-api/files');
const NODE_API_STARTER = execFileSync('find', [NODE_API_FILES, '-type', 'f'], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .map((absolute) => absolute.slice(NODE_API_FILES.length + 1))
  .sort();

const exists = (path: string): boolean => spawnSync('test', ['-e', path]).status === 0;

async function until(predicate: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

/**
 * The sandbox as a real git repository on disk. `startFakeDaytona` scripts git rather than running
 * it, and quickstart § 2's assertions are about a tree that a real `git checkout` produced — so the
 * port is bound to a workspace on disk here, the way `pull.consumer.spec.ts` binds it.
 */
class DiskSandbox {
  dir = '';

  exec(_ref: unknown, command: string): Promise<ExecResult> {
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

  /** The push and pull that follow read the mirror bundle back through the port. */
  download(_ref: unknown, path: string): Promise<Buffer> {
    return readFile(join(this.dir, path));
  }
}

/**
 * Quickstart § 2 end to end over HTTP: connect, inspect, import, poll to `succeeded`, then the
 * workspace, the single baseline checkpoint with its provenance, the level link — and a push and a
 * pull straight afterwards, each carrying zero commits **with no new code on either path** (SC-003).
 */
describe('Connector import (e2e)', () => {
  describe.skipIf(!postgres || !redis || !gitOnPath)(
    'against Postgres, Redis and the fixture',
    () => {
      let app: INestApplication;
      let fixture: GithubFixture;
      let world: TwoTenantWorld;
      let transactions: TenantTransactionRunner;
      let member: Principal;
      let suiteLock: { release: () => Promise<void> } | undefined;
      let work: string;
      let goWork: string;
      let headSha: string;
      let goHeadSha: string;
      let projectId: string;
      const sandbox = new DiskSandbox();

      const connectors = () => `/api/v1/orgs/${world.alpha.orgId}/connectors`;
      const imports = () =>
        `/api/v1/orgs/${world.alpha.orgId}/workspaces/${world.alpha.workspaceId}/imports`;
      const sync = () => `/api/v1/orgs/${world.alpha.orgId}/projects/${projectId}/sync`;
      const cookie = () => world.alpha.owner.cookie;

      /** Operations are read under the project they belong to, so the walk names it explicitly. */
      async function settledFor(project: string, id: string): Promise<SyncOperation> {
        const base = `/api/v1/orgs/${world.alpha.orgId}/projects/${project}/sync`;
        let operation: SyncOperation | undefined;
        expect(
          await until(async () => {
            const polled = await http(app).get(`${base}/${id}`).set('Cookie', cookie());
            operation = syncOperationSchema.parse(polled.body);

            return operation.state === 'succeeded' || operation.state === 'failed';
          }, IMPORT_TIMEOUT_MS),
        ).toBe(true);

        return operation!;
      }

      const settled = (id: string): Promise<SyncOperation> => settledFor(projectId, id);

      /**
       * The operation's terminal row, read from the database rather than the API: a failed import
       * withdraws its project, and the operation's route lives under that project — so the only
       * place a *failed* import's own row can still be read is the table it is in.
       */
      async function settledRow(id: string): Promise<{ reason: string | null; state: string }> {
        let row: { reason: string | null; state: string } | undefined;
        expect(
          await until(async () => {
            [row] = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
              tx
                .select({
                  reason: schema.syncOperations.reason,
                  state: schema.syncOperations.state,
                })
                .from(schema.syncOperations)
                .where(eq(schema.syncOperations.id, id)),
            );

            return row?.state === 'succeeded' || row?.state === 'failed';
          }, IMPORT_TIMEOUT_MS),
        ).toBe(true);

        return row!;
      }

      /** How many projects of that name exist at all — a refusal must leave zero. */
      const projectNamed = async (name: string): Promise<number> =>
        (
          await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
            tx
              .select({ id: schema.projects.id })
              .from(schema.projects)
              .where(eq(schema.projects.name, name)),
          )
        ).length;

      beforeAll(async () => {
        suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
        fixture = await startGithubFixture({ git: true, port: FIXTURE.port });
        fixture.installations.set(INSTALLATION_ID, {
          account: { id: 9301, login: 'acme', type: 'Organization' },
          id: INSTALLATION_ID,
        });

        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(SANDBOX_PORT)
          .useValue(sandbox)
          .overrideProvider(SANDBOX_LIFECYCLE)
          .useValue({
            ensureReady: () => Promise.resolve({ ready: true }),
            touch: () => Promise.resolve(),
          })
          .compile();
        app = moduleRef.createNestApplication();
        configureApplication(app);
        await app.init();

        transactions = app.get(TenantTransactionRunner);
        world = await createTwoTenantWorld(app);
        member = await signUpAndIn(app, 'member');
        await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx.insert(schema.memberships).values({
            acceptedAt: new Date(),
            orgId: world.alpha.orgId,
            role: 'member',
            userId: member.userId,
          }),
        );

        // The repository to import: quickstart § 2's Vite + React tree.
        fixture.repositories.set(REPO_ID, {
          branches: {},
          default_branch: 'main',
          full_name: 'acme/site',
          id: REPO_ID,
          name: 'site',
          owner: { login: 'acme' },
          private: false,
        });
        headSha = await fixture.seedRepo(fixture.repositories.get(REPO_ID)!, {
          'README.md': '# imported\n',
          'package.json': JSON.stringify({ dependencies: { react: '19' } }),
          'src/main.tsx': 'export const main = 1;\n',
          'vite.config.ts': 'export default {};\n',
        });

        // Quickstart § 3's repository: `go.mod` and nothing else any rule of R3 looks at.
        fixture.repositories.set(GO_REPO_ID, {
          branches: {},
          default_branch: 'main',
          full_name: 'acme/goodbye',
          id: GO_REPO_ID,
          name: 'goodbye',
          owner: { login: 'acme' },
          private: false,
        });
        goHeadSha = await fixture.seedRepo(fixture.repositories.get(GO_REPO_ID)!, {
          'go.mod': 'module example.com/goodbye\n\ngo 1.23\n',
          'main.go': 'package main\n\nfunc main() {}\n',
        });

        // The sandbox the import lands in: the prepared layer, with the template's starter files.
        work = await mkdtemp(join(tmpdir(), 'forge-import-e2e-'));
        sandbox.dir = work;
        await mkdir(join(work, 'node_modules', 'react'), { recursive: true });
        await writeFile(join(work, 'node_modules', 'react', 'index.js'), 'module.exports = {};\n');
        await mkdir(join(work, 'src'), { recursive: true });
        await writeFile(join(work, 'src', 'App.tsx'), 'export default function App() {}\n');

        // The second sandbox, prepared as `node-api` — the template quickstart § 3 overrides onto a
        // Go repository. Its starter files are copied from the catalogue's own definition rather
        // than retyped, so the FR-014/FR-018 assertion below is about the files the build ships.
        goWork = await mkdtemp(join(tmpdir(), 'forge-import-e2e-go-'));
        await mkdir(join(goWork, 'node_modules', 'express'), { recursive: true });
        await writeFile(
          join(goWork, 'node_modules', 'express', 'index.js'),
          'module.exports = {};\n',
        );
        for (const relative of NODE_API_STARTER) {
          await mkdir(join(goWork, relative, '..'), { recursive: true });
          await writeFile(join(goWork, relative), await readFile(join(NODE_API_FILES, relative)));
        }
      }, 600_000);

      afterAll(async () => {
        if (world) await destroyTwoTenantWorld(app, world);
        if (member) {
          await app
            .get<ForgeDatabase>(APP_DATABASE)
            .delete(schema.users)
            .where(eq(schema.users.email, member.email));
        }
        await app?.close();
        await fixture?.close();
        await suiteLock?.release();
        if (work) await rm(work, { force: true, recursive: true });
        if (goWork) await rm(goWork, { force: true, recursive: true });
      });

      it('1. the organisation connects, exactly as spec 018 does it (SC-014)', async () => {
        const started = await unsafe(http(app).post(`${connectors()}/github/install`), [
          cookie(),
        ]).expect(200);
        const state = new URL((started.body as { installUrl: string }).installUrl).searchParams.get(
          'state',
        );

        await unsafe(http(app).post(`${connectors()}/github/complete`), [cookie()])
          .send({ installationId: INSTALLATION_ID, state })
          .expect(201);
      });

      it('2. inspect proposes one template, with the evidence that proposed it', async () => {
        const response = await unsafe(http(app).post(`${imports()}/inspect`), [cookie()])
          .send({ repoId: REPO_ID })
          .expect(200);

        expect(inspectImportResponseSchema.parse(response.body)).toMatchObject({
          branch: 'main',
          candidates: [
            { evidence: ['vite.config.ts', 'dependency: react'], template: 'vite-react' },
          ],
          empty: false,
          headSha,
          outcome: 'proposed',
          repo: { id: REPO_ID, name: 'site', owner: 'acme' },
        });
      });

      it('a member without the workspace’s project-create permission is refused (FR-008)', async () => {
        const refused = await unsafe(http(app).post(`${imports()}/inspect`), [member.cookie])
          .send({ repoId: REPO_ID })
          .expect(403);

        expect(refused.body).toMatchObject({
          type: 'https://forge.dev/problems/permission-denied',
        });
      });

      it('an undeclared key is refused: every request schema is a strict object', async () => {
        await unsafe(http(app).post(`${imports()}/inspect`), [cookie()])
          .send({ repoId: REPO_ID, sneaky: true })
          .expect(422);
      });

      it('3–4. the import is accepted as kind: import and polls to succeeded', async () => {
        const accepted = await unsafe(http(app).post(imports()), [cookie()])
          .send({ branch: 'main', name: 'Imported site', repoId: REPO_ID, template: 'vite-react' })
          .expect(202);

        const queued = syncOperationSchema.parse(accepted.body);
        expect(queued).toMatchObject({ kind: 'import', state: 'queued' });
        // Contracts § 2: the project the client navigates to while the import runs.
        projectId = queued.projectId;
        expect(projectId).toEqual(expect.any(String));

        expect(await settled(queued.id)).toMatchObject({
          commits: 1,
          kind: 'import',
          reason: null,
          state: 'succeeded',
          toSha: headSha,
        });
      }, 60_000);

      it('the workspace is the repository at the cloned sha, over a surviving node_modules', () => {
        expect(git(work, 'rev-parse', 'HEAD')).toBe(headSha);
        expect(git(work, 'ls-files').split('\n').sort()).toEqual([
          'README.md',
          'package.json',
          'src/main.tsx',
          'vite.config.ts',
        ]);
        // SC-002 / FR-018: no starter file the user did not write.
        expect(exists(join(work, 'src', 'App.tsx'))).toBe(false);
        // R5: the prepared dependency layer is the point of the warm pool, and it is still there.
        expect(exists(join(work, 'node_modules', 'react', 'index.js'))).toBe(true);
      });

      it('exactly one checkpoint: a baseline at the cloned sha with its provenance (data-model § 4)', async () => {
        const listed = await http(app)
          .get(`/api/v1/orgs/${world.alpha.orgId}/projects/${projectId}/checkpoints`)
          .set('Cookie', cookie())
          .expect(200);

        const { items } = checkpointListResponseSchema.parse(listed.body);
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ gitSha: headSha, kind: 'baseline' });

        const rows = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx.select().from(schema.checkpoints).where(eq(schema.checkpoints.projectId, projectId)),
        );
        expect(rows[0]).toMatchObject({ actorId: null, parentId: null });
        expect(rows[0]?.syncOperationId).not.toBeNull();
      });

      it('the link reads level: both positions at the cloned commit', async () => {
        const [link] = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx.select().from(schema.repoLinks).where(eq(schema.repoLinks.projectId, projectId)),
        );
        const [checkpoint] = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx.select().from(schema.checkpoints).where(eq(schema.checkpoints.projectId, projectId)),
        );

        expect(link).toMatchObject({
          branch: 'main',
          lastPushedCheckpointId: checkpoint!.id,
          remoteHeadSha: headSha,
          state: 'linked',
        });
      });

      it('SC-003: an immediate push carries commits: 0, with no new code on the push path', async () => {
        const accepted = await unsafe(http(app).post(`${sync()}/push`), [cookie()]).expect(202);

        expect(await settled(syncOperationSchema.parse(accepted.body).id)).toMatchObject({
          commits: 0,
          kind: 'push',
          reason: null,
          state: 'succeeded',
          toSha: headSha,
        });
      }, 60_000);

      it('and an immediate pull carries commits: 0 as well', async () => {
        const accepted = await unsafe(http(app).post(`${sync()}/pull`), [cookie()]).expect(202);

        expect(await settled(syncOperationSchema.parse(accepted.body).id)).toMatchObject({
          commits: 0,
          kind: 'pull',
          reason: null,
          state: 'succeeded',
        });
      }, 60_000);

      it('FR-009: the trail names the import, requested and succeeded', async () => {
        const rows = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx
            .select({ action: schema.auditLog.action })
            .from(schema.auditLog)
            .where(eq(schema.auditLog.orgId, world.alpha.orgId)),
        );
        const actions = rows.map((row) => row.action);

        expect(actions).toContain('import.requested');
        expect(actions).toContain('import.succeeded');
      });

      /**
       * Quickstart § 3 (US2): a repository matching none of the four. Nothing is proposed, nothing
       * may be substituted on the wire, and the template the user picks contributes the runtime and
       * **not one file** (FR-011, FR-014, FR-016, FR-018).
       */
      describe('quickstart § 3: a repository matching none of the four', () => {
        let goProjectId: string;

        it('inspect answers unrecognised with an empty array — no default is returned (FR-011)', async () => {
          const response = await unsafe(http(app).post(`${imports()}/inspect`), [cookie()])
            .send({ repoId: GO_REPO_ID })
            .expect(200);

          const inspection = inspectImportResponseSchema.parse(response.body);

          expect(inspection).toMatchObject({
            branch: 'main',
            empty: false,
            headSha: goHeadSha,
            outcome: 'unrecognised',
            repo: { id: GO_REPO_ID, name: 'goodbye', owner: 'acme' },
          });
          // The whole of FR-011 on the wire: nothing for the UI to pre-select, nothing to confirm
          // by accident. `toEqual([])` rather than a length check — a `node-api` fallback would
          // have exactly one element and read as "proposed" to anything that only counted.
          expect(inspection.candidates).toEqual([]);
        });

        it('starting without a template is a 422, not a server-side choice (FR-011)', async () => {
          const refused = await unsafe(http(app).post(imports()), [cookie()])
            .send({ branch: 'main', name: 'Goodbye', repoId: GO_REPO_ID })
            .expect(422);

          expect(refused.body).toMatchObject({
            type: 'https://forge.dev/problems/validation-failed',
          });

          // And nothing was created on the way to refusing it.
          const projects = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
            tx
              .select({ name: schema.projects.name })
              .from(schema.projects)
              .where(eq(schema.projects.orgId, world.alpha.orgId)),
          );
          expect(projects.map((row) => row.name)).not.toContain('Goodbye');
        });

        it('an explicit override runs: the Go repository is imported onto node-api', async () => {
          sandbox.dir = goWork;

          const accepted = await unsafe(http(app).post(imports()), [cookie()])
            .send({ branch: 'main', name: 'Goodbye', repoId: GO_REPO_ID, template: 'node-api' })
            .expect(202);

          const queued = syncOperationSchema.parse(accepted.body);
          goProjectId = queued.projectId;

          // FR-016: the disagreement does not fail the import.
          expect(await settledFor(goProjectId, queued.id)).toMatchObject({
            commits: 1,
            kind: 'import',
            reason: null,
            state: 'succeeded',
            toSha: goHeadSha,
          });
        }, 60_000);

        it('the workspace holds the Go files and no file of the chosen template (FR-014, FR-018)', () => {
          expect(git(goWork, 'rev-parse', 'HEAD')).toBe(goHeadSha);
          expect(git(goWork, 'ls-files').split('\n').sort()).toEqual(['go.mod', 'main.go']);

          // The removal set is the catalogue's own list (R5), so this reads every file the chosen
          // template's definition ships — the starter contributes the runtime, never a file.
          for (const relative of NODE_API_STARTER) {
            expect({ [relative]: exists(join(goWork, relative)) }).toEqual({ [relative]: false });
          }
          // R5 again, from the other side: the prepared dependency layer was never in that list.
          expect(exists(join(goWork, 'node_modules', 'express', 'index.js'))).toBe(true);
        });

        it('the project carries the mismatch, and it is a line rather than a failure (FR-016)', async () => {
          const read = await http(app)
            .get(`/api/v1/orgs/${world.alpha.orgId}/projects/${goProjectId}/import-mismatch`)
            .set('Cookie', cookie())
            .expect(200);

          // `node-api` on a repository with no `package.json` at all: detected is what inspect says
          // now, which for a Go tree is nothing — so there is nothing to disagree with, and the
          // contract's own rule makes that null rather than a warning nobody can act on.
          expect(read.body).toEqual({ templateMismatch: null });
        });

        it('a template the repository does contradict is reported on the panel (contracts § 4)', async () => {
          const accepted = await unsafe(http(app).post(imports()), [cookie()])
            .send({ branch: 'main', name: 'Contradicted', repoId: REPO_ID, template: 'python' })
            .expect(202);

          const { projectId: contradicted } = syncOperationSchema.parse(accepted.body);
          const read = await http(app)
            .get(`/api/v1/orgs/${world.alpha.orgId}/projects/${contradicted}/import-mismatch`)
            .set('Cookie', cookie())
            .expect(200);

          expect(read.body).toEqual({
            templateMismatch: { chosen: 'python', detected: ['vite-react'] },
          });
        });
      });

      /**
       * Quickstart § 4 (US5) over HTTP: the import fails on the worker, and every one of the four
       * lines of the § 4 table is read back from the API and the database — no project visible,
       * the sandbox released, no link, and one `failed` operation carrying the reason.
       */
      describe('quickstart § 4: a failed import leaves nothing', () => {
        let failWork: string;
        let failed: { reason: string | null; state: string };
        let failedProject: string;

        beforeAll(async () => {
          failWork = await mkdtemp(join(tmpdir(), 'forge-import-e2e-fail-'));
          await mkdir(join(failWork, 'node_modules', 'react'), { recursive: true });
          await writeFile(
            join(failWork, 'node_modules', 'react', 'index.js'),
            'module.exports = {};\n',
          );
          await mkdir(join(failWork, 'src'), { recursive: true });
          await writeFile(join(failWork, 'src', 'App.tsx'), 'export default function App() {}\n');

          const previous = sandbox.dir;
          sandbox.dir = failWork;
          // The workspace refuses the checkout — the failure point after the clone and before the
          // checkpoint, which is the one that has already created a project and a link.
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

          const accepted = await unsafe(http(app).post(imports()), [cookie()])
            .send({ branch: 'main', name: 'Doomed', repoId: REPO_ID, template: 'vite-react' })
            .expect(202);
          const queued = syncOperationSchema.parse(accepted.body);
          failedProject = queued.projectId;
          failed = await settledRow(queued.id);
          broken.mockRestore();
          sandbox.dir = previous;
        }, 90_000);

        afterAll(async () => {
          if (failWork) await rm(failWork, { force: true, recursive: true });
        });

        it('the operation is one failed row naming a classified reason', async () => {
          expect(failed.state).toBe('failed');
          expect(failed.reason).toBe('import-checkout-failed');

          const operations = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
            tx
              .select({ state: schema.syncOperations.state })
              .from(schema.syncOperations)
              .where(eq(schema.syncOperations.projectId, failedProject)),
          );
          expect(operations).toEqual([{ state: 'failed' }]);
        });

        it('the project is not visible in the workspace, and is soft-deleted (R2, FR-007)', async () => {
          const listed = await http(app)
            .get(`/api/v1/orgs/${world.alpha.orgId}/projects`)
            .set('Cookie', cookie())
            .expect(200);

          expect(JSON.stringify(listed.body)).not.toContain(failedProject);

          const [row] = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
            tx
              .select({ deletedAt: schema.projects.deletedAt })
              .from(schema.projects)
              .where(eq(schema.projects.id, failedProject)),
          );
          expect(row?.deletedAt).not.toBeNull();
        });

        it('no link is left, and the sandbox is released through project.archived', async () => {
          const links = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
            tx
              .select({ id: schema.repoLinks.id })
              .from(schema.repoLinks)
              .where(eq(schema.repoLinks.projectId, failedProject)),
          );
          expect(links).toEqual([]);

          // Spec 014 releases the sandbox off this event; its presence is the release.
          const released = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
            tx
              .select({ type: schema.outbox.type })
              .from(schema.outbox)
              .where(eq(schema.outbox.aggregateId, failedProject)),
          );
          expect(released.map((row) => row.type)).toContain('project.archived');
        });

        it('the trail names the failure with its reason (FR-009)', async () => {
          const rows = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
            tx
              .select({ action: schema.auditLog.action, metadata: schema.auditLog.metadata })
              .from(schema.auditLog)
              .where(eq(schema.auditLog.target, failedProject)),
          );

          expect(rows.map((row) => row.action)).toContain('import.failed');
          expect(rows.find((row) => row.action === 'import.failed')?.metadata).toMatchObject({
            reason: 'import-checkout-failed',
            repository: 'acme/site',
          });
        });

        /** The three cheap refusals on the wire, each leaving zero rows of every kind. */
        it('an empty branch is refused 409 import-empty-repo, and nothing is created', async () => {
          const empty = 942;
          fixture.repositories.set(empty, {
            branches: {},
            default_branch: 'main',
            full_name: 'acme/blank',
            id: empty,
            name: 'blank',
            owner: { login: 'acme' },
            private: false,
          });

          const refused = await unsafe(http(app).post(imports()), [cookie()])
            .send({ branch: 'main', name: 'Blank', repoId: empty, template: 'vite-react' })
            .expect(409);

          expect(refused.body).toMatchObject({
            type: 'https://forge.dev/problems/import-empty-repo',
          });
          await expect(projectNamed('Blank')).resolves.toBe(0);
        });

        it('an oversized repository is refused 409, and the problem names the limit (FR-008)', async () => {
          const huge = 943;
          fixture.repositories.set(huge, {
            branches: { main: headSha },
            default_branch: 'main',
            full_name: 'acme/huge',
            id: huge,
            name: 'huge',
            owner: { login: 'acme' },
            private: false,
            size: MAX_IMPORT_REPOSITORY_KIB + 1,
          });

          const refused = await unsafe(http(app).post(imports()), [cookie()])
            .send({ branch: 'main', name: 'Huge', repoId: huge, template: 'vite-react' })
            .expect(409);

          expect(refused.body).toMatchObject({
            limitKib: MAX_IMPORT_REPOSITORY_KIB,
            type: 'https://forge.dev/problems/import-repo-too-large',
          });
          expect((refused.body as { detail: string }).detail).toContain(
            String(MAX_IMPORT_REPOSITORY_KIB),
          );
          await expect(projectNamed('Huge')).resolves.toBe(0);
        });

        it('a branch that vanished is refused 404 import-branch-not-found, and nothing is created', async () => {
          const refused = await unsafe(http(app).post(imports()), [cookie()])
            .send({ branch: 'gone', name: 'Vanished', repoId: REPO_ID, template: 'vite-react' })
            .expect(404);

          expect(refused.body).toMatchObject({
            type: 'https://forge.dev/problems/import-branch-not-found',
          });
          await expect(projectNamed('Vanished')).resolves.toBe(0);
        });
      });

      it('a second import of the same repository is a second project, not a conflict', async () => {
        const accepted = await unsafe(http(app).post(imports()), [cookie()])
          .send({ branch: 'main', name: 'Imported twice', repoId: REPO_ID, template: 'vite-react' })
          .expect(202);

        expect(syncOperationSchema.parse(accepted.body).projectId).not.toBe(projectId);
      });

      /**
       * US5 acceptance 4 / quickstart § 4: two imports of the same repository at the same time.
       * The rule is not that both succeed — it is that the two never collapse onto one project.
       * Each import creates its own project before it queues anything, and the one-in-flight index
       * is per project, so either both are accepted as two projects or the second is refused
       * `operation-in-flight`; what cannot happen is one project with two imports claiming a
       * sandbox each.
       */
      it('two imports of the same repository at once are two projects, never one (US5)', async () => {
        const send = () =>
          unsafe(http(app).post(imports()), [cookie()]).send({
            branch: 'main',
            name: 'Raced',
            repoId: REPO_ID,
            template: 'vite-react',
          });
        const [first, second] = await Promise.all([send(), send()]);

        const accepted = [first, second].filter((response) => response.status === 202);
        const refused = [first, second].filter((response) => response.status !== 202);

        // Either outcome the spec allows, and nothing else.
        expect(accepted.length + refused.length).toBe(2);
        for (const response of refused) {
          expect(response.status).toBe(409);
          expect(response.body).toMatchObject({ reason: 'operation-in-flight' });
        }

        const projects = accepted.map(
          (response) => syncOperationSchema.parse(response.body).projectId,
        );
        expect(new Set(projects).size).toBe(projects.length);
        expect(projects).not.toContain(projectId);

        // The invariant, from the other side: each project carries exactly one import operation,
        // so no project is running two of them against one sandbox.
        for (const project of projects) {
          const operations = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
            tx
              .select({ id: schema.syncOperations.id })
              .from(schema.syncOperations)
              .where(eq(schema.syncOperations.projectId, project)),
          );
          expect(operations).toHaveLength(1);
        }

        // Both settle before the suite tears the fixture down, whichever way they went.
        for (const response of accepted) {
          await settledRow(syncOperationSchema.parse(response.body).id);
        }
      }, 120_000);
    },
  );
});
