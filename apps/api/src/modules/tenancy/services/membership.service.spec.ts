import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { AppModule } from '../../../app.module';
import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { SessionService } from '../../identity/services/session.service';
import { PermissionCache } from '../../rbac/permission-cache';
import { PermissionResolutionService } from '../../rbac/permission-resolution.service';
import { ORG_ROLE_PERMISSIONS } from '../../rbac/permissions';
import { MembershipService } from './membership.service';
import { OrgService } from './org.service';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

/**
 * The org-scoped entries of a resolved set, sorted.
 *
 * Workspace and project entries carry their resource (`workspace:read@{id}`, T24's `scoped()`), so
 * a caller who also holds a workspace role has them in the same flat set. Comparing the whole set
 * against `ORG_ROLE_PERMISSIONS` would therefore fail for anybody who has ever been given one —
 * which, thanks to the default workspace, is every organisation's creator.
 */
function orgScoped(held: ReadonlySet<string>): string[] {
  return [...held].filter((entry) => entry.startsWith('org:')).sort();
}

describe('MembershipService', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and both Redis roles', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let memberships: MembershipService;
    let orgs: OrgService;
    let permissions: PermissionResolutionService;
    let cache: PermissionCache;
    let sessions: SessionService;
    let transactions: TenantTransactionRunner;
    const userIds: string[] = [];
    const orgIds: string[] = [];

    async function seedUser(): Promise<string> {
      const [user] = await database
        .insert(schema.users)
        .values({ email: `t27m-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });

      userIds.push(user!.id);

      return user!.id;
    }

    /** An organisation through the product's own path, so the fixture is not a second one. */
    async function seedOrg(ownerId: string): Promise<string> {
      const org = await orgs.create(ownerId, {
        name: 'Membership fixture',
        slug: `t27m-${randomUUID().slice(0, 8)}`,
      });

      orgIds.push(org.id);

      return org.id;
    }

    /** Run `fn` the way a request would: inside the tenant scope, hooks drained on the way out. */
    async function asRequest<T>(orgId: string, userId: string, fn: () => Promise<T>): Promise<T> {
      return transactions.runInTenantScope({ orgId, userId }, () => fn());
    }

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await moduleRef.init();

      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      memberships = moduleRef.get(MembershipService);
      orgs = moduleRef.get(OrgService);
      permissions = moduleRef.get(PermissionResolutionService);
      cache = moduleRef.get(PermissionCache);
      sessions = moduleRef.get(SessionService);
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

    describe('list', () => {
      it('shows the creator as the accepted owner', async () => {
        const ownerId = await seedUser();
        const orgId = await seedOrg(ownerId);

        const members = await asRequest(orgId, ownerId, () => memberships.list(orgId));

        expect(members).toHaveLength(1);
        expect(members[0]).toMatchObject({ role: 'owner', userId: ownerId });
        expect(members[0]!.acceptedAt).not.toBeNull();
      });
    });

    describe('add', () => {
      /**
       * The case that makes invalidation on *add* necessary rather than merely tidy: a set is cached
       * per `(org, user)`, and an empty one for a non-member is perfectly cacheable. Anybody who
       * touched a route in this organisation before being added has one, and leaving it would refuse
       * the new member everything until the backstop TTL expired.
       */
      it('invalidates a cached empty set, so the new member is not refused until the TTL', async () => {
        const ownerId = await seedUser();
        const orgId = await seedOrg(ownerId);
        const joinerId = await seedUser();

        await expect(permissions.for(orgId, joinerId)).resolves.toEqual(new Set());

        await asRequest(orgId, ownerId, () =>
          memberships.add({ orgId, role: 'member', userId: joinerId }),
        );

        await expect(permissions.for(orgId, joinerId)).resolves.toEqual(
          new Set(ORG_ROLE_PERMISSIONS.member),
        );
      });

      it('writes an audit row in the same transaction as the membership', async () => {
        const ownerId = await seedUser();
        const orgId = await seedOrg(ownerId);
        const joinerId = await seedUser();

        await asRequest(orgId, ownerId, () =>
          memberships.add({ orgId, role: 'admin', userId: joinerId }),
        );

        // Through a tenant transaction, because that is the only way `audit_log` is readable at
        // all: it carries `tenant_isolation` like every other tenant-owned table, so the same query
        // on the outer Drizzle instance returns zero rows rather than everything.
        const entries = await transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .select({ action: schema.auditLog.action, target: schema.auditLog.target })
            .from(schema.auditLog),
        );

        expect(entries).toContainEqual({ action: 'membership.created', target: joinerId });
      });
    });

    describe('changeRole', () => {
      it('makes the new role effective at once rather than at the TTL', async () => {
        const ownerId = await seedUser();
        const orgId = await seedOrg(ownerId);
        const memberId = await seedUser();

        await asRequest(orgId, ownerId, () =>
          memberships.add({ orgId, role: 'member', userId: memberId }),
        );
        await expect(permissions.for(orgId, memberId)).resolves.toEqual(
          new Set(ORG_ROLE_PERMISSIONS.member),
        );

        await asRequest(orgId, ownerId, () =>
          memberships.changeRole({ actorId: ownerId, orgId, role: 'admin', userId: memberId }),
        );

        await expect(permissions.for(orgId, memberId)).resolves.toEqual(
          new Set(ORG_ROLE_PERMISSIONS.admin),
        );
      });

      /**
       * A demotion is the direction that matters for security, and it is the one a TTL-only cache
       * gets wrong: the entry has to be *deleted*, not left to expire, or the demoted owner keeps
       * changing organisation settings for as long as the backstop lasts.
       */
      it('takes a demotion effect immediately, in the same way', async () => {
        const ownerId = await seedUser();
        const orgId = await seedOrg(ownerId);
        const adminId = await seedUser();

        await asRequest(orgId, ownerId, () =>
          memberships.add({ orgId, role: 'admin', userId: adminId }),
        );
        await expect(permissions.for(orgId, adminId)).resolves.toContain('org:settings.update');

        await asRequest(orgId, ownerId, () =>
          memberships.changeRole({ actorId: ownerId, orgId, role: 'member', userId: adminId }),
        );

        await expect(permissions.for(orgId, adminId)).resolves.not.toContain('org:settings.update');
      });

      /**
       * The service check §11 asks for, and the one `permissions.ts` names this class as the home
       * of: `ORG_ROLE_PERMISSIONS` gives `admin` the `org:members.role-change` permission, so
       * without this an admin could promote themselves to owner and the `billing`/`owner` split
       * would be decorative.
       */
      it('refuses an admin conferring a role above their own', async () => {
        const ownerId = await seedUser();
        const orgId = await seedOrg(ownerId);
        const adminId = await seedUser();

        await asRequest(orgId, ownerId, () =>
          memberships.add({ orgId, role: 'admin', userId: adminId }),
        );

        await expect(
          asRequest(orgId, adminId, () =>
            memberships.changeRole({ actorId: adminId, orgId, role: 'owner', userId: adminId }),
          ),
        ).rejects.toThrow(/above your own/i);
      });

      it('refuses an admin demoting the owner who appointed them', async () => {
        const ownerId = await seedUser();
        const orgId = await seedOrg(ownerId);
        const adminId = await seedUser();

        await asRequest(orgId, ownerId, () =>
          memberships.add({ orgId, role: 'admin', userId: adminId }),
        );

        await expect(
          asRequest(orgId, adminId, () =>
            memberships.changeRole({ actorId: adminId, orgId, role: 'member', userId: ownerId }),
          ),
        ).rejects.toThrow(/above your own/i);
      });

      /** An organisation with no owner is one nobody can administer, bill or delete. */
      it('refuses to demote the last owner', async () => {
        const ownerId = await seedUser();
        const orgId = await seedOrg(ownerId);

        await expect(
          asRequest(orgId, ownerId, () =>
            memberships.changeRole({ actorId: ownerId, orgId, role: 'member', userId: ownerId }),
          ),
        ).rejects.toThrow(/last owner/i);
      });

      it('allows an owner to step down once another owner exists', async () => {
        const ownerId = await seedUser();
        const orgId = await seedOrg(ownerId);
        const successorId = await seedUser();

        await asRequest(orgId, ownerId, () =>
          memberships.add({ orgId, role: 'owner', userId: successorId }),
        );

        await asRequest(orgId, ownerId, () =>
          memberships.changeRole({ actorId: ownerId, orgId, role: 'member', userId: ownerId }),
        );

        // The org-scoped half only. The stepped-down owner still holds `admin` in the workspace
        // `OrgService.create` gave them, and should — §11's scopes compose and none cascades, so
        // losing the org role does not silently withdraw a workspace one.
        expect(orgScoped(await permissions.for(orgId, ownerId))).toEqual(
          [...ORG_ROLE_PERMISSIONS.member].sort(),
        );
      });
    });

    describe('remove', () => {
      /**
       * **Both halves, on one removal.** The task's framing is what these two assertions are: "either
       * one alone leaves a removed collaborator with working access — cache-only leaves the session
       * valid, session-only leaves a stale permission set for their next login."
       */
      it('invalidates the permission cache and revokes every session the member held', async () => {
        const ownerId = await seedUser();
        const orgId = await seedOrg(ownerId);
        const memberId = await seedUser();

        await asRequest(orgId, ownerId, () =>
          memberships.add({ orgId, role: 'member', userId: memberId }),
        );

        // Two devices, and a warm cache entry — the state a real collaborator is in.
        const laptop = await sessions.create(memberId);
        const phone = await sessions.create(memberId);

        await expect(permissions.for(orgId, memberId)).resolves.toEqual(
          new Set(ORG_ROLE_PERMISSIONS.member),
        );
        await expect(cache.read(orgId, memberId)).resolves.not.toBeNull();

        await asRequest(orgId, ownerId, () =>
          memberships.remove({ actorId: ownerId, orgId, userId: memberId }),
        );

        // Cache: the entry is gone, not merely due to expire.
        await expect(cache.read(orgId, memberId)).resolves.toBeNull();
        await expect(permissions.for(orgId, memberId)).resolves.toEqual(new Set());

        // Sessions: wholesale, both devices, including the one nobody was holding a token for.
        await expect(sessions.authenticate(laptop.token)).resolves.toBeNull();
        await expect(sessions.authenticate(phone.token)).resolves.toBeNull();
      });

      /**
       * The ordering. A hook that ran before the commit would leave a window in which a concurrent
       * read repopulates the entry from rows that are about to change — so the invalidation is
       * asserted to have happened *and* the row is asserted to be gone, from a transaction that
       * started afterwards.
       */
      it('leaves no membership row behind, so a rebuilt set is empty rather than stale', async () => {
        const ownerId = await seedUser();
        const orgId = await seedOrg(ownerId);
        const memberId = await seedUser();

        await asRequest(orgId, ownerId, () =>
          memberships.add({ orgId, role: 'admin', userId: memberId }),
        );
        await asRequest(orgId, ownerId, () =>
          memberships.remove({ actorId: ownerId, orgId, userId: memberId }),
        );

        const rows = await transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .select({ id: schema.memberships.id })
            .from(schema.memberships)
            .where(
              and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, memberId)),
            ),
        );

        expect(rows).toEqual([]);
      });

      /**
       * A guest relationship survives the end of a membership, because it is a separate and
       * separately-audited decision. Somebody who stops being a member but keeps an explicit grant
       * on one project becomes precisely what §11 calls a guest.
       */
      it('leaves the removed member’s project grants alone', async () => {
        const ownerId = await seedUser();
        const orgId = await seedOrg(ownerId);
        const memberId = await seedUser();

        await asRequest(orgId, ownerId, () =>
          memberships.add({ orgId, role: 'member', userId: memberId }),
        );

        const projectId = await transactions.runInTenantTransaction(orgId, async (tx) => {
          const [workspace] = await tx.select({ id: schema.workspaces.id }).from(schema.workspaces);

          const [project] = await tx
            .insert(schema.projects)
            .values({
              name: 'kept',
              orgId,
              previewLabel: `t27m-${randomUUID().slice(0, 8)}`,
              workspaceId: workspace!.id,
            })
            .returning({ id: schema.projects.id });

          await tx
            .insert(schema.projectGrants)
            .values({ orgId, projectId: project!.id, role: 'viewer', userId: memberId });

          return project!.id;
        });

        await asRequest(orgId, ownerId, () =>
          memberships.remove({ actorId: ownerId, orgId, userId: memberId }),
        );

        // No org permissions, and exactly the project the grant names. A guest.
        const held = await permissions.for(orgId, memberId);

        expect([...held]).toEqual(expect.arrayContaining([`project:read@${projectId}`]));
        expect([...held].some((entry) => entry.startsWith('org:'))).toBe(false);
      });

      it('refuses an admin removing an owner', async () => {
        const ownerId = await seedUser();
        const orgId = await seedOrg(ownerId);
        const adminId = await seedUser();

        await asRequest(orgId, ownerId, () =>
          memberships.add({ orgId, role: 'admin', userId: adminId }),
        );

        await expect(
          asRequest(orgId, adminId, () =>
            memberships.remove({ actorId: adminId, orgId, userId: ownerId }),
          ),
        ).rejects.toThrow(/above your own/i);
      });

      it('refuses to remove the last owner', async () => {
        const ownerId = await seedUser();
        const orgId = await seedOrg(ownerId);

        await expect(
          asRequest(orgId, ownerId, () =>
            memberships.remove({ actorId: ownerId, orgId, userId: ownerId }),
          ),
        ).rejects.toThrow(/last owner/i);
      });

      it('refuses to remove somebody who is not a member', async () => {
        const ownerId = await seedUser();
        const orgId = await seedOrg(ownerId);
        const strangerId = await seedUser();

        await expect(
          asRequest(orgId, ownerId, () =>
            memberships.remove({ actorId: ownerId, orgId, userId: strangerId }),
          ),
        ).rejects.toThrow(/no such member/i);
      });
    });

    /**
     * Spec 028 research R14: who a custom-domain notice goes to. Called from a worker on the
     * checker's own transaction, never from a request, so these run on a bare tenant transaction
     * with no `TenantContext` published.
     */
    describe('noticeRecipients', () => {
      it('returns the accepted owners and the member who added the domain', async () => {
        const ownerId = await seedUser();
        const orgId = await seedOrg(ownerId);
        const coOwnerId = await seedUser();
        const adderId = await seedUser();

        await asRequest(orgId, ownerId, () =>
          memberships.add({ orgId, role: 'owner', userId: coOwnerId }),
        );
        await asRequest(orgId, ownerId, () =>
          memberships.add({ orgId, role: 'member', userId: adderId }),
        );

        const recipients = await transactions.runInTenantTransaction(orgId, (tx) =>
          memberships.noticeRecipients(tx, orgId, adderId),
        );

        expect([...recipients].sort()).toEqual([ownerId, coOwnerId, adderId].sort());
      });

      it('excludes an owner who has not accepted', async () => {
        const ownerId = await seedUser();
        const orgId = await seedOrg(ownerId);
        const pendingId = await seedUser();

        await transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .insert(schema.memberships)
            .values({ acceptedAt: null, orgId, role: 'owner', userId: pendingId }),
        );

        const recipients = await transactions.runInTenantTransaction(orgId, (tx) =>
          memberships.noticeRecipients(tx, orgId, pendingId),
        );

        expect(recipients).toEqual([ownerId]);
      });

      it('excludes an added_by who has since left the organisation', async () => {
        const ownerId = await seedUser();
        const orgId = await seedOrg(ownerId);
        const leaverId = await seedUser();

        await asRequest(orgId, ownerId, () =>
          memberships.add({ orgId, role: 'member', userId: leaverId }),
        );
        await asRequest(orgId, ownerId, () =>
          memberships.remove({ actorId: ownerId, orgId, userId: leaverId }),
        );

        const recipients = await transactions.runInTenantTransaction(orgId, (tx) =>
          memberships.noticeRecipients(tx, orgId, leaverId),
        );

        expect(recipients).toEqual([ownerId]);
      });

      it('lists an owner who also added the domain once', async () => {
        const ownerId = await seedUser();
        const orgId = await seedOrg(ownerId);

        const recipients = await transactions.runInTenantTransaction(orgId, (tx) =>
          memberships.noticeRecipients(tx, orgId, ownerId),
        );

        expect(recipients).toEqual([ownerId]);
      });

      /** `domains.added_by` is `on delete set null`: a deleted account leaves the owners alone. */
      it('returns the owners alone when nobody is named', async () => {
        const ownerId = await seedUser();
        const orgId = await seedOrg(ownerId);

        const recipients = await transactions.runInTenantTransaction(orgId, (tx) =>
          memberships.noticeRecipients(tx, orgId, null),
        );

        expect(recipients).toEqual([ownerId]);
      });
    });

    /** The address a notice is sent to, resolved at send time from the event's user id. */
    describe('noticeAddress', () => {
      it('answers an accepted member’s address', async () => {
        const ownerId = await seedUser();
        const orgId = await seedOrg(ownerId);

        const address = await transactions.runInTenantTransaction(orgId, (tx) =>
          memberships.noticeAddress(tx, orgId, ownerId),
        );

        expect(address).toMatch(/^t27m-.+@example\.test$/);
      });

      it('answers nothing for a user who is no longer, or not yet, a member', async () => {
        const ownerId = await seedUser();
        const orgId = await seedOrg(ownerId);
        const pendingId = await seedUser();
        const strangerId = await seedUser();

        await transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .insert(schema.memberships)
            .values({ acceptedAt: null, orgId, role: 'owner', userId: pendingId }),
        );

        await expect(
          transactions.runInTenantTransaction(orgId, (tx) =>
            memberships.noticeAddress(tx, orgId, pendingId),
          ),
        ).resolves.toBeUndefined();
        await expect(
          transactions.runInTenantTransaction(orgId, (tx) =>
            memberships.noticeAddress(tx, orgId, strangerId),
          ),
        ).resolves.toBeUndefined();
      });
    });
  });
});
