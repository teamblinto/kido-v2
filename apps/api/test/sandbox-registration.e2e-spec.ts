import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { ConflictError } from '../src/common/errors/domain-error';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../src/modules/identity/password/breached-password.port';
import { DAYTONA_TIMINGS, DEFAULT_DAYTONA_TIMINGS } from '../src/modules/sandbox/sandbox.constants';
import { DaytonaError, SandboxGuardError } from '../src/modules/sandbox/sandbox.errors';
import { SANDBOX_PORT, type SandboxPort } from '../src/modules/sandbox/sandbox.port';
import { SandboxService } from '../src/modules/sandbox/sandbox.service';
import { ProjectService } from '../src/modules/tenancy/services/project.service';
import { type FakeDaytona, startFakeDaytona } from './support/fake-daytona';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

/**
 * Before any import: `ConfigModule.forRoot` reads the environment when `AppModule` is loaded, so
 * the fake's address must be known first — a port picked here, listened on in `beforeAll`. Set
 * explicitly rather than defaulted, because `apps/api/.env` may name a real Daytona and this suite
 * must never reach it.
 */
const FAKE = vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';

  const port = 20_000 + Math.floor(Math.random() * 20_000);
  process.env.DAYTONA_API_URL = `http://127.0.0.1:${port}/api`;
  process.env.DAYTONA_API_KEY = 'dtn_fake_key';

  return { port };
});

const postgres = inject('postgresReachable');
/** Booting waits on the outbox suite lock, which another relay suite may hold for minutes. */
const LOCKED_BOOT_TIMEOUT_MS = 600_000;
const redis = inject('redisReachable');

class ScriptedBreachPort implements BreachedPasswordPort {
  isBreached(_password: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/**
 * Spec 010 US3: `SandboxService.register` — the script's one call — writes the `sandboxes` row and
 * its audit row in one tenant transaction against the fake Daytona, refuses what Daytona refuses,
 * refuses a conflict, and leaves a row the other tenant cannot see.
 */
describe('Sandbox registration (e2e)', () => {
  describe.skipIf(!postgres || !redis)(
    'against Postgres, both Redis roles and a fake Daytona',
    () => {
      let app: INestApplication;
      let fake: FakeDaytona;
      let world: TwoTenantWorld;
      let transactions: TenantTransactionRunner;
      let service: SandboxService;
      let suiteLock: { release: () => Promise<void> } | undefined;

      function register(projectId: string, daytonaId: string) {
        const { orgId } = world.alpha;

        return transactions.runInTenantScope({ orgId, userId: null }, (tx) =>
          service.register(tx, { daytonaId, orgId, projectId }),
        );
      }

      async function rowsOf(orgId: string) {
        return transactions.runInTenantTransaction(orgId, (tx) =>
          tx.select().from(schema.sandboxes),
        );
      }

      /** A second live project in alpha, owned by alpha's owner. */
      async function anotherProject(name: string): Promise<string> {
        const { orgId, owner, workspaceId } = world.alpha;
        const project = await transactions.runInTenantScope({ orgId, userId: owner.userId }, () =>
          app
            .get(ProjectService)
            .create({ actorId: owner.userId, name, orgId, ownerId: owner.userId, workspaceId }),
        );

        return project.id;
      }

      beforeAll(async () => {
        // `AppModule` and the fake's `sandbox-fake-*` ids are shared with the other sandbox suites:
        // one at a time, as every suite that boots the app.
        suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
        fake = await startFakeDaytona({ port: FAKE.port });

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

        transactions = app.get(TenantTransactionRunner);
        service = app.get(SandboxService);
        world = await createTwoTenantWorld(app);
      }, LOCKED_BOOT_TIMEOUT_MS);

      afterAll(async () => {
        await destroyTwoTenantWorld(app, world);
        await app?.close();
        await fake?.close();
        await suiteLock?.release();
      });

      it.each([
        ['unknown', 'sandbox-not-found', 'sandbox-nobody-knows', 'started'],
        ['stopped', 'sandbox-not-running', 'sandbox-fake-0001', 'stopped'],
      ] as const)(
        'refuses an unknown or stopped sandbox with no row (%s)',
        async (_, kind, daytonaId, state) => {
          fake.sandboxState(state);

          try {
            const error: unknown = await register(world.alpha.projectId, daytonaId).catch(
              (e: unknown) => e,
            );

            expect(error).toBeInstanceOf(DaytonaError);
            expect((error as DaytonaError).kind).toBe(kind);
            expect(await rowsOf(world.alpha.orgId)).toEqual([]);
          } finally {
            fake.sandboxState('started');
          }
        },
      );

      it('registers a running sandbox against a project with one row and one audit row', async () => {
        const { orgId, projectId } = world.alpha;
        const registered = await register(projectId, fake.sandboxId);

        expect(registered).toEqual({
          id: expect.any(String) as string,
          node: fake.runnerId,
          workspaceRoot: fake.workDir,
        });

        const rows = await rowsOf(orgId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          daytonaId: fake.sandboxId,
          id: registered.id,
          node: fake.runnerId,
          orgId,
          ports: {},
          projectId,
          state: 'active',
          workspaceRoot: fake.workDir,
        });

        const audit = await transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .select({ action: schema.auditLog.action, metadata: schema.auditLog.metadata })
            .from(schema.auditLog)
            .where(eq(schema.auditLog.target, registered.id)),
        );
        expect(audit).toEqual([
          {
            action: 'sandbox.registered',
            metadata: { daytonaId: fake.sandboxId, node: fake.runnerId, projectId },
          },
        ]);
      });

      it('refuses a second sandbox for the project and a second project for the id', async () => {
        const { orgId, projectId } = world.alpha;
        const [before] = await rowsOf(orgId);
        fake.addSandbox('sandbox-fake-0002');
        const other = await anotherProject('Second');

        await expect(register(projectId, 'sandbox-fake-0002')).rejects.toBeInstanceOf(
          ConflictError,
        );
        await expect(register(other, fake.sandboxId)).rejects.toBeInstanceOf(ConflictError);

        expect(await rowsOf(orgId)).toEqual([before]);
      });

      it('hides the row from the other tenant', async () => {
        expect(await rowsOf(world.beta.orgId)).toEqual([]);
      });

      it('answers no-sandbox for an archived project', async () => {
        const { orgId, owner, projectId, workspaceId } = world.alpha;
        const port = app.get<SandboxPort>(SANDBOX_PORT);

        await transactions.runInTenantScope({ orgId, userId: owner.userId }, () =>
          app.get(ProjectService).archive({ actorId: owner.userId, orgId, projectId, workspaceId }),
        );

        const error: unknown = await transactions
          .runInTenantScope({ orgId, userId: null }, () =>
            port.read({ orgId, projectId }, 'anything.txt'),
          )
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(SandboxGuardError);
        expect((error as SandboxGuardError).kind).toBe('no-sandbox');
      });
    },
  );
});
