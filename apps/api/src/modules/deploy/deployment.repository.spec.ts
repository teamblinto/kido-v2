import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { type Deployment, schema } from '@repo/db';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { AppModule } from '../../app.module';
import { DomainError } from '../../common/errors/domain-error';
import { APP_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { OrgService } from '../tenancy/services/org.service';
import { ProjectService } from '../tenancy/services/project.service';
import { DeploymentRepository } from './deployment.repository';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

/**
 * Spec 027 R8 against real Postgres, as `checkpoint.repository.spec.ts` is: the one-in-flight
 * index, the claim's CAS and the epoch fence are `where` clauses and a partial unique index — a
 * fake would only prove them about the fake.
 */
describe('DeploymentRepository', () => {
  describe.skipIf(!postgres || !redis)('against Postgres', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    const repository = new DeploymentRepository();
    let orgId: string;
    let projectId: string;
    let checkpointId: string;
    let userId: string;
    const now = new Date('2026-09-22T12:00:00.000Z');

    function inTenant<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantTransaction(orgId, fn);
    }

    function queue(): Promise<Deployment | undefined> {
      return inTenant((tx) =>
        repository.insertQueued(tx, {
          checkpointId,
          orgId,
          projectId,
          requestedBy: userId,
          template: 'vite-react',
        }),
      );
    }

    async function state(id: string): Promise<Deployment> {
      return (await inTenant((tx) => repository.byId(tx, orgId, projectId, id)))!;
    }

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await moduleRef.init();

      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      transactions = moduleRef.get(TenantTransactionRunner);

      const [user] = await database
        .insert(schema.users)
        .values({ email: `027r-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });

      userId = user!.id;

      const org = await moduleRef.get(OrgService).create(userId, {
        name: 'Deployment repository fixture',
        slug: `027r-${randomUUID().slice(0, 8)}`,
      });

      orgId = org.id;
    }, 60_000);

    afterAll(async () => {
      if (orgId !== undefined) await database.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
      if (userId !== undefined)
        await database.delete(schema.users).where(eq(schema.users.id, userId));
      await moduleRef?.close();
    });

    /**
     * Each case gets its own project and checkpoint, so the partial index and the list are never
     * another case's (`forge_app` has no DELETE on `deployments` to clean up with).
     */
    beforeEach(async () => {
      const [workspace] = await inTenant((tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      );
      const project = await transactions.runInTenantScope({ orgId, userId }, () =>
        moduleRef.get(ProjectService).create({
          actorId: userId,
          name: 'Site',
          orgId,
          ownerId: userId,
          workspaceId: workspace!.id,
        }),
      );

      projectId = project.id;

      const [checkpoint] = await inTenant((tx) =>
        tx
          .insert(schema.checkpoints)
          .values({
            files: [],
            gitSha: 'a'.repeat(40),
            kind: 'baseline',
            label: 'Baseline: workspace as found',
            orgId,
            projectId,
          })
          .returning({ id: schema.checkpoints.id }),
      );

      checkpointId = checkpoint!.id;
    });

    it('insertQueued catches 23505 on deployments_one_in_flight and leaves the transaction usable', async () => {
      const first = await queue();

      expect(first).toMatchObject({ attempts: 0, leaseEpoch: 0, state: 'queued' });

      // Same transaction after the refusal: the savepoint kept it alive, so the in-flight row is
      // still readable for the `deploy-active` answer.
      const [second, inFlight] = await inTenant(async (tx) => {
        const refused = await repository.insertQueued(tx, {
          checkpointId,
          orgId,
          projectId,
          requestedBy: userId,
          template: 'vite-react',
        });

        return [refused, await repository.inFlight(tx, orgId, projectId)] as const;
      });

      expect(second).toBeUndefined();
      expect(inFlight?.id).toBe(first!.id);

      // Terminal rows leave the index: once settled, a new request goes in.
      const claimed = await inTenant((tx) => repository.claim(tx, orgId, first!.id, now));
      await inTenant((tx) =>
        repository.fail(tx, orgId, first!.id, claimed!.leaseEpoch, {
          finishedAt: now,
          reason: 'build-failed',
        }),
      );
      expect(await inTenant((tx) => repository.inFlight(tx, orgId, projectId))).toBeUndefined();
      expect(await queue()).toMatchObject({ state: 'queued' });
    });

    it('claim bumps lease_epoch and attempts, restarts started_at for the attempt, and refuses once upload_started_at is set', async () => {
      const row = (await queue())!;
      const later = new Date(now.getTime() + 60_000);

      const first = await inTenant((tx) => repository.claim(tx, orgId, row.id, now));
      expect(first).toMatchObject({
        attempts: 1,
        leaseEpoch: 1,
        startedAt: now,
        state: 'building',
      });

      // A re-delivered job before upload claims again: new epoch, and started_at is this
      // attempt's, so the stale sweep measures the attempt that is running (R8).
      const second = await inTenant((tx) => repository.claim(tx, orgId, row.id, later));
      expect(second).toMatchObject({
        attempts: 2,
        leaseEpoch: 2,
        startedAt: later,
        state: 'building',
      });

      expect(await inTenant((tx) => repository.markUploading(tx, orgId, row.id, 2, later))).toBe(
        true,
      );
      expect(await inTenant((tx) => repository.claim(tx, orgId, row.id, later))).toBeUndefined();
      expect(await state(row.id)).toMatchObject({
        leaseEpoch: 2,
        state: 'uploading',
        uploadStartedAt: later,
      });

      // An unknown id claims nothing.
      expect(
        await inTenant((tx) => repository.claim(tx, orgId, randomUUID(), now)),
      ).toBeUndefined();
    });

    it('records the toolchain pin at claim, fenced', async () => {
      const row = (await queue())!;
      const { leaseEpoch } = (await inTenant((tx) => repository.claim(tx, orgId, row.id, now)))!;
      const pin = { templateDigest: 'sha256:abc', templateSnapshot: 'forge-vite-react-v3' };

      expect(
        await inTenant((tx) => repository.recordToolchain(tx, orgId, row.id, leaseEpoch - 1, pin)),
      ).toBe(false);
      expect(
        await inTenant((tx) => repository.recordToolchain(tx, orgId, row.id, leaseEpoch, pin)),
      ).toBe(true);
      expect(await state(row.id)).toMatchObject(pin);
    });

    it('every fenced write affects zero rows under a stale epoch', async () => {
      const row = (await queue())!;
      await inTenant((tx) => repository.claim(tx, orgId, row.id, now));
      const { leaseEpoch } = (await inTenant((tx) => repository.claim(tx, orgId, row.id, now)))!;
      const stale = leaseEpoch - 1;

      expect(await inTenant((tx) => repository.markUploading(tx, orgId, row.id, stale, now))).toBe(
        false,
      );
      expect(
        await inTenant((tx) =>
          repository.fail(tx, orgId, row.id, stale, { finishedAt: now, reason: 'platform' }),
        ),
      ).toBe(false);
      expect(await inTenant((tx) => repository.writeLog(tx, orgId, row.id, stale, 'stale'))).toBe(
        false,
      );

      await inTenant((tx) => repository.markUploading(tx, orgId, row.id, leaseEpoch, now));
      expect(
        await inTenant((tx) =>
          repository.succeed(tx, orgId, row.id, stale, {
            artifactSha: 'f'.repeat(64),
            fileCount: 1,
            finishedAt: now,
            totalBytes: 1,
          }),
        ),
      ).toBe(false);

      expect(await state(row.id)).toMatchObject({
        artifactSha: null,
        failureReason: null,
        logTail: null,
        state: 'uploading',
      });

      // The live epoch goes through, and the log is written with it.
      expect(
        await inTenant((tx) =>
          repository.succeed(tx, orgId, row.id, leaseEpoch, {
            artifactSha: 'f'.repeat(64),
            fileCount: 3,
            finishedAt: now,
            logTail: 'built',
            totalBytes: 42,
          }),
        ),
      ).toBe(true);
      expect(await state(row.id)).toMatchObject({
        artifactSha: 'f'.repeat(64),
        fileCount: 3,
        finishedAt: now,
        logTail: 'built',
        state: 'succeeded',
        totalBytes: 42,
      });
    });

    it('never updates a terminal row, whatever the epoch or the write', async () => {
      const cases: {
        settle: (tx: TenantTransaction, id: string, epoch: number) => Promise<unknown>;
      }[] = [
        {
          settle: async (tx, id, epoch) => {
            await repository.markUploading(tx, orgId, id, epoch, now);
            await repository.succeed(tx, orgId, id, epoch, {
              artifactSha: 'e'.repeat(64),
              fileCount: 1,
              finishedAt: now,
              totalBytes: 1,
            });
          },
        },
        {
          settle: (tx, id, epoch) =>
            repository.fail(tx, orgId, id, epoch, { finishedAt: now, reason: 'build-failed' }),
        },
        { settle: (tx) => repository.cancelInFlight(tx, orgId, projectId, now) },
      ];

      for (const { settle } of cases) {
        const row = (await queue())!;
        const { leaseEpoch } = (await inTenant((tx) => repository.claim(tx, orgId, row.id, now)))!;
        await inTenant((tx) => settle(tx, row.id, leaseEpoch));
        const settled = await state(row.id);
        const epoch = settled.leaseEpoch;

        expect(['succeeded', 'failed', 'cancelled']).toContain(settled.state);

        const writes = await inTenant(async (tx) => [
          await repository.claim(tx, orgId, row.id, now),
          await repository.recordToolchain(tx, orgId, row.id, epoch, {
            templateDigest: 'x',
            templateSnapshot: 'x',
          }),
          await repository.markUploading(tx, orgId, row.id, epoch, now),
          await repository.writeLog(tx, orgId, row.id, epoch, 'late'),
          await repository.succeed(tx, orgId, row.id, epoch, {
            artifactSha: 'd'.repeat(64),
            fileCount: 9,
            finishedAt: now,
            totalBytes: 9,
          }),
          await repository.fail(tx, orgId, row.id, epoch, { finishedAt: now, reason: 'platform' }),
          await repository.failPastUpload(tx, orgId, row.id, now),
          await repository.cancelInFlight(tx, orgId, projectId, now),
          // The sweep is org-wide; only this row is this case's business.
          (await repository.failStale(tx, orgId, new Date(now.getTime() + 3_600_000), now)).filter(
            (swept) => swept.id === row.id,
          ),
        ]);

        expect(writes).toEqual([undefined, false, false, false, false, false, false, [], []]);
        expect(await state(row.id)).toEqual(settled);
      }
    });

    it('failPastUpload settles a re-delivered row past the upload boundary as platform and bumps the epoch', async () => {
      const row = (await queue())!;
      const { leaseEpoch } = (await inTenant((tx) => repository.claim(tx, orgId, row.id, now)))!;
      await inTenant((tx) => repository.markUploading(tx, orgId, row.id, leaseEpoch, now));

      expect(await inTenant((tx) => repository.failPastUpload(tx, orgId, row.id, now))).toBe(true);
      expect(await state(row.id)).toMatchObject({
        failureReason: 'platform',
        finishedAt: now,
        leaseEpoch: leaseEpoch + 1,
        state: 'failed',
      });
    });

    it('cancelInFlight cancels the in-flight row with an epoch bump, fencing the old worker out', async () => {
      const row = (await queue())!;
      const { leaseEpoch } = (await inTenant((tx) => repository.claim(tx, orgId, row.id, now)))!;

      const cancelled = await inTenant((tx) =>
        repository.cancelInFlight(tx, orgId, projectId, now),
      );
      expect(cancelled).toEqual([row.id]);
      expect(await state(row.id)).toMatchObject({
        finishedAt: now,
        leaseEpoch: leaseEpoch + 1,
        state: 'cancelled',
      });
      expect(
        await inTenant((tx) => repository.markUploading(tx, orgId, row.id, leaseEpoch, now)),
      ).toBe(false);
    });

    it('failStale fails building/uploading rows started before the threshold as platform, and leaves younger ones', async () => {
      const row = (await queue())!;
      const { leaseEpoch } = (await inTenant((tx) => repository.claim(tx, orgId, row.id, now)))!;

      const mine = (swept: { projectId: string }[]) =>
        swept.filter((entry) => entry.projectId === projectId);

      expect(mine(await inTenant((tx) => repository.failStale(tx, orgId, now, now)))).toEqual([]);
      expect((await state(row.id)).state).toBe('building');

      const settled = await inTenant((tx) =>
        repository.failStale(tx, orgId, new Date(now.getTime() + 1), now),
      );
      expect(mine(settled)).toEqual([expect.objectContaining({ id: row.id, projectId })]);
      expect(await state(row.id)).toMatchObject({
        failureReason: 'platform',
        leaseEpoch: leaseEpoch + 1,
        state: 'failed',
      });
    });

    it('the keyset list pages newest first, (created_at, id) as the tiebreaker, and refuses a foreign cursor', async () => {
      const ids: string[] = [];

      for (let index = 0; index < 5; index++) {
        const row = (await queue())!;
        const { leaseEpoch } = (await inTenant((tx) => repository.claim(tx, orgId, row.id, now)))!;
        await inTenant((tx) =>
          repository.fail(tx, orgId, row.id, leaseEpoch, { finishedAt: now, reason: 'timeout' }),
        );
        ids.push(row.id);
      }

      // Two rows share one instant so the id alone has to order them.
      const shared = new Date('2026-09-22T00:00:00.000Z');
      await inTenant((tx) =>
        tx
          .update(schema.deployments)
          .set({ createdAt: shared })
          .where(eq(schema.deployments.id, ids[0]!)),
      );
      await inTenant((tx) =>
        tx
          .update(schema.deployments)
          .set({ createdAt: shared })
          .where(eq(schema.deployments.id, ids[1]!)),
      );
      const tied = [ids[0]!, ids[1]!].sort().reverse();
      const newestFirst = [ids[4], ids[3], ids[2], ...tied];

      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await inTenant((tx) =>
          repository.list(tx, orgId, projectId, { cursor, limit: 2 }),
        );
        seen.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor ?? undefined;
        if (cursor !== undefined) expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/u);
      } while (cursor !== undefined);

      expect(seen).toEqual(newestFirst);
      expect(
        await inTenant((tx) => repository.list(tx, orgId, randomUUID(), { limit: 10 })),
      ).toEqual({ items: [], nextCursor: null });
      await expect(
        inTenant((tx) => repository.list(tx, orgId, projectId, { cursor: 'bm9wZQ', limit: 2 })),
      ).rejects.toThrow(DomainError);
    });

    it('byId is scoped to the project', async () => {
      const row = (await queue())!;

      expect((await inTenant((tx) => repository.byId(tx, orgId, projectId, row.id)))?.id).toBe(
        row.id,
      );
      expect(
        await inTenant((tx) => repository.byId(tx, orgId, randomUUID(), row.id)),
      ).toBeUndefined();
    });
  });
});
