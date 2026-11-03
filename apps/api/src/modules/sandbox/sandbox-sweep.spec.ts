import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type NewSandbox, schema } from '@repo/db';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { holdOutboxSuiteLock } from '../../../test/support/outbox-suite-lock';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  type Tenant,
  type TwoTenantWorld,
} from '../../../test/support/two-tenant-fixture';
import { AppModule } from '../../app.module';
import { configureApplication } from '../../bootstrap';
import { APP_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { DEFAULT_SANDBOX_TIMINGS } from './sandbox.constants';
import { SandboxSweep } from './sandbox-sweep';

/** Before any import, as the e2e suites: `ConfigModule` reads the env once. */
vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.THROTTLE_LIMIT = '100000';
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const MINUTE = 60_000;
/** Booting waits on the outbox suite lock, which another relay suite may hold for minutes. */
const LOCKED_BOOT_TIMEOUT_MS = 600_000;

/**
 * Spec 014 research R8: the sweep is two statements per live organisation, each under its own
 * tenant transaction, over `sandboxes` alone — a run in flight keeps `last_seen_at` fresh by
 * heartbeat, so the sweep never reads `agent_runs`. Against the real database, two tenants.
 */
describe('SandboxSweep', () => {
  describe.skipIf(!postgres || !redis)('against Postgres, two tenants', () => {
    let app: INestApplication;
    let db: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    let sweep: SandboxSweep;
    let world: TwoTenantWorld;
    let suiteLock: { release: () => Promise<void> } | undefined;

    const ago = (ms: number) => new Date(Date.now() - ms);

    async function seed(tenant: Tenant, row: Partial<NewSandbox> = {}): Promise<string> {
      const [inserted] = await transactions.runInTenantTransaction(tenant.orgId, (tx) =>
        tx
          .insert(schema.sandboxes)
          .values({
            daytonaId: `sweep-${randomUUID()}`,
            lastSeenAt: new Date(),
            orgId: tenant.orgId,
            projectId: tenant.projectId,
            stateEnteredAt: new Date(),
            workspaceRoot: '/home/daytona',
            ...row,
          })
          .returning({ id: schema.sandboxes.id }),
      );

      return inserted!.id;
    }

    async function row(tenant: Tenant, id: string) {
      const [found] = await transactions.runInTenantTransaction(tenant.orgId, (tx) =>
        tx.select().from(schema.sandboxes).where(eq(schema.sandboxes.id, id)),
      );

      return found!;
    }

    async function opsFor(sandboxId: string) {
      const rows = await db
        .select({ orgId: schema.outbox.originOrgId, payload: schema.outbox.payload })
        .from(schema.outbox)
        .where(
          and(
            eq(schema.outbox.type, 'sandbox.op.requested'),
            eq(schema.outbox.aggregateId, sandboxId),
          ),
        );

      return rows;
    }

    beforeAll(async () => {
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      configureApplication(app);
      await app.init();

      db = app.get<ForgeDatabase>(APP_DATABASE);
      transactions = app.get(TenantTransactionRunner);
      sweep = app.get(SandboxSweep, { strict: false });
      world = await createTwoTenantWorld(app);
    }, LOCKED_BOOT_TIMEOUT_MS);

    afterEach(async () => {
      for (const tenant of [world.alpha, world.beta]) {
        await transactions.runInTenantTransaction(tenant.orgId, (tx) =>
          tx.delete(schema.sandboxes).where(eq(schema.sandboxes.orgId, tenant.orgId)),
        );
      }
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      if (world) await destroyTwoTenantWorld(app, world);
      await app?.close();
      await suiteLock?.release();
    });

    it('idles an active row unseen for idleAfterMs in every live org, moving state_entered_at', async () => {
      const before = new Date();
      const alpha = await seed(world.alpha, {
        lastSeenAt: ago(DEFAULT_SANDBOX_TIMINGS.idleAfterMs + MINUTE),
        stateEnteredAt: ago(2 * DEFAULT_SANDBOX_TIMINGS.idleAfterMs),
      });
      const beta = await seed(world.beta, {
        lastSeenAt: ago(DEFAULT_SANDBOX_TIMINGS.idleAfterMs + MINUTE),
      });

      expect(await sweep.sweep()).toMatchObject({ idled: 2 });

      for (const [tenant, id] of [
        [world.alpha, alpha],
        [world.beta, beta],
      ] as const) {
        const after = await row(tenant, id);
        expect(after).toMatchObject({ id, state: 'idle', transition: null });
        expect(after.stateEnteredAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
        expect(await opsFor(id)).toEqual([]);
      }
    });

    it('leaves an active row touched within the window alone, as a heartbeat would', async () => {
      const entered = ago(3 * DEFAULT_SANDBOX_TIMINGS.idleAfterMs);
      const id = await seed(world.alpha, {
        lastSeenAt: ago(DEFAULT_SANDBOX_TIMINGS.idleAfterMs - MINUTE),
        stateEnteredAt: entered,
      });

      expect(await sweep.sweep()).toMatchObject({ idled: 0 });

      expect(await row(world.alpha, id)).toMatchObject({
        state: 'active',
        stateEnteredAt: entered,
        transition: null,
      });
    });

    it('marks an idle row hibernating after hibernateAfterMs and appends the hibernate op, once', async () => {
      const before = new Date();
      const id = await seed(world.beta, {
        state: 'idle',
        stateEnteredAt: ago(DEFAULT_SANDBOX_TIMINGS.hibernateAfterMs + MINUTE),
      });
      const young = await seed(world.alpha, {
        state: 'idle',
        stateEnteredAt: ago(DEFAULT_SANDBOX_TIMINGS.hibernateAfterMs - MINUTE),
      });

      expect(await sweep.sweep()).toMatchObject({ hibernating: 1 });

      const after = await row(world.beta, id);
      expect(after).toMatchObject({ state: 'idle', transition: 'hibernating' });
      expect(after.transitionSince!.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(await opsFor(id)).toEqual([
        {
          orgId: world.beta.orgId,
          payload: { op: 'hibernate', orgId: world.beta.orgId, sandboxId: id },
        },
      ]);
      expect(await row(world.alpha, young)).toMatchObject({ state: 'idle', transition: null });

      // A second pass finds the transition set and appends nothing (FR-009, FR-010).
      expect(await sweep.sweep()).toMatchObject({ hibernating: 0 });
      expect(await opsFor(id)).toHaveLength(1);
    });

    it('counts a hibernated row older than archiveAfterMs, logs the refusal and touches nothing (FR-013)', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const hibernatedAt = ago(DEFAULT_SANDBOX_TIMINGS.archiveAfterMs + 24 * 60 * MINUTE);
      const id = await seed(world.alpha, {
        hibernatedAt,
        state: 'hibernated',
        stateEnteredAt: hibernatedAt,
      });

      expect(await sweep.sweep()).toMatchObject({ archiveRefused: 1 });

      expect(await row(world.alpha, id)).toMatchObject({
        hibernatedAt,
        state: 'hibernated',
        stateEnteredAt: hibernatedAt,
        transition: null,
      });
      expect(await opsFor(id)).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('archive refused'));
    });

    it('imports nothing from modules/agent and reads no table but sandboxes (research R8)', () => {
      const source = readFileSync(join(__dirname, 'sandbox-sweep.ts'), 'utf8');

      expect(source).not.toMatch(/from '\.\.\/agent/);
      expect(source).not.toMatch(/agentRuns|agent_runs|runEvents|sandboxPool/);
    });
  });
});
