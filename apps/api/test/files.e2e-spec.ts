import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  fileContentResponseSchema,
  fileListResponseSchema,
  problemDetailSchema,
  wakeResponseSchema,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../src/modules/identity/password/breached-password.port';
import { DAYTONA_TIMINGS, DEFAULT_DAYTONA_TIMINGS } from '../src/modules/sandbox/sandbox.constants';
import { SandboxService } from '../src/modules/sandbox/sandbox.service';
import { ProjectService } from '../src/modules/tenancy/services/project.service';
import { unsafe } from './support/csrf-client';
import { type FakeDaytona, startFakeDaytona } from './support/fake-daytona';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  http,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

/**
 * Before any import, as `sandbox-registration.e2e-spec.ts`: `ConfigModule.forRoot` reads the
 * environment when `AppModule` is loaded, so the fake's address must be known first. `api` alone —
 * nothing here needs a worker, and no consumer may drain the resume op the wake case counts.
 */
const FAKE = vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  process.env.RUN_PROFILES = 'api';
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
/** Booting waits on the outbox suite lock, which another relay suite may hold for minutes. */
const LOCKED_BOOT_TIMEOUT_MS = 600_000;
/** Over `fileCapBytes` (2 MiB): `info` refuses it before a byte is fetched. */
const OVER_CAP_BYTES = 3 * 1024 * 1024;

class ScriptedBreachPort implements BreachedPasswordPort {
  isBreached(_password: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/** Everything that legitimately differs between two identical refusals of different requests. */
function scrub(body: unknown): Record<string, unknown> {
  const parsed: Record<string, unknown> = { ...problemDetailSchema.parse(body) };

  delete parsed.instance;
  delete parsed.requestId;

  return parsed;
}

/**
 * Spec 022 US1 over the API (contracts/files.md § 1–3): the two read routes and the wake against
 * the fake Daytona, on a project with a registered sandbox. The service, controller and module are
 * T008/T009's; this suite only asks the routes what they answer.
 */
describe('Project files (e2e)', () => {
  describe.skipIf(!postgres || !redis)(
    'against Postgres, both Redis roles and a fake Daytona',
    () => {
      let app: INestApplication;
      let database: ForgeDatabase;
      let fake: FakeDaytona;
      let world: TwoTenantWorld;
      let transactions: TenantTransactionRunner;
      let suiteLock: { release: () => Promise<void> } | undefined;
      /** A project of alpha's, archived — the other half of the not-found pair. */
      let archivedProjectId: string;

      const filesOf = (orgId: string, projectId: string) =>
        `/api/v1/orgs/${orgId}/projects/${projectId}/files`;
      const files = () => filesOf(world.alpha.orgId, world.alpha.projectId);

      const list = (path: string) =>
        http(app).get(files()).query({ path }).set('Cookie', world.alpha.owner.cookie);
      const content = (path: string) =>
        http(app).get(`${files()}/content`).query({ path }).set('Cookie', world.alpha.owner.cookie);
      const wake = () => unsafe(http(app).post(`${files()}/wake`), [world.alpha.owner.cookie]);

      /** The resume ops the wake appended, whatever the relay would later do with them. */
      async function resumeOps(): Promise<unknown[]> {
        const rows = await database
          .select({ payload: schema.outbox.payload })
          .from(schema.outbox)
          .where(
            and(
              eq(schema.outbox.type, 'sandbox.op.requested'),
              eq(schema.outbox.originOrgId, world.alpha.orgId),
            ),
          );

        return rows.filter((row) => row.payload.op === 'resume');
      }

      beforeAll(async () => {
        // The fake's `sandbox-fake-*` ids are shared with the other sandbox suites: one at a time.
        suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
        fake = await startFakeDaytona({ port: FAKE.port });

        // The seeded tree: one file and one directory at the root, one file inside it, plus the
        // two files § 2 cannot render. `src/app.ts` must not appear in a listing of the root.
        fake.workspace.set(`${fake.workDir}/README.md`, {
          content: Buffer.from('# Demo\nhello\n'),
          kind: 'file',
        });
        fake.workspace.set(`${fake.workDir}/src/app.ts`, {
          content: Buffer.from("export const app = 'here';\n"),
          kind: 'file',
        });
        fake.workspace.set(`${fake.workDir}/logo.png`, {
          content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]),
          kind: 'file',
        });
        fake.workspace.set(`${fake.workDir}/huge.txt`, {
          content: Buffer.alloc(OVER_CAP_BYTES, 0x61),
          kind: 'file',
        });

        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(BREACHED_PASSWORD_PORT)
          .useClass(ScriptedBreachPort)
          // No lookup cache: every case sees the state the fake reports right now.
          .overrideProvider(DAYTONA_TIMINGS)
          .useValue({ ...DEFAULT_DAYTONA_TIMINGS, lookupTtlMs: 0 })
          .compile();

        app = moduleRef.createNestApplication();
        configureApplication(app);
        await app.init();

        database = app.get<ForgeDatabase>(APP_DATABASE);
        transactions = app.get(TenantTransactionRunner);
        world = await createTwoTenantWorld(app);

        const { orgId, owner, projectId, workspaceId } = world.alpha;
        await transactions.runInTenantScope({ orgId, userId: null }, (tx) =>
          app.get(SandboxService).register(tx, { daytonaId: fake.sandboxId, orgId, projectId }),
        );

        const archived = await transactions.runInTenantScope({ orgId, userId: owner.userId }, () =>
          app.get(ProjectService).create({
            actorId: owner.userId,
            name: 'Archived',
            orgId,
            ownerId: owner.userId,
            workspaceId,
          }),
        );
        archivedProjectId = archived.id;
        await transactions.runInTenantScope({ orgId, userId: owner.userId }, () =>
          app
            .get(ProjectService)
            .archive({ actorId: owner.userId, orgId, projectId: archived.id, workspaceId }),
        );
      }, LOCKED_BOOT_TIMEOUT_MS);

      afterAll(async () => {
        if (world) await destroyTwoTenantWorld(app, world);
        await app?.close();
        await fake?.close();
        await suiteLock?.release();
      });

      it("SC-001: lists the seeded tree one level at a time and reads a file's exact bytes", async () => {
        const root = fileListResponseSchema.parse((await list('').expect(200)).body);

        expect(root.path).toBe('');
        // One level: `src` is a directory here, and `src/app.ts` is not in this answer at all.
        expect(root.entries).toEqual([
          { kind: 'file', name: 'README.md', size: 13 },
          { kind: 'file', name: 'huge.txt', size: OVER_CAP_BYTES },
          { kind: 'file', name: 'logo.png', size: 9 },
          { kind: 'directory', name: 'src', size: expect.any(Number) as number },
        ]);

        const inner = fileListResponseSchema.parse((await list('src').expect(200)).body);

        expect(inner.path).toBe('src');
        expect(inner.entries).toEqual([{ kind: 'file', name: 'app.ts', size: 27 }]);

        const file = fileContentResponseSchema.parse(
          (await content('src/app.ts').expect(200)).body,
        );

        expect(file).toEqual({
          // Spec 024: the head at the read. This fixture has no checkpoint yet, so the nil uuid.
          baseCheckpointId: '00000000-0000-0000-0000-000000000000',
          bytes: 27,
          content: "export const app = 'here';\n",
          path: 'src/app.ts',
          renderable: true,
        });
      });

      it('FR-003: a binary file and an over-cap file are answered with their size, not thrown', async () => {
        const binary = fileContentResponseSchema.parse(
          (await content('logo.png').expect(200)).body,
        );

        expect(binary).toEqual({
          bytes: 9,
          path: 'logo.png',
          reason: 'binary',
          renderable: false,
        });

        const huge = fileContentResponseSchema.parse((await content('huge.txt').expect(200)).body);

        expect(huge).toEqual({
          bytes: OVER_CAP_BYTES,
          path: 'huge.txt',
          reason: 'too-large',
          renderable: false,
        });
      });

      /**
       * The refusal is the guard's `permission-denied` (403), not the service's `no-sandbox` (404):
       * `@RequirePermission('project:read')` runs first and neither project resolves a grant for
       * alpha. The property this case is actually about is unchanged and asserted below — the three
       * cases are indistinguishable — but the name's "not-found" describes the status the spec
       * expected, so T034's matrix row should say 403. Left as found: the routes are T009's.
       */
      it('a foreign org and an archived project are the same not-found', async () => {
        const probe = (orgId: string, projectId: string) =>
          http(app)
            .get(filesOf(orgId, projectId))
            .query({ path: '' })
            .set('Cookie', world.alpha.owner.cookie);

        const foreign = await probe(world.beta.orgId, world.beta.projectId);
        const archived = await probe(world.alpha.orgId, archivedProjectId);
        // The control: a project id that never existed. If the two above told alpha anything the
        // invented one does not, that difference is the existence leak.
        const invented = await probe(world.alpha.orgId, randomUUID());

        expect(foreign.status).toBe(403);
        expect(archived.status).toBe(foreign.status);
        expect(invented.status).toBe(foreign.status);
        // Byte for byte but for the request's own identifiers: a differing title, type, detail or
        // extension would tell alpha which of the three projects is real.
        expect(scrub(archived.body)).toEqual(scrub(foreign.body));
        expect(scrub(invented.body)).toEqual(scrub(foreign.body));
        // `instance` echoes the caller's own request line, so it is scrubbed above; nothing else
        // in the answer may name beta at all.
        for (const secret of world.beta.secrets) {
          expect(JSON.stringify(scrub(foreign.body))).not.toContain(secret);
        }
      });

      it('a path outside the root is bad-request', async () => {
        const escape = problemDetailSchema.parse((await list('../../etc/passwd').expect(400)).body);

        expect(escape.status).toBe(400);
        expect(escape).toMatchObject({ kind: 'path-escape' });

        const read = problemDetailSchema.parse(
          (await content('../../etc/passwd').expect(400)).body,
        );

        expect(read).toMatchObject({ kind: 'path-escape' });
      });

      it('a hibernated sandbox is a conflict naming the state, and wake answers resuming once', async () => {
        await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx
            .update(schema.sandboxes)
            .set({ hibernatedAt: new Date(), state: 'hibernated' })
            .where(eq(schema.sandboxes.projectId, world.alpha.projectId)),
        );

        const refused = problemDetailSchema.parse((await list('').expect(409)).body);

        expect(refused.status).toBe(409);
        expect(refused).toMatchObject({ kind: 'sandbox-not-ready', state: 'hibernated' });
        expect(refused.detail).toContain('hibernated');

        const first = wakeResponseSchema.parse((await wake().expect(200)).body);
        const second = wakeResponseSchema.parse((await wake().expect(200)).body);

        expect(first).toEqual({ because: 'resuming', ready: false });
        expect(second).toEqual(first);
        // Idempotent: the second call read the transition it found and enqueued nothing.
        expect(await resumeOps()).toHaveLength(1);
      });
    },
  );
});
