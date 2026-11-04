import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  checkpointListResponseSchema,
  connectionListSchema,
  connectionSchema,
  operationSchema,
  repoLinkSchema,
  type SyncOperation,
  syncOperationPageSchema,
  syncOperationSchema,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { eq, inArray } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { MemoryObjectStore } from '../src/common/object-store/memory-object-store';
import { OBJECT_STORE } from '../src/common/object-store/object-store.port';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import { mirrorKey } from '../src/modules/checkpoints/repo-bundler';
import { SyncService } from '../src/modules/connectors/sync.service';
import { SandboxService } from '../src/modules/sandbox/sandbox.service';
import { type GithubFixture, startGithubFixture } from './fixtures/github-fixture';
import { unsafe } from './support/csrf-client';
import { stepUp } from './support/step-up';
import { type FakeDaytona, startFakeDaytona } from './support/fake-daytona';
import { fakeGit } from './support/fake-git';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  http,
  type Principal,
  signUpAndIn,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

/**
 * Before any import: `AppModule` reads the environment on load, so the GitHub App and the fixture's
 * address are settled here. The private key is the placeholder `.env.example` publishes — read, not
 * retyped. `trace` so the log scan below sees the most the process could ever write. `events` so
 * the process drains `connector.sync` itself (US2); the install URL is the fixture's, so git
 * clones from it.
 */
const FIXTURE = vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  process.env.LOG_LEVEL = 'trace';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.THROTTLE_LIMIT = '100000';
  process.env.RUN_PROFILES = 'api,events';

  const port = 20_000 + Math.floor(Math.random() * 20_000);
  process.env.GITHUB_API_URL = `http://127.0.0.1:${String(port)}`;
  process.env.GITHUB_INSTALL_URL = process.env.GITHUB_API_URL;
  // US3's pull lands in a sandbox: the fake Daytona, started by that block on this port.
  const daytonaPort = 20_000 + Math.floor(Math.random() * 20_000);
  process.env.DAYTONA_API_URL = `http://127.0.0.1:${String(daytonaPort)}/api`;
  process.env.DAYTONA_API_KEY = 'dtn_fake_key';
  process.env.GITHUB_APP_ID = '1';
  process.env.GITHUB_APP_CLIENT_ID = 'Iv1.example';
  process.env.GITHUB_APP_SLUG = 'forge-local';
  // Hoisted code runs before the static imports exist, so the built-ins are fetched by hand.
  const { readFileSync } = process.getBuiltinModule('node:fs');
  const { join } = process.getBuiltinModule('node:path');
  process.env.GITHUB_APP_PRIVATE_KEY = /^# GITHUB_APP_PRIVATE_KEY="(.+)"$/m
    .exec(readFileSync(join(__dirname, '../.env.example'), 'utf8'))![1]!
    .replaceAll('\\n', '\n');

  return { daytonaPort, port };
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const INSTALLATION_ID = 7001;
const SYNC_TIMEOUT_MS = 15_000;

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

async function until(predicate: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

/**
 * Spec 018 US1 through HTTP against the fixture GitHub: install → complete → the row a member sees,
 * the tenant boundary, the SC-002 scan, removal, and the member refused at the door. Then US2: the
 * link, and a push the in-process `events` worker carries to the fixture's git.
 */
describe('Connectors (e2e)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres, Redis and the fixture GitHub', () => {
    let app: INestApplication;
    let fixture: GithubFixture;
    let world: TwoTenantWorld;
    let member: Principal;
    let admin: Principal;
    let transactions: TenantTransactionRunner;
    let connectionId: string;
    let suiteLock: { release: () => Promise<void> } | undefined;
    const store = new MemoryObjectStore();
    /** Every response body this suite received, for the SC-002 scan. */
    const bodies: unknown[] = [];
    /** Everything the process wrote to stdout while the credential was in play. */
    const stdout: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);

    const connectors = (orgId: string) => `/api/v1/orgs/${orgId}/connectors`;

    // Spec 018's flows are driven by hand; spec 044's first automatic push has its own test below.
    beforeEach(() => {
      vi.spyOn(app.get(SyncService, { strict: false }), 'requestAuto').mockResolvedValue(null);
    });

    beforeAll(async () => {
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
      fixture = await startGithubFixture({ git: true, port: FIXTURE.port });
      fixture.installations.set(INSTALLATION_ID, {
        account: { id: 9001, login: 'acme', type: 'Organization' },
        id: INSTALLATION_ID,
      });

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(OBJECT_STORE)
        .useValue(store)
        .compile();
      app = moduleRef.createNestApplication();
      configureApplication(app);
      await app.init();

      transactions = app.get(TenantTransactionRunner);
      world = await createTwoTenantWorld(app);
      member = await signUpAndIn(app, 'member');
      admin = await signUpAndIn(app, 'admin');
      await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
        tx.insert(schema.memberships).values([
          {
            acceptedAt: new Date(),
            orgId: world.alpha.orgId,
            role: 'member',
            userId: member.userId,
          },
          { acceptedAt: new Date(), orgId: world.alpha.orgId, role: 'admin', userId: admin.userId },
        ]),
      );

      // Wrapped by hand, not `vi.spyOn`: `restoreMocks: true` would undo a spy between tests, and
      // the capture has to span every test the credential is alive in.
      process.stdout.write = (chunk: Uint8Array | string): boolean => {
        stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));

        return true;
      };
    }, 600_000);

    afterAll(async () => {
      process.stdout.write = realWrite;
      if (world) await destroyTwoTenantWorld(app, world);
      const extras = [member, admin].filter(Boolean).map((principal) => principal.email);
      if (extras.length > 0) {
        await app
          .get<ForgeDatabase>(APP_DATABASE)
          .delete(schema.users)
          .where(inArray(schema.users.email, extras));
      }
      await app?.close();
      await fixture?.close();
      await suiteLock?.release();
    });

    it('installs and completes: the owner sees a healthy connection and its fingerprint, never the token', async () => {
      const owner = world.alpha.owner;
      const started = await unsafe(
        http(app).post(`${connectors(world.alpha.orgId)}/github/install`),
        [owner.cookie],
      ).expect(200);
      bodies.push(started.body);

      const installUrl = new URL((started.body as { installUrl: string }).installUrl);
      expect(installUrl.pathname).toBe('/apps/forge-local/installations/new');
      const state = installUrl.searchParams.get('state');
      expect(state).toBeTruthy();

      const completed = await unsafe(
        http(app).post(`${connectors(world.alpha.orgId)}/github/complete`),
        [owner.cookie],
      )
        .send({ installationId: INSTALLATION_ID, state })
        .expect(201);
      bodies.push(completed.body);

      const connection = connectionSchema.parse(completed.body);
      connectionId = connection.id;
      expect(connection).toMatchObject({
        account: { id: 9001, login: 'acme', type: 'organization' },
        connectedBy: { id: owner.userId },
        health: 'healthy',
        provider: 'github',
      });
      expect(connection.credentialFingerprint).toMatch(/^sha256:[0-9a-f]{32}$/);

      const listed = await http(app)
        .get(connectors(world.alpha.orgId))
        .set('Cookie', member.cookie)
        .expect(200);
      bodies.push(listed.body);

      expect(connectionListSchema.parse(listed.body).connections).toEqual([connection]);
      expect(fixture.tokens.size).toBe(1);
    });

    it('a spent state is oauth-state-invalid', async () => {
      const response = await unsafe(
        http(app).post(`${connectors(world.alpha.orgId)}/github/complete`),
        [world.alpha.owner.cookie],
      )
        .send({ installationId: INSTALLATION_ID, state: 'spent-or-never-issued' })
        .expect(400);
      bodies.push(response.body);

      expect(response.body).toMatchObject({
        type: 'https://forge.dev/problems/oauth-state-invalid',
      });
    });

    it('another organisation cannot observe the connection: its list is empty and the id is not-found (FR-031)', async () => {
      const beta = world.beta;
      const listed = await http(app)
        .get(connectors(beta.orgId))
        .set('Cookie', beta.owner.cookie)
        .expect(200);
      bodies.push(listed.body);
      expect(listed.body).toEqual({ connections: [] });

      // Stepped up, so what answers is the tenant boundary and not the second-factor gate.
      await stepUp(app, beta.owner.cookie);
      const removed = await unsafe(http(app).delete(`${connectors(beta.orgId)}/${connectionId}`), [
        beta.owner.cookie,
      ]).expect(404);
      bodies.push(removed.body);
      expect(removed.body).toMatchObject({ type: 'https://forge.dev/problems/not-found' });

      const crossed = await http(app)
        .get(connectors(world.alpha.orgId))
        .set('Cookie', beta.owner.cookie)
        .expect(403);
      bodies.push(crossed.body);
      expect(crossed.body).toMatchObject({ type: 'https://forge.dev/problems/permission-denied' });
    });

    it('SC-002: no API response, log line or audit entry of this feature carries the token', async () => {
      // pino-http logs on response finish, one turn after supertest resolves.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      const audit = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
        tx.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, world.alpha.orgId)),
      );
      expect(audit.some((row) => row.action === 'connector.connected')).toBe(true);

      const tokens = [...fixture.tokens.keys()];
      expect(tokens.length).toBeGreaterThan(0);
      const responses = JSON.stringify(bodies);
      const logs = stdout.join('');
      const rows = JSON.stringify(audit);
      // An empty capture would pass every `not.toContain`; the vacuous pass is refused first.
      expect(logs.length).toBeGreaterThan(0);
      expect(logs).toContain('connectors');

      for (const token of tokens) {
        expect(responses).not.toContain(token);
        expect(logs).not.toContain(token);
        expect(rows).not.toContain(token);
      }
    });

    it('a member may read but not install: permission-denied', async () => {
      const response = await unsafe(
        http(app).post(`${connectors(world.alpha.orgId)}/github/install`),
        [member.cookie],
      ).expect(403);
      bodies.push(response.body);

      expect(response.body).toMatchObject({ type: 'https://forge.dev/problems/permission-denied' });
    });

    // Spec 030 R14 (ask-first 2): removal needs a recent second factor, GitHub's included.
    it('an admin without a recent second factor is refused: 403 step-up-required, nothing removed', async () => {
      const refused = await unsafe(
        http(app).delete(`${connectors(world.alpha.orgId)}/${connectionId}`),
        [admin.cookie],
      ).expect(403);
      bodies.push(refused.body);

      expect(refused.body).toMatchObject({ type: 'https://forge.dev/problems/step-up-required' });
      expect(fixture.installations.has(INSTALLATION_ID)).toBe(true);
    });

    it('an admin removes it stepped up: 202 connection_remove, and GitHub was asked to revoke the installation', async () => {
      await stepUp(app, admin.cookie);
      const accepted = await unsafe(
        http(app).delete(`${connectors(world.alpha.orgId)}/${connectionId}`),
        [admin.cookie],
      ).expect(202);
      bodies.push(accepted.body);

      expect(operationSchema.parse(accepted.body)).toMatchObject({
        kind: 'connection_remove',
        requestedBy: admin.userId,
      });
      // The connection being removed is already gone from the list (contracts/bindings.md § 1).
      expect(
        (
          await http(app)
            .get(connectors(world.alpha.orgId))
            .set('Cookie', world.alpha.owner.cookie)
            .expect(200)
        ).body,
      ).toEqual({ connections: [] });
      expect(
        await until(
          () => Promise.resolve(!fixture.installations.has(INSTALLATION_ID)),
          SYNC_TIMEOUT_MS,
        ),
      ).toBe(true);

      expect(
        fixture.requests.some(
          (request) =>
            request.method === 'DELETE' &&
            request.path === `/app/installations/${String(INSTALLATION_ID)}`,
        ),
      ).toBe(true);
      expect(fixture.installations.has(INSTALLATION_ID)).toBe(false);

      const listed = await http(app)
        .get(connectors(world.alpha.orgId))
        .set('Cookie', world.alpha.owner.cookie)
        .expect(200);
      expect(listed.body).toEqual({ connections: [] });
    });

    /**
     * US2 (SC-004): the project linked to a repository created under the org installation, a push
     * carried by the `events` worker in this process to the fixture's `git http-backend`, polled to
     * `succeeded` through `GET :operationId`; a second push carries only the new commits; a viewer
     * may not ask. The source is a real bundle in the memory store labelled at the head checkpoint.
     */
    describe.skipIf(!gitOnPath)('US2: link and push', () => {
      let work: string;
      let viewer: Principal;

      const project = () => `/api/v1/orgs/${world.alpha.orgId}/projects/${world.alpha.projectId}`;
      const links = () => `${project()}/repo-link`;
      const sync = () => `${project()}/sync`;
      const remote = () => join(fixture.gitRoot!, 'acme', 'site.git');

      /** `n` more commits; the head is bundled into the mirror and recorded as the head checkpoint. */
      async function commit(n: number): Promise<string> {
        for (let i = 0; i < n; i++) git(work, 'commit', '--quiet', '--allow-empty', '-m', `c${i}`);
        const head = git(work, 'rev-parse', 'HEAD');
        git(work, 'bundle', 'create', join(work, '.git', 'forge-mirror.bundle'), '--all');
        await store.put(
          mirrorKey(world.alpha.orgId, world.alpha.projectId),
          await readFile(join(work, '.git', 'forge-mirror.bundle')),
          { head },
        );
        await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx.insert(schema.checkpoints).values({
            files: [],
            gitSha: head,
            kind: 'baseline',
            label: `head ${head.slice(0, 7)}`,
            orgId: world.alpha.orgId,
            projectId: world.alpha.projectId,
          }),
        );

        return head;
      }

      /** `POST push` (202), then `GET :operationId` until the worker settled it. */
      async function pushToEnd(cookie: string): Promise<SyncOperation> {
        const accepted = await unsafe(http(app).post(`${sync()}/push`), [cookie]).expect(202);
        bodies.push(accepted.body);
        let operation = syncOperationSchema.parse(accepted.body);
        expect(operation.state).toBe('queued');

        expect(
          await until(async () => {
            const read = await http(app)
              .get(`${sync()}/${operation.id}`)
              .set('Cookie', cookie)
              .expect(200);
            bodies.push(read.body);
            operation = syncOperationSchema.parse(read.body);

            return operation.state === 'succeeded' || operation.state === 'failed';
          }, SYNC_TIMEOUT_MS),
        ).toBe(true);

        return operation;
      }

      /** Installs `account` afresh: US1 removed the connection and the fixture's installation. */
      async function connectAs(account: {
        id: number;
        login: string;
        type: 'Organization' | 'User';
      }): Promise<string> {
        fixture.installations.set(INSTALLATION_ID, { account, id: INSTALLATION_ID });
        const started = await unsafe(
          http(app).post(`${connectors(world.alpha.orgId)}/github/install`),
          [world.alpha.owner.cookie],
        ).expect(200);
        const state = new URL((started.body as { installUrl: string }).installUrl).searchParams.get(
          'state',
        );
        const completed = await unsafe(
          http(app).post(`${connectors(world.alpha.orgId)}/github/complete`),
          [world.alpha.owner.cookie],
        )
          .send({ installationId: INSTALLATION_ID, state })
          .expect(201);
        bodies.push(completed.body);

        return connectionSchema.parse(completed.body).id;
      }

      beforeAll(async () => {
        work = await mkdtemp(join(tmpdir(), 'forge-connectors-e2e-'));
        git(work, 'init', '--quiet', '--initial-branch=main');
        viewer = await signUpAndIn(app, 'viewer');
        await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx.insert(schema.projectGrants).values({
            orgId: world.alpha.orgId,
            projectId: world.alpha.projectId,
            role: 'viewer',
            userId: viewer.userId,
          }),
        );
      });

      afterAll(async () => {
        if (viewer) {
          await app
            .get<ForgeDatabase>(APP_DATABASE)
            .delete(schema.users)
            .where(eq(schema.users.email, viewer.email));
        }
        await rm(work, { force: true, recursive: true });
      });

      it('a user installation cannot create a repository: conflict / create-unsupported (R4)', async () => {
        const id = await connectAs({ id: 9002, login: 'jane', type: 'User' });

        const refused = await unsafe(http(app).put(links()), [world.alpha.owner.cookie])
          .send({ create: { name: 'site', private: true } })
          .expect(409);
        bodies.push(refused.body);

        expect(refused.body).toMatchObject({ reason: 'create-unsupported' });
        await stepUp(app, world.alpha.owner.cookie);
        await unsafe(http(app).delete(`${connectors(world.alpha.orgId)}/${id}`), [
          world.alpha.owner.cookie,
        ]).expect(202);
        // `connection_remove` runs on the in-process worker; the next install needs the row gone.
        expect(
          await until(
            async () =>
              (
                await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
                  tx
                    .select({ id: schema.connections.id })
                    .from(schema.connections)
                    .where(eq(schema.connections.id, id)),
                )
              ).length === 0,
            SYNC_TIMEOUT_MS,
          ),
        ).toBe(true);
      });

      it('an organisation installation creates the repository and links the project to it', async () => {
        await connectAs({ id: 9001, login: 'acme', type: 'Organization' });

        const linked = await unsafe(http(app).put(links()), [world.alpha.owner.cookie])
          .send({ create: { name: 'site', private: true } })
          .expect(200);
        bodies.push(linked.body);

        expect(repoLinkSchema.parse(linked.body)).toMatchObject({
          branch: 'main',
          position: 'unknown',
          repository: { fullName: 'acme/site', name: 'site', owner: 'acme' },
          state: 'linked',
        });
        await fixture.initRepo({ full_name: 'acme/site' });
      });

      it('SC-004: a push lands every commit on the remote with identical shas, polled to succeeded', async () => {
        const head = await commit(5);

        const operation = await pushToEnd(world.alpha.owner.cookie);

        expect(operation).toMatchObject({
          commits: 5,
          fromSha: null,
          kind: 'push',
          reason: null,
          state: 'succeeded',
          toSha: head,
        });
        expect(git(remote(), 'rev-list', 'refs/heads/main')).toBe(git(work, 'rev-list', 'HEAD'));

        const read = await http(app).get(links()).set('Cookie', viewer.cookie).expect(200);
        bodies.push(read.body);
        expect(repoLinkSchema.parse(read.body)).toMatchObject({
          position: 'level',
          remoteHeadSha: head,
        });
      });

      it('two more commits: the second push carries commits: 2', async () => {
        const head = await commit(2);

        const operation = await pushToEnd(world.alpha.owner.cookie);

        expect(operation).toMatchObject({ commits: 2, state: 'succeeded', toSha: head });
        expect(git(remote(), 'rev-parse', 'refs/heads/main')).toBe(head);
      });

      it('a viewer may read the operations but not push: permission-denied', async () => {
        const listed = await http(app).get(sync()).set('Cookie', viewer.cookie).expect(200);
        bodies.push(listed.body);
        expect((listed.body as { operations: unknown[] }).operations).toHaveLength(2);

        const refused = await unsafe(http(app).post(`${sync()}/push`), [viewer.cookie]).expect(403);
        bodies.push(refused.body);
        expect(refused.body).toMatchObject({
          type: 'https://forge.dev/problems/permission-denied',
        });
        expect(git(remote(), 'rev-list', '--count', 'refs/heads/main')).toBe('7');
      });

      it('SC-002 still holds with the one-repository token in play', async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        const tokens = [...fixture.tokens.keys()];
        expect(tokens.length).toBeGreaterThan(1);
        const responses = JSON.stringify(bodies);
        const logs = stdout.join('');
        for (const token of tokens) {
          expect(responses).not.toContain(token);
          expect(logs).not.toContain(token);
          expect(logs).not.toContain(Buffer.from(`x-access-token:${token}`).toString('base64'));
        }
      });
    });

    /**
     * Spec 018 US5 / SC-012 through HTTP: link → push → unlink (nothing remote touched) → relink
     * the same repository → the link is level (FR-018) and the next push adds zero commits.
     * Self-contained: its own repository and remote, whatever the blocks before left behind.
     */
    describe.skipIf(!gitOnPath)('US5: unlink and relink', () => {
      let work: string;
      let repoId: number;

      const project = () => `/api/v1/orgs/${world.alpha.orgId}/projects/${world.alpha.projectId}`;
      const links = () => `${project()}/repo-link`;
      const sync = () => `${project()}/sync`;
      const remote = () => join(fixture.gitRoot!, 'acme', 'site-us5.git');
      const cookie = () => world.alpha.owner.cookie;

      async function commit(n: number): Promise<string> {
        for (let i = 0; i < n; i++) git(work, 'commit', '--quiet', '--allow-empty', '-m', `u${i}`);
        const head = git(work, 'rev-parse', 'HEAD');
        git(work, 'bundle', 'create', join(work, '.git', 'forge-mirror.bundle'), '--all');
        await store.put(
          mirrorKey(world.alpha.orgId, world.alpha.projectId),
          await readFile(join(work, '.git', 'forge-mirror.bundle')),
          { head },
        );
        await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx.insert(schema.checkpoints).values({
            files: [],
            gitSha: head,
            kind: 'baseline',
            label: `head ${head.slice(0, 7)}`,
            orgId: world.alpha.orgId,
            projectId: world.alpha.projectId,
          }),
        );

        return head;
      }

      async function pushToEnd(): Promise<SyncOperation> {
        const accepted = await unsafe(http(app).post(`${sync()}/push`), [cookie()]).expect(202);
        bodies.push(accepted.body);
        let operation = syncOperationSchema.parse(accepted.body);

        expect(
          await until(async () => {
            const read = await http(app).get(`${sync()}/${operation.id}`).set('Cookie', cookie());
            bodies.push(read.body);
            operation = syncOperationSchema.parse(read.body);

            return operation.state === 'succeeded' || operation.state === 'failed';
          }, SYNC_TIMEOUT_MS),
        ).toBe(true);

        return operation;
      }

      beforeAll(async () => {
        // A connection, whichever block ran last; an unlinked project; a fresh repository.
        const listed = await http(app).get(connectors(world.alpha.orgId)).set('Cookie', cookie());
        if (connectionListSchema.parse(listed.body).connections.length === 0) {
          fixture.installations.set(INSTALLATION_ID, {
            account: { id: 9001, login: 'acme', type: 'Organization' },
            id: INSTALLATION_ID,
          });
          const started = await unsafe(
            http(app).post(`${connectors(world.alpha.orgId)}/github/install`),
            [cookie()],
          ).expect(200);
          const state = new URL(
            (started.body as { installUrl: string }).installUrl,
          ).searchParams.get('state');
          const completed = await unsafe(
            http(app).post(`${connectors(world.alpha.orgId)}/github/complete`),
            [cookie()],
          )
            .send({ installationId: INSTALLATION_ID, state })
            .expect(201);
          bodies.push(completed.body);
        }
        await unsafe(http(app).delete(links()), [cookie()]);

        work = await mkdtemp(join(tmpdir(), 'forge-connectors-e2e-us5-'));
        git(work, 'init', '--quiet', '--initial-branch=main');
        const linked = await unsafe(http(app).put(links()), [cookie()])
          .send({ create: { name: 'site-us5', private: true } })
          .expect(200);
        bodies.push(linked.body);
        repoId = repoLinkSchema.parse(linked.body).repository.id;
        await fixture.initRepo({ full_name: 'acme/site-us5' });
      });

      afterAll(() => rm(work, { force: true, recursive: true }));

      it('SC-012: link → push → unlink → relink → push carries commits: 0 and the remote is unchanged', async () => {
        const head = await commit(2);
        expect(await pushToEnd()).toMatchObject({ commits: 2, state: 'succeeded', toSha: head });
        expect(git(remote(), 'rev-parse', 'refs/heads/main')).toBe(head);

        const before = fixture.requests.length;
        await unsafe(http(app).delete(links()), [cookie()]).expect(204);
        expect(fixture.requests).toHaveLength(before);
        expect(git(remote(), 'rev-parse', 'refs/heads/main')).toBe(head);

        const relinked = await unsafe(http(app).put(links()), [cookie()])
          .send({ existing: { branch: 'main', repoId } })
          .expect(200);
        bodies.push(relinked.body);
        expect(repoLinkSchema.parse(relinked.body)).toMatchObject({
          position: 'level',
          remoteHeadSha: head,
          state: 'linked',
        });

        expect(await pushToEnd()).toMatchObject({
          commits: 0,
          fromSha: head,
          reason: null,
          state: 'succeeded',
          toSha: head,
        });
        expect(git(remote(), 'rev-list', '--count', 'refs/heads/main')).toBe('2');
      });

      it('spec 044: linking pushes the project with no click, through the real outbox', async () => {
        vi.spyOn(app.get(SyncService, { strict: false }), 'requestAuto').mockRestore();

        const head = await commit(1);

        await unsafe(http(app).delete(links()), [cookie()]).expect(204);
        await unsafe(http(app).put(links()), [cookie()])
          .send({ existing: { branch: 'main', repoId } })
          .expect(200);

        let newest: SyncOperation | undefined;

        expect(
          await until(async () => {
            const page = await http(app).get(sync()).set('Cookie', cookie());

            newest = syncOperationPageSchema.parse(page.body).operations[0];

            return newest?.state === 'succeeded' || newest?.state === 'failed';
          }, SYNC_TIMEOUT_MS),
        ).toBe(true);
        expect(newest).toMatchObject({
          state: 'succeeded',
          targetBranch: 'main',
          toSha: head,
          trigger: 'auto',
        });
        expect(git(remote(), 'rev-parse', 'refs/heads/main')).toBe(head);
        // The next block links in its `beforeAll`, ahead of the `beforeEach` that stubs this.
        vi.spyOn(app.get(SyncService, { strict: false }), 'requestAuto').mockResolvedValue(null);
      });
    });

    /**
     * US4 (SC-009, SC-010): the installation revoked at GitHub → `POST verify` reads
     * `needs_reauth` → a push is refused at the door as `conflict/needs-reauth` with no operation
     * row → the admin reconnects → the same link pushes.
     */
    describe.skipIf(!gitOnPath)('US4: revoked, refused, reconnected', () => {
      let work: string;
      let connection: string;

      const project = () => `/api/v1/orgs/${world.alpha.orgId}/projects/${world.alpha.projectId}`;
      const links = () => `${project()}/repo-link`;
      const sync = () => `${project()}/sync`;
      const remote = () => join(fixture.gitRoot!, 'acme', 'site-us4.git');
      const cookie = () => world.alpha.owner.cookie;

      async function commit(n: number): Promise<string> {
        for (let i = 0; i < n; i++) git(work, 'commit', '--quiet', '--allow-empty', '-m', `h${i}`);
        const head = git(work, 'rev-parse', 'HEAD');
        git(work, 'bundle', 'create', join(work, '.git', 'forge-mirror.bundle'), '--all');
        await store.put(
          mirrorKey(world.alpha.orgId, world.alpha.projectId),
          await readFile(join(work, '.git', 'forge-mirror.bundle')),
          { head },
        );
        await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx.insert(schema.checkpoints).values({
            files: [],
            gitSha: head,
            kind: 'baseline',
            label: `head ${head.slice(0, 7)}`,
            orgId: world.alpha.orgId,
            projectId: world.alpha.projectId,
          }),
        );

        return head;
      }

      /** `install` → `complete` for the org account; the fixture knows the installation again. */
      async function reconnect(): Promise<string> {
        fixture.installations.set(INSTALLATION_ID, {
          account: { id: 9001, login: 'acme', type: 'Organization' },
          id: INSTALLATION_ID,
        });
        const started = await unsafe(
          http(app).post(`${connectors(world.alpha.orgId)}/github/install`),
          [cookie()],
        ).expect(200);
        const state = new URL((started.body as { installUrl: string }).installUrl).searchParams.get(
          'state',
        );
        const completed = await unsafe(
          http(app).post(`${connectors(world.alpha.orgId)}/github/complete`),
          [cookie()],
        )
          .send({ installationId: INSTALLATION_ID, state })
          .expect(201);
        bodies.push(completed.body);

        return connectionSchema.parse(completed.body).id;
      }

      async function operations(): Promise<number> {
        const listed = await http(app).get(sync()).set('Cookie', cookie()).expect(200);
        bodies.push(listed.body);

        return (listed.body as { operations: unknown[] }).operations.length;
      }

      beforeAll(async () => {
        const listed = await http(app).get(connectors(world.alpha.orgId)).set('Cookie', cookie());
        const [existing] = connectionListSchema.parse(listed.body).connections;
        connection = existing?.id ?? (await reconnect());
        await unsafe(http(app).delete(links()), [cookie()]);

        work = await mkdtemp(join(tmpdir(), 'forge-connectors-e2e-us4-'));
        git(work, 'init', '--quiet', '--initial-branch=main');
        const linked = await unsafe(http(app).put(links()), [cookie()])
          .send({ create: { name: 'site-us4', private: true } })
          .expect(200);
        bodies.push(linked.body);
        await fixture.initRepo({ full_name: 'acme/site-us4' });
      });

      afterAll(() => rm(work, { force: true, recursive: true }));

      it('revoked at GitHub: POST verify answers needs_reauth, and a push is refused as conflict/needs-reauth with no operation row', async () => {
        await commit(1);
        fixture.installations.delete(INSTALLATION_ID);

        const verified = await unsafe(
          http(app).post(`${connectors(world.alpha.orgId)}/${connection}/verify`),
          [cookie()],
        ).expect(200);
        bodies.push(verified.body);
        expect(connectionSchema.parse(verified.body)).toMatchObject({
          health: 'needs_reauth',
          id: connection,
        });

        const before = await operations();
        const requestsBefore = fixture.requests.length;
        const refused = await unsafe(http(app).post(`${sync()}/push`), [cookie()]).expect(409);
        bodies.push(refused.body);

        expect(refused.body).toMatchObject({ reason: 'needs-reauth' });
        expect(fixture.requests).toHaveLength(requestsBefore);
        expect(await operations()).toBe(before);
      });

      it('a member may not verify: permission-denied', async () => {
        await unsafe(http(app).post(`${connectors(world.alpha.orgId)}/${connection}/verify`), [
          member.cookie,
        ]).expect(403);
      });

      it('reconnected: the connection is healthy again and the same link pushes', async () => {
        const reconnected = await reconnect();
        expect(reconnected).toBe(connection);

        const read = await http(app).get(links()).set('Cookie', cookie()).expect(200);
        bodies.push(read.body);
        expect(repoLinkSchema.parse(read.body)).toMatchObject({
          connectionId: connection,
          state: 'linked',
        });

        const head = git(work, 'rev-parse', 'HEAD');
        const accepted = await unsafe(http(app).post(`${sync()}/push`), [cookie()]).expect(202);
        bodies.push(accepted.body);
        let operation = syncOperationSchema.parse(accepted.body);
        expect(
          await until(async () => {
            const polled = await http(app).get(`${sync()}/${operation.id}`).set('Cookie', cookie());
            bodies.push(polled.body);
            operation = syncOperationSchema.parse(polled.body);

            return operation.state === 'succeeded' || operation.state === 'failed';
          }, SYNC_TIMEOUT_MS),
        ).toBe(true);

        expect(operation).toMatchObject({ commits: 1, state: 'succeeded', toSha: head });
        expect(git(remote(), 'rev-parse', 'refs/heads/main')).toBe(head);
      });
    });

    /**
     * Spec 018 US3 through HTTP: a commit made on the remote, `POST pull` carried by the `events`
     * worker to the fake Daytona (`fakeGit` reads the bundle's header), the checkpoints list
     * showing the `pull` row with the remote's sha; and a run in progress refusing the request
     * at the door as `conflict / run-active`.
     */
    describe.skipIf(!gitOnPath)('US3: pull', () => {
      let fake: FakeDaytona;
      let work: string;
      let other: string;

      const project = () => `/api/v1/orgs/${world.alpha.orgId}/projects/${world.alpha.projectId}`;
      const links = () => `${project()}/repo-link`;
      const sync = () => `${project()}/sync`;
      const remote = () => join(fixture.gitRoot!, 'acme', 'site-us3.git');
      const cookie = () => world.alpha.owner.cookie;

      async function settled(operationId: string): Promise<SyncOperation> {
        let operation: SyncOperation | undefined;
        expect(
          await until(async () => {
            const polled = await http(app).get(`${sync()}/${operationId}`).set('Cookie', cookie());
            bodies.push(polled.body);
            operation = syncOperationSchema.parse(polled.body);

            return operation.state === 'succeeded' || operation.state === 'failed';
          }, SYNC_TIMEOUT_MS),
        ).toBe(true);

        return operation!;
      }

      beforeAll(async () => {
        fake = await startFakeDaytona({ port: FIXTURE.daytonaPort });
        fakeGit(fake);
        const { orgId, projectId } = world.alpha;
        const ref = { orgId, projectId };
        const sandboxes = app.get(SandboxService);
        await transactions.runInTenantScope({ orgId, userId: null }, async (tx) => {
          await sandboxes.register(tx, { daytonaId: fake.sandboxId, orgId, projectId });
          await sandboxes.exec(ref, 'git init -q', { leaseEpoch: 0, operationId: 'us3/init' });
        });

        // A connection, whichever block ran last; an unlinked project; a fresh repository.
        const listed = await http(app).get(connectors(orgId)).set('Cookie', cookie());
        if (connectionListSchema.parse(listed.body).connections.length === 0) {
          fixture.installations.set(INSTALLATION_ID, {
            account: { id: 9001, login: 'acme', type: 'Organization' },
            id: INSTALLATION_ID,
          });
          const started = await unsafe(http(app).post(`${connectors(orgId)}/github/install`), [
            cookie(),
          ]).expect(200);
          const state = new URL(
            (started.body as { installUrl: string }).installUrl,
          ).searchParams.get('state');
          const completed = await unsafe(http(app).post(`${connectors(orgId)}/github/complete`), [
            cookie(),
          ])
            .send({ installationId: INSTALLATION_ID, state })
            .expect(201);
          bodies.push(completed.body);
        }
        await unsafe(http(app).delete(links()), [cookie()]);
        const linked = await unsafe(http(app).put(links()), [cookie()])
          .send({ create: { name: 'site-us3', private: true } })
          .expect(200);
        bodies.push(linked.body);
        await fixture.initRepo({ full_name: 'acme/site-us3' });

        // The project's head is on the remote already (as after a push); "someone else" clones it.
        work = await mkdtemp(join(tmpdir(), 'forge-connectors-e2e-us3-'));
        git(work, 'init', '--quiet', '--initial-branch=main');
        git(work, 'commit', '--quiet', '--allow-empty', '-m', 'p0');
        const head = git(work, 'rev-parse', 'HEAD');
        git(work, 'bundle', 'create', join(work, '.git', 'forge-mirror.bundle'), '--all');
        await store.put(
          mirrorKey(orgId, projectId),
          await readFile(join(work, '.git', 'forge-mirror.bundle')),
          { head },
        );
        await transactions.runInTenantTransaction(orgId, (tx) =>
          tx.insert(schema.checkpoints).values({
            files: [],
            gitSha: head,
            kind: 'baseline',
            label: `head ${head.slice(0, 7)}`,
            orgId,
            projectId,
          }),
        );
        git(work, 'push', '--quiet', remote(), 'HEAD:refs/heads/main');
        other = join(work, 'other');
        git(work, 'clone', '--quiet', remote(), other);
      });

      afterAll(async () => {
        await fake?.close();
        if (work) await rm(work, { force: true, recursive: true });
      });

      it('a commit on the remote is pulled: the checkpoints list shows kind: pull with its sha', async () => {
        git(other, 'commit', '--quiet', '--allow-empty', '-m', 'theirs');
        git(other, 'push', '--quiet', 'origin', 'HEAD:main');
        const theirs = git(other, 'rev-parse', 'HEAD');

        const accepted = await unsafe(http(app).post(`${sync()}/pull`), [cookie()]).expect(202);
        bodies.push(accepted.body);
        const operation = await settled(syncOperationSchema.parse(accepted.body).id);

        expect(operation).toMatchObject({
          commits: 1,
          kind: 'pull',
          state: 'succeeded',
          toSha: theirs,
        });
        const listed = await http(app).get(`${project()}/checkpoints`).set('Cookie', cookie());
        bodies.push(listed.body);
        const { items } = checkpointListResponseSchema.parse(listed.body);
        expect(items[0]).toMatchObject({ gitSha: theirs, kind: 'pull' });
        expect(fake.workspace.has(`${fake.workDir}/.git/forge-pull.bundle`)).toBe(false);
      });

      it('a run in progress: conflict / run-active at request time', async () => {
        const { orgId, projectId } = world.alpha;
        const [run] = await transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .insert(schema.agentRuns)
            .values({
              model: 'test',
              orgId,
              projectId,
              status: 'running',
              userId: world.alpha.owner.userId,
            })
            .returning({ id: schema.agentRuns.id }),
        );

        const refused = await unsafe(http(app).post(`${sync()}/pull`), [cookie()]).expect(409);
        bodies.push(refused.body);

        expect(refused.body).toMatchObject({ reason: 'run-active' });
        await transactions.runInTenantTransaction(orgId, (tx) =>
          tx.delete(schema.agentRuns).where(eq(schema.agentRuns.id, run!.id)),
        );
      });
    });
  });
});
