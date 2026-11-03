import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../../../app.module';
import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { PermissionCache } from '../../rbac/permission-cache';
import { PermissionResolutionService } from '../../rbac/permission-resolution.service';
import { scoped } from '../../rbac/permissions';
import { MembershipService } from './membership.service';
import { OrgService } from './org.service';
import { ProjectService } from './project.service';
import { WorkspaceService } from './workspace.service';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

describe('WorkspaceService', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and both Redis roles', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let orgs: OrgService;
    let memberships: MembershipService;
    let workspaces: WorkspaceService;
    let permissions: PermissionResolutionService;
    let projects: ProjectService;
    let cache: PermissionCache;
    let transactions: TenantTransactionRunner;
    const orgIds: string[] = [];
    const userIds: string[] = [];

    async function seedUser(): Promise<string> {
      const [user] = await database
        .insert(schema.users)
        .values({ email: `t27w-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });

      userIds.push(user!.id);

      return user!.id;
    }

    async function asRequest<T>(orgId: string, userId: string, fn: () => Promise<T>): Promise<T> {
      return transactions.runInTenantScope({ orgId, userId }, () => fn());
    }

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await moduleRef.init();

      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      orgs = moduleRef.get(OrgService);
      memberships = moduleRef.get(MembershipService);
      workspaces = moduleRef.get(WorkspaceService);
      permissions = moduleRef.get(PermissionResolutionService);
      projects = moduleRef.get(ProjectService);
      cache = moduleRef.get(PermissionCache);
      transactions = moduleRef.get(TenantTransactionRunner);
    }, 60_000);

    afterAll(async () => {
      if (orgIds.length > 0) {
        await database.delete(schema.orgs).where(inArray(schema.orgs.id, orgIds));
      }

      if (userIds.length > 0) {
        await database.delete(schema.users).where(inArray(schema.users.id, userIds));
      }

      await moduleRef?.close();
    });

    /** An organisation with two workspaces: the default one, and a second the owner also holds. */
    async function fixture() {
      const ownerId = await seedUser();
      const org = await orgs.create(ownerId, {
        name: 'Two workspaces',
        slug: `t27w-${randomUUID().slice(0, 8)}`,
      });

      orgIds.push(org.id);

      const [first] = await transactions.runInTenantTransaction(org.id, (tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      );

      const second = await asRequest(org.id, ownerId, () =>
        workspaces.create({
          actorId: ownerId,
          name: 'Second',
          orgId: org.id,
          ownerId,
        }),
      );

      return { first: first!.id, orgId: org.id, ownerId, second: second.id };
    }

    /**
     * **Criterion 11's wrong-role case, at the service layer.**
     *
     * The member belongs to the organisation and holds a role in one workspace. The other workspace
     * of the *same* organisation is not theirs, and asking for it by id is answered as though it did
     * not exist — not with a refusal that would confirm it does.
     */
    it('does not let a member read a workspace they hold no role in', async () => {
      const { first, orgId, ownerId, second } = await fixture();
      const memberId = await seedUser();

      await asRequest(orgId, ownerId, () =>
        memberships.add({ orgId, role: 'member', userId: memberId }),
      );
      await transactions.runInTenantTransaction(orgId, (tx) =>
        tx
          .insert(schema.workspaceMembers)
          .values({ orgId, role: 'viewer', userId: memberId, workspaceId: first }),
      );

      await expect(
        asRequest(orgId, memberId, () => workspaces.read(orgId, first, memberId)),
      ).resolves.toMatchObject({ id: first, role: 'viewer' });

      await expect(
        asRequest(orgId, memberId, () => workspaces.read(orgId, second, memberId)),
      ).rejects.toMatchObject({ type: 'not-found' });
    });

    /**
     * And the same thing at the guard's layer, which is the one that actually refuses the request:
     * the resolved set holds `workspace:read` for the workspace they have a role in and for no
     * other, so `@RequirePermission('workspace:read')` never reaches the service for the second.
     */
    it('resolves workspace:read for the granted workspace only', async () => {
      const { first, orgId, ownerId, second } = await fixture();
      const memberId = await seedUser();

      await asRequest(orgId, ownerId, () =>
        memberships.add({ orgId, role: 'member', userId: memberId }),
      );
      await transactions.runInTenantTransaction(orgId, (tx) =>
        tx
          .insert(schema.workspaceMembers)
          .values({ orgId, role: 'viewer', userId: memberId, workspaceId: first }),
      );

      const held = await permissions.for(orgId, memberId);

      expect(held).toContain(scoped('workspace:read', first));
      expect(held).not.toContain(scoped('workspace:read', second));
    });

    /**
     * The listing excludes rather than refusing. A viewer of one workspace learns nothing about how
     * many others exist — the same leak T30 avoids for projects, and the same answer.
     */
    it('lists only the workspaces the caller holds a role in', async () => {
      const { first, orgId, ownerId } = await fixture();
      const memberId = await seedUser();

      await asRequest(orgId, ownerId, () =>
        memberships.add({ orgId, role: 'member', userId: memberId }),
      );
      await transactions.runInTenantTransaction(orgId, (tx) =>
        tx
          .insert(schema.workspaceMembers)
          .values({ orgId, role: 'editor', userId: memberId, workspaceId: first }),
      );

      const mine = await asRequest(orgId, memberId, () => workspaces.list(orgId, memberId));
      const theirs = await asRequest(orgId, ownerId, () => workspaces.list(orgId, ownerId));

      expect(mine.map((workspace) => workspace.id)).toEqual([first]);
      expect(theirs).toHaveLength(2);
    });

    /** An org owner with no workspace role sees an empty list, not every workspace. */
    it('gives an owner no workspace they were not given a role in', async () => {
      const { orgId, ownerId } = await fixture();
      const secondOwnerId = await seedUser();

      await asRequest(orgId, ownerId, () =>
        memberships.add({ orgId, role: 'owner', userId: secondOwnerId }),
      );

      await expect(
        asRequest(orgId, secondOwnerId, () => workspaces.list(orgId, secondOwnerId)),
      ).resolves.toEqual([]);
    });

    describe('create', () => {
      it('grants the named user a role and invalidates their cached set', async () => {
        const { orgId, ownerId } = await fixture();
        const memberId = await seedUser();

        await asRequest(orgId, ownerId, () =>
          memberships.add({ orgId, role: 'member', userId: memberId }),
        );

        // Warm the cache with a set that has no workspace entries at all.
        await expect(permissions.for(orgId, memberId)).resolves.not.toContain('workspace:read');

        const created = await asRequest(orgId, ownerId, () =>
          workspaces.create({ actorId: ownerId, name: 'Theirs', orgId, ownerId: memberId }),
        );

        await expect(permissions.for(orgId, memberId)).resolves.toContain(
          scoped('workspace:read', created.id),
        );
      });
    });
    describe('rename and archive', () => {
      async function auditFor(orgId: string, target: string) {
        return transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .select({ action: schema.auditLog.action, metadata: schema.auditLog.metadata })
            .from(schema.auditLog)
            .where(eq(schema.auditLog.target, target)),
        );
      }

      async function workspaceRow(orgId: string, workspaceId: string) {
        const [row] = await transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .select({ deletedAt: schema.workspaces.deletedAt, name: schema.workspaces.name })
            .from(schema.workspaces)
            .where(eq(schema.workspaces.id, workspaceId)),
        );

        return row!;
      }

      async function project(orgId: string, ownerId: string, workspaceId: string, name: string) {
        return (
          await asRequest(orgId, ownerId, () =>
            projects.create({ actorId: ownerId, name, orgId, ownerId, workspaceId }),
          )
        ).id;
      }

      it('renames and records workspace.updated with from and to', async () => {
        const { orgId, ownerId, second } = await fixture();

        await asRequest(orgId, ownerId, () =>
          workspaces.rename({ actorId: ownerId, name: 'Segundo', orgId, workspaceId: second }),
        );

        expect((await workspaceRow(orgId, second)).name).toBe('Segundo');
        expect(await auditFor(orgId, second)).toContainEqual({
          action: 'workspace.updated',
          metadata: { from: 'Second', to: 'Segundo' },
        });
      });

      /** R10: same name, no row written. */
      it('writes nothing when the name does not change', async () => {
        const { orgId, ownerId, second } = await fixture();
        const before = await auditFor(orgId, second);

        await asRequest(orgId, ownerId, () =>
          workspaces.rename({ actorId: ownerId, name: 'Second', orgId, workspaceId: second }),
        );

        expect(await auditFor(orgId, second)).toEqual(before);
      });

      it('archives: live projects first, one event and one audit row each, then the workspace', async () => {
        const { orgId, ownerId, second } = await fixture();
        const live = [
          await project(orgId, ownerId, second, 'A'),
          await project(orgId, ownerId, second, 'B'),
        ];
        const gone = await project(orgId, ownerId, second, 'C');
        const guestId = await seedUser();

        await transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .insert(schema.projectGrants)
            .values({ orgId, projectId: live[0]!, role: 'viewer', userId: guestId }),
        );
        await asRequest(orgId, ownerId, () =>
          projects.archive({ actorId: ownerId, orgId, projectId: gone, workspaceId: second }),
        );

        const invalidate = vi.spyOn(cache, 'invalidate');
        const invalidateOrg = vi.spyOn(cache, 'invalidateOrg');

        const returned = await asRequest(orgId, ownerId, () =>
          workspaces.archive({ actorId: ownerId, orgId, workspaceId: second }),
        );

        expect([...returned].sort()).toEqual([...live].sort());

        expect((await workspaceRow(orgId, second)).deletedAt).toBeInstanceOf(Date);

        const events = await transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .select({ aggregateId: schema.outbox.aggregateId })
            .from(schema.outbox)
            .where(eq(schema.outbox.type, 'project.archived')),
        );

        expect(events.filter((row) => live.includes(row.aggregateId))).toHaveLength(2);
        expect(events.filter((row) => row.aggregateId === gone)).toHaveLength(1);

        for (const id of live) {
          expect(await auditFor(orgId, id)).toContainEqual({
            action: 'project.deleted',
            metadata: { workspaceId: second },
          });
        }

        expect(await auditFor(orgId, second)).toContainEqual({
          action: 'workspace.deleted',
          metadata: { projectIds: returned },
        });
        expect(invalidateOrg).not.toHaveBeenCalled();
        expect(invalidate.mock.calls).toEqual(
          expect.arrayContaining([
            [orgId, ownerId],
            [orgId, guestId],
          ]),
        );
        invalidate.mockRestore();
        invalidateOrg.mockRestore();
      });

      it('invalidates the whole organisation when more than fifty people are affected', async () => {
        const { orgId, ownerId, second } = await fixture();
        const members = await Promise.all(Array.from({ length: 51 }, seedUser));

        await transactions.runInTenantTransaction(orgId, (tx) =>
          tx.insert(schema.workspaceMembers).values(
            members.map((userId) => ({
              orgId,
              role: 'viewer' as const,
              userId,
              workspaceId: second,
            })),
          ),
        );

        const invalidate = vi.spyOn(cache, 'invalidate');
        const invalidateOrg = vi.spyOn(cache, 'invalidateOrg');

        await asRequest(orgId, ownerId, () =>
          workspaces.archive({ actorId: ownerId, orgId, workspaceId: second }),
        );

        expect(invalidateOrg).toHaveBeenCalledWith(orgId);
        expect(invalidate).not.toHaveBeenCalled();
        invalidate.mockRestore();
        invalidateOrg.mockRestore();
      });

      it.each([
        [
          'rename',
          (entry: { actorId: string; orgId: string; workspaceId: string }): Promise<unknown> =>
            workspaces.rename({ ...entry, name: 'X' }),
        ],
        [
          'archive',
          (entry: { actorId: string; orgId: string; workspaceId: string }) =>
            workspaces.archive(entry),
        ],
      ])('%s answers not-found for an archived workspace', async (_label, act) => {
        const { orgId, ownerId, second } = await fixture();

        await asRequest(orgId, ownerId, () =>
          workspaces.archive({ actorId: ownerId, orgId, workspaceId: second }),
        );

        await expect(
          asRequest(orgId, ownerId, () => act({ actorId: ownerId, orgId, workspaceId: second })),
        ).rejects.toMatchObject({ type: 'not-found' });
      });
    });
  });
});
