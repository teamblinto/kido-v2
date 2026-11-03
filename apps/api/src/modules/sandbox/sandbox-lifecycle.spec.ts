import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { type NewSandbox, schema } from '@repo/db';
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { holdOutboxSuiteLock } from '../../../test/support/outbox-suite-lock';
import { AppModule } from '../../app.module';
import { CLOCK } from '../../common/clock/clock.port';
import { FakeClock } from '../../common/clock/fake-clock';
import { APP_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { OrgService } from '../tenancy/services/org.service';
import { ProjectService } from '../tenancy/services/project.service';
import { DEFAULT_SANDBOX_TIMINGS } from './sandbox.constants';
import type { MutationContext } from './sandbox.port';
import { SandboxService } from './sandbox.service';
import { ClaimRaced, SandboxClaim } from './sandbox-claim';
import { SANDBOX_LIFECYCLE, type SandboxLifecycle } from './sandbox-lifecycle';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const START = '2026-09-16T12:00:00.000Z';
const CTX: MutationContext = { leaseEpoch: 4, operationId: 'run-9/step-3' };
/** Booting waits on the outbox suite lock, which another relay suite may hold for minutes. */
const LOCKED_BOOT_TIMEOUT_MS = 600_000;

/**
 * The readiness matrix of contracts/sandbox-lifecycle.md § 1 against the real row: what each
 * state answers, what it writes, and when the claim is reached for. The claim itself is
 * `sandbox-claim.spec.ts`; here it is a stub that answers what a pool or a cold create would.
 */
describe('SandboxLifecycleService', () => {
  describe.skipIf(!postgres || !redis)('against Postgres', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    let lifecycle: SandboxLifecycle;
    let clock: FakeClock;
    let orgId: string;
    let projectId: string;
    let userId: string;
    let suiteLock: { release: () => Promise<void> } | undefined;
    const claim = vi.fn<SandboxClaim['claim']>();

    const ref = () => ({ orgId, projectId });

    function inTenant<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantTransaction(orgId, fn);
    }

    async function seed(row: Partial<NewSandbox> = {}): Promise<string> {
      const [inserted] = await inTenant((tx) =>
        tx
          .insert(schema.sandboxes)
          .values({
            daytonaId: `life-${randomUUID()}`,
            lastSeenAt: new Date(START),
            orgId,
            projectId,
            stateEnteredAt: new Date(START),
            workspaceRoot: '/home/daytona',
            ...row,
          })
          .returning({ id: schema.sandboxes.id }),
      );
      return inserted!.id;
    }

    async function row() {
      return inTenant((tx) =>
        tx.query.sandboxes.findFirst({
          where: and(eq(schema.sandboxes.orgId, orgId), eq(schema.sandboxes.projectId, projectId)),
        }),
      );
    }

    async function opsFor(sandboxId: string) {
      const rows = await database
        .select({ payload: schema.outbox.payload })
        .from(schema.outbox)
        .where(
          and(
            eq(schema.outbox.type, 'sandbox.op.requested'),
            eq(schema.outbox.aggregateId, sandboxId),
          ),
        );
      return rows.map((entry) => entry.payload);
    }

    const ensureReady = () => inTenant((tx) => lifecycle.ensureReady(tx, ref(), CTX));

    beforeAll(async () => {
      // `AppModule` boots a relay against the shared outbox table: one relay-running suite at a time.
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
      clock = new FakeClock(START);
      moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(CLOCK)
        .useValue(clock)
        .overrideProvider(SandboxClaim)
        .useValue({ claim })
        .compile();
      await moduleRef.init();

      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      transactions = moduleRef.get(TenantTransactionRunner);
      lifecycle = moduleRef.get<SandboxLifecycle>(SANDBOX_LIFECYCLE, { strict: false });

      const [user] = await database
        .insert(schema.users)
        .values({ email: `014l-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });
      userId = user!.id;

      const org = await moduleRef.get(OrgService).create(userId, {
        name: 'Lifecycle fixture',
        slug: `014l-${randomUUID().slice(0, 8)}`,
      });
      orgId = org.id;

      const [workspace] = await transactions.runInTenantTransaction(orgId, (tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      );
      const project = await transactions.runInTenantScope({ orgId, userId }, () =>
        moduleRef.get(ProjectService).create({
          actorId: userId,
          name: 'Lifecycle',
          orgId,
          ownerId: userId,
          template: 'node-api',
          workspaceId: workspace!.id,
        }),
      );
      projectId = project.id;
    }, LOCKED_BOOT_TIMEOUT_MS);

    beforeEach(async () => {
      claim.mockReset();
      clock.set(START);
      await inTenant((tx) => tx.delete(schema.sandboxes).where(eq(schema.sandboxes.orgId, orgId)));
    });

    afterAll(async () => {
      await database.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
      await database.delete(schema.users).where(inArray(schema.users.id, [userId]));
      await moduleRef?.close();
      await suiteLock?.release();
    });

    it('answers ready for an active row with no transition, touching nothing', async () => {
      const id = await seed({ state: 'active' });
      clock.advance(5 * 60_000);

      expect(await ensureReady()).toEqual({ ready: true });

      expect(await row()).toMatchObject({
        id,
        state: 'active',
        stateEnteredAt: new Date(START),
        transition: null,
      });
      expect(claim).not.toHaveBeenCalled();
      expect(await opsFor(id)).toEqual([]);
    });

    it('flips an idle row to active with state_entered_at moved, and answers ready', async () => {
      const id = await seed({ state: 'idle' });
      clock.advance(5 * 60_000);

      expect(await ensureReady()).toEqual({ ready: true });

      expect(await row()).toMatchObject({
        id,
        state: 'active',
        stateEnteredAt: clock.now(),
        transition: null,
      });
      expect(await opsFor(id)).toEqual([]);
    });

    it('records resuming on a hibernated row, appends the resume op and answers not ready', async () => {
      const id = await seed({ hibernatedAt: new Date(START), state: 'hibernated' });
      clock.advance(60_000);

      expect(await ensureReady()).toEqual({ because: 'resuming', ready: false });

      expect(await row()).toMatchObject({
        id,
        state: 'hibernated',
        transition: 'resuming',
        transitionSince: clock.now(),
      });
      expect(await opsFor(id)).toEqual([
        {
          leaseEpoch: CTX.leaseEpoch,
          op: 'resume',
          operationId: CTX.operationId,
          orgId,
          sandboxId: id,
        },
      ]);
      expect(claim).not.toHaveBeenCalled();
    });

    it('answers the transition of a row in flight without touching it', async () => {
      const id = await seed({
        state: 'active',
        transition: 'creating',
        transitionSince: new Date(START),
        workspaceRoot: null,
      });
      clock.advance(60_000);

      expect(await ensureReady()).toEqual({ because: 'creating', ready: false });

      expect(await row()).toMatchObject({
        id,
        transition: 'creating',
        transitionSince: new Date(START),
      });
      expect(await opsFor(id)).toEqual([]);
      expect(claim).not.toHaveBeenCalled();
    });

    it('claims when there is no row, answering what the claim answered', async () => {
      claim.mockResolvedValueOnce({ ready: true });
      expect(await ensureReady()).toEqual({ ready: true });

      claim.mockResolvedValueOnce({ because: 'creating', ready: false });
      expect(await ensureReady()).toEqual({ because: 'creating', ready: false });

      expect(claim).toHaveBeenCalledTimes(2);
      expect(claim).toHaveBeenLastCalledWith(expect.anything(), ref(), 'node-api', CTX);
    });

    it('claims when the row is lost', async () => {
      await seed({ lostAt: new Date(START), state: 'active' });
      claim.mockResolvedValueOnce({ ready: true });

      expect(await ensureReady()).toEqual({ ready: true });

      expect(claim).toHaveBeenCalledWith(expect.anything(), ref(), 'node-api', CTX);
    });

    it('re-reads the row on ClaimRaced and answers from it', async () => {
      claim.mockImplementationOnce(async () => {
        // The other run's claim committed while ours was in flight.
        await seed({ state: 'hibernated', hibernatedAt: new Date(START) });
        throw new ClaimRaced();
      });

      expect(await ensureReady()).toEqual({ because: 'resuming', ready: false });

      expect(claim).toHaveBeenCalledTimes(1);
      expect(await row()).toMatchObject({ transition: 'resuming' });
    });

    describe('touch', () => {
      const touch = () => inTenant((tx) => lifecycle.touch(tx, ref()));

      it('writes last_seen_at only when the last one is older than touchCoalesceMs', async () => {
        const id = await seed({ state: 'active' });
        clock.advance(DEFAULT_SANDBOX_TIMINGS.touchCoalesceMs - 1);
        await touch();
        expect(await row()).toMatchObject({ id, lastSeenAt: new Date(START) });

        clock.advance(2);
        await touch();
        expect(await row()).toMatchObject({
          id,
          lastSeenAt: clock.now(),
          state: 'active',
          stateEnteredAt: new Date(START),
        });
      });

      it('flips idle to active and moves state_entered_at in the same UPDATE', async () => {
        const id = await seed({ lastSeenAt: null, state: 'idle' });
        clock.advance(60_000);

        await touch();

        expect(await row()).toMatchObject({
          id,
          lastSeenAt: clock.now(),
          state: 'active',
          stateEnteredAt: clock.now(),
        });
      });

      it('is silent on a missing row', async () => {
        await expect(touch()).resolves.toBeUndefined();
        expect(await row()).toBeUndefined();
      });
    });

    /** FR-018: a `sandbox_pool` row is nobody's sandbox — the port reads `sandboxes` alone. */
    it('resolves a project whose only candidate is a sandbox_pool row to no-sandbox', async () => {
      const [pool] = await database
        .insert(schema.sandboxPool)
        .values({ daytonaId: `pool-${projectId}`, snapshot: 'snap', template: 'node-api' })
        .returning({ id: schema.sandboxPool.id });
      const port = moduleRef.get(SandboxService, { strict: false });

      try {
        const attempt = transactions.runInTenantScope({ orgId, userId: null }, () =>
          port.list(ref(), '.'),
        );
        await expect(attempt).rejects.toMatchObject({ kind: 'no-sandbox' });
      } finally {
        await database.delete(schema.sandboxPool).where(eq(schema.sandboxPool.id, pool!.id));
      }
    });

    it('throws no-sandbox when the project does not exist', async () => {
      const attempt = inTenant((tx) =>
        lifecycle.ensureReady(tx, { orgId, projectId: randomUUID() }, CTX),
      );

      await expect(attempt).rejects.toMatchObject({ kind: 'no-sandbox' });
      expect(claim).not.toHaveBeenCalled();
    });
  });
});
