import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { type NewCheckpoint, schema } from '@repo/db';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { AppModule } from '../../app.module';
import { DomainError } from '../../common/errors/domain-error';
import { APP_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { OrgService } from '../tenancy/services/org.service';
import { ProjectService } from '../tenancy/services/project.service';
import { CheckpointRepository } from './checkpoint.repository';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

/**
 * Spec 016 R5 and contracts § 2, against real Postgres as `run-store.spec.ts` is: the sha is the
 * idempotency key and the `(created_at, id)` keyset walks the whole history once — both are
 * `where` clauses a fake would only prove about the fake.
 */
describe('CheckpointRepository', () => {
  describe.skipIf(!postgres || !redis)('against Postgres', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let repository: CheckpointRepository;
    let transactions: TenantTransactionRunner;
    let orgId: string;
    let projectId: string;
    let userId: string;

    function inTenant<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantTransaction(orgId, fn);
    }

    /** One `turn` row after `parentId`, at a fixed instant so the id is the tiebreaker. */
    function turn(parentId: string, sha: string, at: Date): NewCheckpoint {
      return {
        createdAt: at,
        files: [],
        gitSha: sha,
        kind: 'turn',
        label: 'Turn',
        orgId,
        parentId,
        projectId,
        runId: randomUUID(),
        turn: 1,
      };
    }

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await moduleRef.init();

      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      repository = moduleRef.get(CheckpointRepository, { strict: false });
      transactions = moduleRef.get(TenantTransactionRunner);

      const [user] = await database
        .insert(schema.users)
        .values({ email: `016r-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });

      userId = user!.id;

      const org = await moduleRef.get(OrgService).create(userId, {
        name: 'Checkpoint repository fixture',
        slug: `016r-${randomUUID().slice(0, 8)}`,
      });

      orgId = org.id;

      const [workspace] = await inTenant((tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      );
      const project = await transactions.runInTenantScope({ orgId, userId }, () =>
        moduleRef.get(ProjectService).create({
          actorId: userId,
          name: 'History',
          orgId,
          ownerId: userId,
          workspaceId: workspace!.id,
        }),
      );

      projectId = project.id;
    }, 60_000);

    afterAll(async () => {
      await database.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
      await database.delete(schema.users).where(eq(schema.users.id, userId));
      await moduleRef?.close();
    });

    it('is idempotent by sha, orders the head by (created_at, id) and pages the list once', async () => {
      const t0 = new Date('2026-09-17T00:00:00.000Z');
      const t1 = new Date('2026-09-17T00:00:01.000Z');
      const baseline: NewCheckpoint = {
        createdAt: t0,
        files: [],
        gitSha: 'a'.repeat(40),
        kind: 'baseline',
        label: 'Baseline: workspace as found',
        orgId,
        projectId,
      };

      const first = await inTenant((tx) => repository.insertOrGetBySha(tx, baseline));
      const again = await inTenant((tx) => repository.insertOrGetBySha(tx, baseline));
      expect(again.id).toBe(first.id);

      // Four turns at the same instant: the id alone has to order them and carry the cursor.
      const shas = ['b', 'c', 'd', 'e'].map((c) => c.repeat(40));
      const rows = [];
      for (const sha of shas) {
        rows.push(await inTenant((tx) => repository.insertOrGetBySha(tx, turn(first.id, sha, t1))));
      }
      const newestFirst = [...rows].sort((a, b) => (a.id < b.id ? 1 : -1)).map((row) => row.id);

      expect((await inTenant((tx) => repository.head(tx, orgId, projectId)))?.id).toBe(
        newestFirst[0],
      );

      const page1 = await inTenant((tx) => repository.list(tx, orgId, projectId, { limit: 2 }));
      expect(page1.items.map((row) => row.id)).toEqual(newestFirst.slice(0, 2));
      expect(page1.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);

      const page2 = await inTenant((tx) =>
        repository.list(tx, orgId, projectId, { cursor: page1.nextCursor!, limit: 2 }),
      );
      expect(page2.items.map((row) => row.id)).toEqual(newestFirst.slice(2, 4));

      const page3 = await inTenant((tx) =>
        repository.list(tx, orgId, projectId, { cursor: page2.nextCursor!, limit: 2 }),
      );
      expect(page3).toEqual({
        items: [expect.objectContaining({ id: first.id })],
        nextCursor: null,
      });

      await expect(
        inTenant((tx) => repository.list(tx, orgId, projectId, { cursor: 'bm9wZQ', limit: 2 })),
      ).rejects.toThrow(DomainError);
    });

    it('holds the project writer lock for the transaction: a rival cannot take it until commit', async () => {
      const rival = () =>
        database
          .execute(sql`select pg_try_advisory_xact_lock(hashtext(${projectId})) as locked`)
          .then((result) => (result.rows[0] as { locked: boolean }).locked);

      await inTenant(async (tx) => {
        await repository.lockProject(tx, projectId);
        expect(await rival()).toBe(false);
      });

      expect(await rival()).toBe(true);
    });

    it('marks mirrored once and sees a later mirrored row; no run is active; the template is read', async () => {
      const head = (await inTenant((tx) => repository.head(tx, orgId, projectId)))!;
      const older = (await inTenant((tx) => repository.byId(tx, orgId, head.parentId!)))!;
      const at = new Date('2026-09-17T00:00:02.000Z');

      expect(await inTenant((tx) => repository.laterMirroredExists(tx, older))).toBe(false);
      await inTenant((tx) => repository.markMirrored(tx, orgId, head.id, at));
      await inTenant((tx) =>
        repository.markMirrored(tx, orgId, head.id, new Date(at.getTime() + 1)),
      );
      expect((await inTenant((tx) => repository.byId(tx, orgId, head.id)))?.mirroredAt).toEqual(at);
      expect(await inTenant((tx) => repository.laterMirroredExists(tx, older))).toBe(true);
      expect(await inTenant((tx) => repository.laterMirroredExists(tx, head))).toBe(false);

      expect(await inTenant((tx) => repository.activeRunExists(tx, orgId, projectId))).toBe(false);
      const template = await inTenant((tx) => repository.projectTemplate(tx, orgId, projectId));
      expect(template?.snapshot).toBeNull();
      expect(typeof template?.template).toBe('string');
      expect(
        await inTenant((tx) => repository.projectTemplate(tx, orgId, randomUUID())),
      ).toBeNull();
    });
  });
});
