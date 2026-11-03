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
import { PermissionResolutionService } from '../../rbac/permission-resolution.service';
import { ORG_ROLE_PERMISSIONS, WORKSPACE_ROLE_PERMISSIONS, scoped } from '../../rbac/permissions';
import { OrgService } from './org.service';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

describe('OrgService', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and both Redis roles', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let orgs: OrgService;
    let permissions: PermissionResolutionService;
    let transactions: TenantTransactionRunner;
    const orgIds: string[] = [];
    const userIds: string[] = [];

    async function seedUser(): Promise<string> {
      const [user] = await database
        .insert(schema.users)
        .values({ email: `t27o-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });

      userIds.push(user!.id);

      return user!.id;
    }

    async function create(actorId: string, slug = `t27o-${randomUUID().slice(0, 8)}`) {
      const org = await orgs.create(actorId, { name: 'Acme', slug });

      orgIds.push(org.id);

      return org;
    }

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await moduleRef.init();

      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      orgs = moduleRef.get(OrgService);
      permissions = moduleRef.get(PermissionResolutionService);
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

    describe('create', () => {
      it('returns the organisation it made', async () => {
        const org = await create(await seedUser());

        expect(org).toMatchObject({ name: 'Acme', plan: 'free' });
        expect(org.id).toMatch(/^[0-9a-f-]{36}$/);
      });

      /**
       * T13's original shape, minus the user: organisation, owner membership, default workspace and
       * an audit entry, all in one transaction. Asserted together rather than one at a time, because
       * "in one transaction" is a claim about the set of them.
       */
      it('creates the owner membership, a workspace and an audit trail with it', async () => {
        const ownerId = await seedUser();
        const org = await create(ownerId);

        const state = await transactions.runInTenantTransaction(org.id, async (tx) => ({
          audit: await tx
            .select({ action: schema.auditLog.action })
            .from(schema.auditLog)
            .where(eq(schema.auditLog.orgId, org.id)),
          members: await tx
            .select({ role: schema.memberships.role, userId: schema.memberships.userId })
            .from(schema.memberships),
          workspaceRoles: await tx
            .select({ role: schema.workspaceMembers.role })
            .from(schema.workspaceMembers),
          workspaces: await tx.select({ name: schema.workspaces.name }).from(schema.workspaces),
        }));

        expect(state.members).toEqual([{ role: 'owner', userId: ownerId }]);
        expect(state.workspaces).toEqual([{ name: 'General' }]);
        expect(state.workspaceRoles).toEqual([{ role: 'admin' }]);
        expect(state.audit.map((row) => row.action).sort()).toEqual([
          'membership.created',
          'org.created',
          'workspace.created',
        ]);
      });

      /**
       * §11's scopes compose and none of them cascades (T24). An org owner who was not *also* given
       * a workspace role would own an organisation whose only workspace they could not open, which
       * is why `create` grants both rather than relying on a cascade the document never describes.
       */
      it('gives the creator both the org role and a role in the workspace it made', async () => {
        const ownerId = await seedUser();
        const org = await create(ownerId);

        const [workspace] = await transactions.runInTenantTransaction(org.id, (tx) =>
          tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
        );

        const held = await permissions.for(org.id, ownerId);

        for (const permission of ORG_ROLE_PERMISSIONS.owner) {
          expect(held).toContain(permission);
        }

        for (const permission of WORKSPACE_ROLE_PERMISSIONS.admin) {
          expect(held).toContain(scoped(permission, workspace!.id));
        }
      });

      /**
       * The slug is globally unique, which is what makes it usable in a URL and what makes this
       * collision reachable by anybody. A `409` rather than a `422`: the body was well formed, and
       * the only thing wrong with it is a fact about the world at the moment it arrived.
       */
      it('refuses a slug that is taken, with a conflict rather than a validation failure', async () => {
        const slug = `t27o-${randomUUID().slice(0, 8)}`;

        await create(await seedUser(), slug);

        await expect(create(await seedUser(), slug)).rejects.toMatchObject({
          type: 'conflict',
        });
      });

      /** Nothing is left behind by the refusal — not the org row, and not a half-built tenant. */
      it('leaves no organisation behind when the slug collides', async () => {
        const slug = `t27o-${randomUUID().slice(0, 8)}`;

        await create(await seedUser(), slug);
        await expect(create(await seedUser(), slug)).rejects.toThrow();

        const rows = await database
          .select({ id: schema.orgs.id })
          .from(schema.orgs)
          .where(eq(schema.orgs.slug, slug));

        expect(rows).toHaveLength(1);
      });
    });

    describe('read', () => {
      it('answers with the organisation the transaction is scoped to', async () => {
        const ownerId = await seedUser();
        const org = await create(ownerId);

        const read = await transactions.runInTenantScope({ orgId: org.id, userId: ownerId }, () =>
          orgs.read(),
        );

        expect(read).toEqual(org);
      });

      /**
       * The restore window (ADR 012) is for an administrator, not a place the tenant carries on
       * working in — and `resolve()` already gives every member of a soft-deleted organisation an
       * empty permission set, so this is the same answer arriving twice.
       */
      it('treats a soft-deleted organisation as absent', async () => {
        const ownerId = await seedUser();
        const org = await create(ownerId);

        await database
          .update(schema.orgs)
          .set({ deletedAt: new Date() })
          .where(eq(schema.orgs.id, org.id));

        await expect(
          transactions.runInTenantScope({ orgId: org.id, userId: ownerId }, () => orgs.read()),
        ).rejects.toMatchObject({ type: 'not-found' });
      });
    });

    /** Spec 032 T015: the policy read — the column, inside the caller's tenant transaction. */
    describe('personalAccountsAllowed', () => {
      it('is true by default, and follows the column when an owner turns it off', async () => {
        const org = await create(await seedUser());

        await expect(
          transactions.runInTenantTransaction(org.id, (tx) =>
            orgs.personalAccountsAllowed(tx, org.id),
          ),
        ).resolves.toBe(true);

        await database
          .update(schema.orgs)
          .set({ personalAccountsAllowed: false })
          .where(eq(schema.orgs.id, org.id));

        await expect(
          transactions.runInTenantTransaction(org.id, (tx) =>
            orgs.personalAccountsAllowed(tx, org.id),
          ),
        ).resolves.toBe(false);
      });

      it('refuses an organisation that does not exist', async () => {
        const org = await create(await seedUser());

        await expect(
          transactions.runInTenantTransaction(org.id, (tx) =>
            orgs.personalAccountsAllowed(tx, randomUUID()),
          ),
        ).rejects.toThrow(/No such organisation/);
      });
    });

    /** Spec 032 T051: the policy write, audited only when the value changes. */
    describe('setPersonalAccountsAllowed', () => {
      async function changes(orgId: string) {
        return transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .select({ metadata: schema.auditLog.metadata })
            .from(schema.auditLog)
            .where(
              and(
                eq(schema.auditLog.orgId, orgId),
                eq(schema.auditLog.action, 'org.personal-accounts-changed'),
              ),
            ),
        );
      }

      it('writes the column and audits { from, to } in the same transaction', async () => {
        const ownerId = await seedUser();
        const org = await create(ownerId);

        await expect(
          transactions.runInTenantTransaction(org.id, (tx) =>
            orgs.setPersonalAccountsAllowed(tx, org.id, ownerId, false),
          ),
        ).resolves.toBe(false);

        await expect(
          transactions.runInTenantTransaction(org.id, (tx) =>
            orgs.personalAccountsAllowed(tx, org.id),
          ),
        ).resolves.toBe(false);
        expect(await changes(org.id)).toEqual([{ metadata: { from: true, to: false } }]);
      });

      it('audits nothing when the value does not change', async () => {
        const ownerId = await seedUser();
        const org = await create(ownerId);

        await transactions.runInTenantTransaction(org.id, (tx) =>
          orgs.setPersonalAccountsAllowed(tx, org.id, ownerId, true),
        );

        expect(await changes(org.id)).toEqual([]);
      });
    });

    /**
     * `GET /api/v1/orgs` — the one read in the application rooted at a person rather than at an
     * organisation, and therefore the one with no `:orgId` to derive a tenant from. It runs in the
     * user-scoped transaction ADR 023 introduces, so the assertions that matter most here are the
     * negative ones: what a caller in one organisation cannot see of another's.
     */
    describe('listForUser', () => {
      it('answers with the organisations the caller belongs to, and the role in each', async () => {
        const ownerId = await seedUser();
        const first = await create(ownerId);
        const second = await create(ownerId);

        const listed = await orgs.listForUser(ownerId);

        expect(listed).toEqual([
          { ...first, access: 'member', role: 'owner' },
          { ...second, access: 'member', role: 'owner' },
        ]);
      });

      /** An account in none. Empty, and not an error — it is the create-an-organisation screen. */
      it('answers with an empty list for somebody in no organisation', async () => {
        await expect(orgs.listForUser(await seedUser())).resolves.toEqual([]);
      });

      /**
       * The isolation property, at the service. Two owners, two organisations, and neither list
       * mentions the other's — through a query that spans tenants by construction, so this is the
       * `memberships` policy's new `user_id` clause being narrow rather than a `WHERE` being
       * remembered.
       */
      it('never mentions an organisation the caller is not a member of', async () => {
        const mine = await seedUser();
        const theirs = await seedUser();
        const ours = await create(mine);
        const yours = await create(theirs);

        expect((await orgs.listForUser(mine)).map((org) => org.id)).toEqual([ours.id]);
        expect((await orgs.listForUser(theirs)).map((org) => org.id)).toEqual([yours.id]);
      });

      /**
       * A pending member holds no permissions at all — T24 resolves them exactly as it resolves a
       * guest — so an organisation they were invited to but have not joined would be one whose
       * every route refuses them. The invitation is the thing to act on, and it arrives by mail.
       */
      it('excludes an invitation that has not been accepted', async () => {
        const ownerId = await seedUser();
        const invitedId = await seedUser();
        const org = await create(ownerId);

        await transactions.runInTenantTransaction(org.id, (tx) =>
          tx
            .insert(schema.memberships)
            .values({ acceptedAt: null, orgId: org.id, role: 'member', userId: invitedId }),
        );

        await expect(orgs.listForUser(invitedId)).resolves.toEqual([]);

        // And accepting it is what puts the organisation in the list, so the exclusion above is
        // about `accepted_at` rather than about the row being unreadable.
        await transactions.runInTenantTransaction(org.id, (tx) =>
          tx
            .update(schema.memberships)
            .set({ acceptedAt: new Date() })
            .where(eq(schema.memberships.userId, invitedId)),
        );

        expect((await orgs.listForUser(invitedId)).map((entry) => entry.role)).toEqual(['member']);
      });

      /** The same call `read` makes: the restore window is not a place a tenant carries on in. */
      it('excludes a soft-deleted organisation', async () => {
        const ownerId = await seedUser();
        const kept = await create(ownerId);
        const removed = await create(ownerId);

        await database
          .update(schema.orgs)
          .set({ deletedAt: new Date() })
          .where(eq(schema.orgs.id, removed.id));

        expect((await orgs.listForUser(ownerId)).map((org) => org.id)).toEqual([kept.id]);
      });

      /** A project in the org's first workspace, and a grant on it for `userId` (spec 031 US2). */
      async function share(orgId: string, userId: string): Promise<string> {
        return transactions.runInTenantTransaction(orgId, async (tx) => {
          const [workspace] = await tx
            .select({ id: schema.workspaces.id })
            .from(schema.workspaces)
            .limit(1);
          const [project] = await tx
            .insert(schema.projects)
            .values({
              name: 'Shared',
              orgId,
              previewLabel: `t031o-${randomUUID().slice(0, 12)}`,
              workspaceId: workspace!.id,
            })
            .returning({ id: schema.projects.id });

          await tx
            .insert(schema.projectGrants)
            .values({ orgId, projectId: project!.id, role: 'viewer', userId });

          return project!.id;
        });
      }

      it('lists an org where the user holds only grants as access guest with a null role', async () => {
        const ownerId = await seedUser();
        const guestId = await seedUser();
        const org = await create(ownerId);

        await share(org.id, guestId);

        const listed = await orgs.listForUser(guestId);

        expect(listed).toEqual([
          expect.objectContaining({ access: 'guest', id: org.id, role: null }),
        ]);
      });

      it('does not list an org whose only grant is on an archived project', async () => {
        const ownerId = await seedUser();
        const guestId = await seedUser();
        const org = await create(ownerId);
        const projectId = await share(org.id, guestId);

        await transactions.runInTenantTransaction(org.id, (tx) =>
          tx
            .update(schema.projects)
            .set({ deletedAt: new Date() })
            .where(eq(schema.projects.id, projectId)),
        );

        await expect(orgs.listForUser(guestId)).resolves.toEqual([]);
      });

      it('still lists memberships as access member with their role', async () => {
        const ownerId = await seedUser();
        const org = await create(ownerId);

        // A member who also holds a grant is a member, listed once.
        await share(org.id, ownerId);

        expect(await orgs.listForUser(ownerId)).toEqual([
          expect.objectContaining({ access: 'member', id: org.id, role: 'owner' }),
        ]);
      });
    });
  });
});
