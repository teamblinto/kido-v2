import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  checkpointListResponseSchema,
  importMismatchResponseSchema,
  inspectImportResponseSchema,
  repoLinkSchema,
  type SyncOperation,
  syncOperationSchema,
} from '@repo/contracts';
import { SignJWT } from 'jose';
import { execFileSync } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import './support/developer-dotenv';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { revealPlaintext } from '../src/common/crypto/branded';
import { MemoryObjectStore } from '../src/common/object-store/memory-object-store';
import { OBJECT_STORE } from '../src/common/object-store/object-store.port';
import {
  GITHUB_APP_CLIENT,
  type GithubAppClient,
} from '../src/modules/connectors/github-app.client';
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
 * (`developer-dotenv` above; what is already set wins). The workspace is the fake Daytona — the
 * upstream leg, the clone and the template decision are what this walk proves; the sandbox leg is
 * `checkpoints-real`'s. `events` so this process carries `connector.sync` itself.
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

// Same idiom as `connectors-real` and `DAYTONA-SKIP` in the other `*-real` suites: loud on stderr,
// and deliberately not the `SKIPPING` word CI greps for.
if (!configured) {
  process.stderr.write(
    'GITHUB-SKIP "connectors-import-real": GITHUB_TEST_ORG and the real GITHUB_APP_* not set\n',
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

/** Real GitHub over the network, and an import clones: a minute and a half. */
const IMPORT_TIMEOUT_MS = 90_000;
/** Two repositories: one that reads as a Vite/React project, one that reads as nothing. */
const RECOGNISED = `forge-026-vite-${String(Date.now())}`;
const UNRECOGNISED = `forge-026-plain-${String(Date.now())}`;

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

/** A raw call to GitHub for what the connector never does itself: create a repository, write a file, delete it. */
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

async function until(predicate: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return predicate();
}

/**
 * Spec 026 quickstart § 6's import half against GitHub itself: the App already installed on
 * `GITHUB_TEST_ORG`, two repositories created under it — one carrying a `package.json` with
 * `vite` and `react` in it, one carrying a single `README.md` — inspected through the real
 * contents API, imported into new projects, and deleted afterwards.
 *
 * What only this suite can prove, and `connectors-import.e2e-spec.ts` against the fixture GitHub
 * cannot: that the inspection reads a *real* repository's tree and size through the real API
 * (FR-005–FR-010), that the clone is a real authenticated fetch of a real remote, and that the
 * link the import leaves is the link spec 018's push and pull then work against with nothing else
 * set up (SC-003).
 *
 * The App needs `Contents: read & write`, `Metadata: read` and `Administration: read & write`
 * (the creates and the `afterAll` deletes).
 */
describe('Importing a real GitHub repository (e2e)', () => {
  describe.skipIf(!configured || !postgres || !redis || !gitOnPath)(
    'against GitHub, Postgres and the queue Redis',
    () => {
      let app: INestApplication;
      let world: TwoTenantWorld;
      let client: GithubAppClient;
      let fake: FakeDaytona;
      let installationId: number;
      let suiteLock: { release: () => Promise<void> } | undefined;
      const created = new Map<string, number>();
      const store = new MemoryObjectStore();

      const note = (line: string) => process.stderr.write(`connectors-import-real ${line}\n`);
      const cookie = () => world.alpha.owner.cookie;
      const connectors = () => `/api/v1/orgs/${world.alpha.orgId}/connectors`;
      const imports = () =>
        `/api/v1/orgs/${world.alpha.orgId}/workspaces/${world.alpha.workspaceId}/imports`;

      /** A one-repository token, as the worker mints it, for the raw calls this walk makes. */
      const repoToken = async (repositoryId: number, permissions: Record<string, string>) =>
        revealPlaintext(
          (await client.mintToken(installationId, { permissions, repositoryIds: [repositoryId] }))
            .token,
        ).toString('utf8');

      /** Creates a repository under the org and seeds `files` into it, one contents call each. */
      async function seed(name: string, files: Record<string, string>): Promise<number> {
        const repository = await github<{ id: number }>(
          `/orgs/${ORG!}/repos`,
          await appInstallationToken({ administration: 'write' }),
          {
            body: JSON.stringify({ auto_init: false, name, private: true }),
            method: 'POST',
          },
        );
        created.set(name, repository.id);

        const token = await repoToken(repository.id, { contents: 'write' });
        for (const [path, content] of Object.entries(files)) {
          await github(`/repos/${ORG!}/${name}/contents/${path}`, token, {
            body: JSON.stringify({
              branch: 'main',
              content: Buffer.from(content).toString('base64'),
              message: `seed ${path}`,
            }),
            method: 'PUT',
          });
        }
        note(`seeded ${ORG!}/${name} (${String(repository.id)})`);

        return repository.id;
      }

      /** Repository creation is an installation-wide call: it names no repository yet. */
      const appInstallationToken = async (permissions: Record<string, string>) =>
        revealPlaintext((await client.mintToken(installationId, { permissions })).token).toString(
          'utf8',
        );

      /** `POST imports` (202), then `GET :operationId` until the worker settled it. */
      async function importToEnd(body: Record<string, unknown>): Promise<SyncOperation> {
        const accepted = await unsafe(http(app).post(imports()), [cookie()]).send(body).expect(202);
        let operation = syncOperationSchema.parse(accepted.body);
        const projectId = operation.projectId;

        expect(
          await until(async () => {
            const read = await http(app)
              .get(`/api/v1/orgs/${world.alpha.orgId}/projects/${projectId}/sync/${operation.id}`)
              .set('Cookie', cookie());
            if (read.status !== 200) {
              // A failed import withdraws its project, so the operation stops being readable
              // through the project's route — see spec 026 § Implementation notes. This walk
              // imports repositories that should succeed, so this is a real failure, not a wait.
              return true;
            }
            operation = syncOperationSchema.parse(read.body);

            return operation.state === 'succeeded' || operation.state === 'failed';
          }, IMPORT_TIMEOUT_MS),
        ).toBe(true);
        note(`import ${operation.id}: ${operation.state} ${operation.reason ?? ''}`);

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

        client = app.get(GITHUB_APP_CLIENT);
        world = await createTwoTenantWorld(app);

        // The App is installed on the throwaway org by hand; its installation id is read, not typed.
        ({ id: installationId } = await github<{ id: number }>(
          `/orgs/${ORG!}/installation`,
          await appJwt(),
        ));
        note(`installation ${String(installationId)} on ${ORG!}`);

        // The connection this org's imports run through, completed the way spec 018 completes it.
        const started = await unsafe(http(app).post(`${connectors()}/github/install`), [
          cookie(),
        ]).expect(200);
        const state = new URL((started.body as { installUrl: string }).installUrl).searchParams.get(
          'state',
        );
        await unsafe(http(app).post(`${connectors()}/github/complete`), [cookie()])
          .send({ installationId, state })
          .expect(201);

        await seed(RECOGNISED, {
          'package.json': `${JSON.stringify(
            {
              dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
              devDependencies: { vite: '^7.0.0' },
              name: 'imported',
              private: true,
            },
            null,
            2,
          )}\n`,
          'src/main.tsx': "export const main = 'imported';\n",
        });
        await seed(UNRECOGNISED, { 'README.md': '# nothing the catalogue knows\n' });
      }, 180_000);

      afterAll(async () => {
        // `Administration: read & write` on the App: `DELETE /repos/{o}/{r}` needs it.
        for (const [name, id] of created) {
          try {
            await github(
              `/repos/${ORG!}/${name}`,
              await repoToken(id, { administration: 'write' }),
              {
                method: 'DELETE',
              },
            );
            note(`deleted ${ORG!}/${name}`);
          } catch (error) {
            note(`could not delete ${ORG!}/${name}: ${String(error)} — delete it by hand`);
          }
        }
        if (world) await destroyTwoTenantWorld(app, world);
        await app?.close();
        await fake?.close();
        await suiteLock?.release();
      }, 120_000);

      it('inspects a real repository and proposes the one template its contents point at', async () => {
        const inspected = await unsafe(http(app).post(`${imports()}/inspect`), [cookie()])
          .send({ repoId: created.get(RECOGNISED) })
          .expect(200);

        const result = inspectImportResponseSchema.parse(inspected.body);
        expect(result).toMatchObject({
          branch: 'main',
          empty: false,
          outcome: 'proposed',
          repo: { name: RECOGNISED, owner: ORG },
        });
        expect(result.candidates).toHaveLength(1);
        expect(result.candidates[0]?.evidence.join(' ')).toMatch(/package\.json/u);
        expect(result.headSha).toMatch(/^[0-9a-f]{40}$/u);
      });

      it('inspects a repository the catalogue does not know and proposes nothing (FR-011)', async () => {
        const inspected = await unsafe(http(app).post(`${imports()}/inspect`), [cookie()])
          .send({ repoId: created.get(UNRECOGNISED) })
          .expect(200);

        expect(inspectImportResponseSchema.parse(inspected.body)).toMatchObject({
          candidates: [],
          empty: false,
          outcome: 'unrecognised',
        });
      });

      it('imports the recognised repository: an open project, linked, at the repository head', async () => {
        const inspected = inspectImportResponseSchema.parse(
          (
            await unsafe(http(app).post(`${imports()}/inspect`), [cookie()])
              .send({ repoId: created.get(RECOGNISED) })
              .expect(200)
          ).body,
        );

        const operation = await importToEnd({
          branch: 'main',
          name: 'imported from a real repository',
          repoId: created.get(RECOGNISED),
          template: inspected.candidates[0]!.template,
        });

        expect(operation).toMatchObject({ kind: 'import', state: 'succeeded' });
        expect(operation.toSha).toBe(inspected.headSha);

        const project = `/api/v1/orgs/${world.alpha.orgId}/projects/${operation.projectId}`;

        // Spec 018's link, made by the import, with nothing else set up (SC-003's premise).
        const linked = await http(app).get(`${project}/repo-link`).set('Cookie', cookie());
        expect(repoLinkSchema.parse(linked.body)).toMatchObject({
          branch: 'main',
          repository: { fullName: `${ORG!}/${RECOGNISED}`, name: RECOGNISED, owner: ORG },
          state: 'linked',
        });

        // One checkpoint, holding the repository's head, with its provenance.
        const listed = await http(app).get(`${project}/checkpoints`).set('Cookie', cookie());
        const { items } = checkpointListResponseSchema.parse(listed.body);
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ gitSha: inspected.headSha });

        // The chosen template is what inspection says, so the panel carries no warning (FR-016).
        const mismatch = await http(app).get(`${project}/import-mismatch`).set('Cookie', cookie());
        expect(importMismatchResponseSchema.parse(mismatch.body)).toEqual({
          templateMismatch: null,
        });
      });

      it('an unrecognised repository imported under an explicit choice warns rather than blocks (FR-016)', async () => {
        const operation = await importToEnd({
          branch: 'main',
          name: 'imported under a chosen template',
          repoId: created.get(UNRECOGNISED),
          template: 'vite-react',
        });

        expect(operation).toMatchObject({ kind: 'import', state: 'succeeded' });

        const mismatch = await http(app)
          .get(`/api/v1/orgs/${world.alpha.orgId}/projects/${operation.projectId}/import-mismatch`)
          .set('Cookie', cookie());
        expect(importMismatchResponseSchema.parse(mismatch.body)).toEqual({
          templateMismatch: { chosen: 'vite-react', detected: [] },
        });
      });
    },
  );
});
