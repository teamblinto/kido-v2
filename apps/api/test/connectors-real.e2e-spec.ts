import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  checkpointListResponseSchema,
  connectionSchema,
  repoLinkSchema,
  type SyncOperation,
  syncOperationSchema,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { SignJWT } from 'jose';
import { execFileSync } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import './support/developer-dotenv';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { revealPlaintext } from '../src/common/crypto/branded';
import { MemoryObjectStore } from '../src/common/object-store/memory-object-store';
import { OBJECT_STORE } from '../src/common/object-store/object-store.port';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import { mirrorKey } from '../src/modules/checkpoints/repo-bundler';
import {
  GITHUB_APP_CLIENT,
  type GithubAppClient,
} from '../src/modules/connectors/github-app.client';
import { SandboxService } from '../src/modules/sandbox/sandbox.service';
import { unsafe } from './support/csrf-client';
import { type FakeDaytona, startFakeDaytona } from './support/fake-daytona';
import { fakeGit } from './support/fake-git';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  http,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

/**
 * Before any import: the real `GITHUB_APP_*` come from the shell or `apps/api/.env`
 * (`developer-dotenv` above; what is already set wins). The pull's sandbox is the fake Daytona —
 * the upstream leg is what this walk proves; the sandbox leg is `checkpoints-real`'s. `events` so
 * this process carries `connector.sync` itself.
 */
const DAYTONA_PORT = vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.THROTTLE_LIMIT = '100000';
  process.env.RUN_PROFILES = 'api,events';
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  process.env.DAYTONA_API_URL = `http://127.0.0.1:${String(port)}/api`;
  process.env.DAYTONA_API_KEY = 'dtn_fake_key';

  return port;
});

const ORG = process.env.GITHUB_TEST_ORG;
const API_URL = (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '');
/** Real means the four are set, the API is GitHub's own, and the key is not `.env.example`'s. */
const configured = Boolean(
  ORG &&
  process.env.GITHUB_APP_ID &&
  process.env.GITHUB_APP_CLIENT_ID &&
  process.env.GITHUB_APP_SLUG &&
  process.env.GITHUB_APP_PRIVATE_KEY &&
  process.env.GITHUB_APP_SLUG !== 'forge-local' &&
  !API_URL.startsWith('http://127.0.0.1'),
);

// Same idiom as `DAYTONA-SKIP` in the other `*-real` suites: not the `SKIPPING` word CI greps for.
if (!configured) {
  process.stderr.write(
    'GITHUB-SKIP "connectors-real": GITHUB_TEST_ORG and the real GITHUB_APP_* not set\n',
  );
}

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

let gitOnPath = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitOnPath = false;
}

/** Real GitHub over the network: a push or pull settles within a minute. */
const SYNC_TIMEOUT_MS = 60_000;
const REPO = `forge-018-${String(Date.now())}`;

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
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return predicate();
}

/** The App JWT as `GithubAppClient.appJwt` mints it (private there): `iss` = app id, RS256. */
function appJwt(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(process.env.GITHUB_APP_ID!)
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 600)
    .sign(createPrivateKey(process.env.GITHUB_APP_PRIVATE_KEY!));
}

/** A raw call to GitHub for what the connector never does itself: read an org's installation, write a file, delete a repository. */
async function github<T>(path: string, bearer: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} → ${String(response.status)}`);
  }

  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

/**
 * Spec 018 quickstart § 6 against GitHub itself: the App already installed on `GITHUB_TEST_ORG`,
 * `complete` with that installation's real id, a repository created under it, two checkpoints
 * pushed from a real bundle, a commit added through the contents API, pulled back, and the
 * repository deleted. Proves the App JWT, the token mint, the push URL form and the extraheader
 * auth once. The App needs `Contents: read & write`, `Metadata: read` and `Administration:
 * read & write` (the create and the `afterAll` delete).
 */
describe('Connectors against a real GitHub App (e2e)', () => {
  describe.skipIf(!configured || !postgres || !redis || !gitOnPath)(
    'against GitHub, Postgres and the queue Redis',
    () => {
      let app: INestApplication;
      let world: TwoTenantWorld;
      let transactions: TenantTransactionRunner;
      let client: GithubAppClient;
      let fake: FakeDaytona;
      let work: string;
      let installationId: number;
      let repositoryId: number;
      let suiteLock: { release: () => Promise<void> } | undefined;
      const store = new MemoryObjectStore();

      const note = (line: string) => process.stderr.write(`connectors-real ${line}\n`);
      const cookie = () => world.alpha.owner.cookie;
      const connectors = () => `/api/v1/orgs/${world.alpha.orgId}/connectors`;
      const project = () => `/api/v1/orgs/${world.alpha.orgId}/projects/${world.alpha.projectId}`;
      const links = () => `${project()}/repo-link`;
      const sync = () => `${project()}/sync`;

      /** A one-repository token, as the worker mints it, for the raw calls this walk makes. */
      const repoToken = async (permissions: Record<string, string>) =>
        revealPlaintext(
          (await client.mintToken(installationId, { permissions, repositoryIds: [repositoryId] }))
            .token,
        ).toString('utf8');

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

      /** `POST push|pull` (202), then `GET :operationId` until the worker settled it. */
      async function syncToEnd(kind: 'pull' | 'push'): Promise<SyncOperation> {
        const accepted = await unsafe(http(app).post(`${sync()}/${kind}`), [cookie()]).expect(202);
        let operation = syncOperationSchema.parse(accepted.body);
        expect(
          await until(async () => {
            const read = await http(app)
              .get(`${sync()}/${operation.id}`)
              .set('Cookie', cookie())
              .expect(200);
            operation = syncOperationSchema.parse(read.body);

            return operation.state === 'succeeded' || operation.state === 'failed';
          }, SYNC_TIMEOUT_MS),
        ).toBe(true);
        note(`${kind} ${operation.id}: ${operation.state} ${operation.reason ?? ''}`);

        return operation;
      }

      beforeAll(async () => {
        suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
        fake = await startFakeDaytona({ port: DAYTONA_PORT });
        fakeGit(fake);

        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(OBJECT_STORE)
          .useValue(store)
          .compile();
        app = moduleRef.createNestApplication();
        configureApplication(app);
        await app.init();

        transactions = app.get(TenantTransactionRunner);
        client = app.get(GITHUB_APP_CLIENT);
        world = await createTwoTenantWorld(app);
        const { orgId, projectId } = world.alpha;
        const sandboxes = app.get(SandboxService);
        await transactions.runInTenantScope({ orgId, userId: null }, async (tx) => {
          await sandboxes.register(tx, { daytonaId: fake.sandboxId, orgId, projectId });
          await sandboxes.exec({ orgId, projectId }, 'git init -q', {
            leaseEpoch: 0,
            operationId: 'real/init',
          });
        });

        // The App is installed on the throwaway org by hand; its installation id is read, not typed.
        ({ id: installationId } = await github<{ id: number }>(
          `/orgs/${ORG!}/installation`,
          await appJwt(),
        ));
        note(`installation ${String(installationId)} on ${ORG!}`);

        work = await mkdtemp(join(tmpdir(), 'forge-connectors-real-'));
        git(work, 'init', '--quiet', '--initial-branch=main');
      }, 120_000);

      afterAll(async () => {
        // `Administration: read & write` on the App: `DELETE /repos/{o}/{r}` needs it.
        if (repositoryId) {
          try {
            await github(`/repos/${ORG!}/${REPO}`, await repoToken({ administration: 'write' }), {
              method: 'DELETE',
            });
            note(`deleted ${ORG!}/${REPO}`);
          } catch (error) {
            note(`could not delete ${ORG!}/${REPO}: ${String(error)} — delete it by hand`);
          }
        }
        if (world) await destroyTwoTenantWorld(app, world);
        await app?.close();
        await fake?.close();
        if (work) await rm(work, { force: true, recursive: true });
        await suiteLock?.release();
      }, 60_000);

      it('install → complete with the real installation id: a healthy connection to the org', async () => {
        const started = await unsafe(http(app).post(`${connectors()}/github/install`), [
          cookie(),
        ]).expect(200);
        const state = new URL((started.body as { installUrl: string }).installUrl).searchParams.get(
          'state',
        );

        const completed = await unsafe(http(app).post(`${connectors()}/github/complete`), [
          cookie(),
        ])
          .send({ installationId, state })
          .expect(201);

        expect(connectionSchema.parse(completed.body)).toMatchObject({
          account: { login: ORG, type: 'organization' },
          health: 'healthy',
          provider: 'github',
        });
      });

      it(`creates ${REPO} under the org and links the project to it`, async () => {
        const linked = await unsafe(http(app).put(links()), [cookie()])
          .send({ create: { name: REPO, private: true } })
          .expect(200);

        const link = repoLinkSchema.parse(linked.body);
        expect(link).toMatchObject({
          branch: 'main',
          repository: { fullName: `${ORG!}/${REPO}`, name: REPO, owner: ORG },
          state: 'linked',
        });
        repositoryId = link.repository.id;
      });

      it('a push of two checkpoints lands both on GitHub with identical shas (SC-004)', async () => {
        const head = await commit(2);

        const operation = await syncToEnd('push');

        expect(operation).toMatchObject({
          commits: 2,
          kind: 'push',
          state: 'succeeded',
          toSha: head,
        });
        const branch = await github<{ commit: { sha: string } }>(
          `/repos/${ORG!}/${REPO}/branches/main`,
          await repoToken({ contents: 'read' }),
        );
        expect(branch.commit.sha).toBe(head);
      });

      it('a commit made through the contents API is pulled: a kind: pull checkpoint at its sha', async () => {
        const written = await github<{ commit: { sha: string } }>(
          `/repos/${ORG!}/${REPO}/contents/THEIRS.md`,
          await repoToken({ contents: 'write' }),
          {
            body: JSON.stringify({
              branch: 'main',
              content: Buffer.from('written by connectors-real\n').toString('base64'),
              message: 'theirs',
            }),
            method: 'PUT',
          },
        );
        const theirs = written.commit.sha;

        const operation = await syncToEnd('pull');

        expect(operation).toMatchObject({
          commits: 1,
          kind: 'pull',
          state: 'succeeded',
          toSha: theirs,
        });
        const listed = await http(app).get(`${project()}/checkpoints`).set('Cookie', cookie());
        const { items } = checkpointListResponseSchema.parse(listed.body);
        expect(items[0]).toMatchObject({ gitSha: theirs, kind: 'pull' });
      });
    },
  );
});
