import { ConfigModule } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { RedisModule } from '../../common/redis/redis.module';
import { validateEnvironment } from '../../config/environment';
import { APP_DATABASE } from '../../database/database.constants';
import { DatabaseModule } from '../../database/database.module';
import type { ForgeDatabase } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { PermissionCache } from './permission-cache';
import { PermissionResolutionService } from './permission-resolution.service';
import {
  ORG_ROLE_PERMISSIONS,
  PROJECT_ROLE_PERMISSIONS,
  scoped,
  WORKSPACE_ROLE_PERMISSIONS,
} from './permissions';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

interface Tenant {
  readonly orgId: string;
  readonly projectId: string;
  readonly workspaceId: string;
}

describe('PermissionResolutionService', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and the cache Redis role', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let permissions: PermissionResolutionService;
    let cache: PermissionCache;
    let transactions: TenantTransactionRunner;
    const orgIds: string[] = [];
    const userIds: string[] = [];

    async function seedTenant(): Promise<Tenant> {
      const [org] = await database
        .insert(schema.orgs)
        .values({ name: 'tenant', slug: `t26r-${randomUUID()}` })
        .returning({ id: schema.orgs.id });

      const orgId = org!.id;

      orgIds.push(orgId);

      return transactions.runInTenantTransaction(orgId, async (tx) => {
        const [workspace] = await tx
          .insert(schema.workspaces)
          .values({ name: 'workspace', orgId })
          .returning({ id: schema.workspaces.id });

        const [project] = await tx
          .insert(schema.projects)
          .values({
            name: 'project',
            orgId,
            previewLabel: `t26r-${randomUUID()}`,
            workspaceId: workspace!.id,
          })
          .returning({ id: schema.projects.id });

        return { orgId, projectId: project!.id, workspaceId: workspace!.id };
      });
    }

    async function seedUser(): Promise<string> {
      const [user] = await database
        .insert(schema.users)
        .values({ email: `t26r-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });

      userIds.push(user!.id);

      return user!.id;
    }

    async function addMember(
      orgId: string,
      userId: string,
      role: 'owner' | 'admin' | 'member' | 'billing',
      acceptedAt: Date | null = new Date(),
    ): Promise<void> {
      await transactions.runInTenantTransaction(orgId, async (tx) => {
        await tx.insert(schema.memberships).values({ acceptedAt, orgId, role, userId });
      });
    }

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            ignoreEnvFile: true,
            isGlobal: true,
            validate: validateEnvironment,
          }),
          RedisModule,
          DatabaseModule,
        ],
        providers: [PermissionCache, PermissionResolutionService],
      }).compile();

      await moduleRef.init();

      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      permissions = moduleRef.get(PermissionResolutionService);
      cache = moduleRef.get(PermissionCache);
      transactions = moduleRef.get(TenantTransactionRunner);
    }, 60_000);

    afterAll(async () => {
      if (userIds.length > 0) {
        await database.delete(schema.users).where(inArray(schema.users.id, userIds));
      }

      if (orgIds.length > 0) {
        await database.delete(schema.orgs).where(inArray(schema.orgs.id, orgIds));
      }

      await moduleRef?.close();
    });

    it('expands an accepted membership into its role’s org permissions', async () => {
      const { orgId } = await seedTenant();
      const userId = await seedUser();

      await addMember(orgId, userId, 'admin');

      const held = await permissions.for(orgId, userId);

      expect([...held].sort()).toEqual([...ORG_ROLE_PERMISSIONS.admin].sort());
    });

    it('expands a project grant into entries qualified with that project', async () => {
      const { orgId, projectId } = await seedTenant();
      const userId = await seedUser();

      await transactions.runInTenantTransaction(orgId, async (tx) => {
        await tx.insert(schema.projectGrants).values({ orgId, projectId, role: 'editor', userId });
      });

      const held = await permissions.for(orgId, userId);

      expect([...held].sort()).toEqual(
        [...PROJECT_ROLE_PERMISSIONS.editor].map((slug) => scoped(slug, projectId)).sort(),
      );
    });

    /** A workspace role is a member's (T24): it is only entered from an accepted membership. */
    it('expands a workspace role into entries qualified with that workspace', async () => {
      const { orgId, workspaceId } = await seedTenant();
      const userId = await seedUser();

      await addMember(orgId, userId, 'member');
      await transactions.runInTenantTransaction(orgId, async (tx) => {
        await tx
          .insert(schema.workspaceMembers)
          .values({ orgId, role: 'editor', userId, workspaceId });
      });

      const held = await permissions.for(orgId, userId);

      expect([...held].sort()).toEqual(
        [
          ...ORG_ROLE_PERMISSIONS.member,
          ...[...WORKSPACE_ROLE_PERMISSIONS.editor].map((slug) => scoped(slug, workspaceId)),
        ].sort(),
      );
    });

    /**
     * Spec 007 R5: archive keeps the grant and member rows (ADR 012), so the loads join the
     * container and drop rows whose container is gone. Without this a stale `project:read@{id}`
     * would still pass the guard on an archived project (SC-006).
     */
    it('gives a grant on an archived project nothing', async () => {
      const { orgId, projectId } = await seedTenant();
      const userId = await seedUser();

      await transactions.runInTenantTransaction(orgId, async (tx) => {
        await tx.insert(schema.projectGrants).values({ orgId, projectId, role: 'editor', userId });
        await tx
          .update(schema.projects)
          .set({ deletedAt: new Date() })
          .where(eq(schema.projects.id, projectId));
      });

      await expect(permissions.for(orgId, userId)).resolves.toEqual(new Set());
    });

    it('gives a role in an archived workspace nothing beyond the org role', async () => {
      const { orgId, workspaceId } = await seedTenant();
      const userId = await seedUser();

      await addMember(orgId, userId, 'member');
      await transactions.runInTenantTransaction(orgId, async (tx) => {
        await tx
          .insert(schema.workspaceMembers)
          .values({ orgId, role: 'admin', userId, workspaceId });
        await tx
          .update(schema.workspaces)
          .set({ deletedAt: new Date() })
          .where(eq(schema.workspaces.id, workspaceId));
      });

      await expect(permissions.for(orgId, userId)).resolves.toEqual(
        new Set(ORG_ROLE_PERMISSIONS.member),
      );
    });

    it('gives a stranger nothing', async () => {
      const { orgId } = await seedTenant();

      await expect(permissions.for(orgId, await seedUser())).resolves.toEqual(new Set());
    });

    /**
     * An issued invitation is not access (T24). Asserted here as well as in the resolver's own
     * tests, because this is the path that decides which rows the resolver ever sees — a query that
     * forgot the distinction would be invisible to a pure-function test.
     */
    it('gives a member who has not accepted nothing', async () => {
      const { orgId } = await seedTenant();
      const userId = await seedUser();

      await addMember(orgId, userId, 'owner', null);

      await expect(permissions.for(orgId, userId)).resolves.toEqual(new Set());
    });

    /**
     * The window between delete and purge exists so a tenant can be restored (ADR 012); it must not
     * also be a window in which the last owner can still export the audit trail.
     */
    it('gives an owner of a soft-deleted organisation nothing', async () => {
      const { orgId } = await seedTenant();
      const userId = await seedUser();

      await addMember(orgId, userId, 'owner');
      await database
        .update(schema.orgs)
        .set({ deletedAt: new Date() })
        .where(eq(schema.orgs.id, orgId));

      await expect(permissions.for(orgId, userId)).resolves.toEqual(new Set());
    });

    /**
     * An organisation that does not exist answers exactly as one the caller does not belong to. The
     * guard turns both into the same denial, which is what stops a caller walking uuids to learn
     * which ones name real tenants.
     */
    it('gives nothing for an organisation that does not exist', async () => {
      await expect(permissions.for(randomUUID(), await seedUser())).resolves.toEqual(new Set());
    });

    it('never reaches another organisation’s membership', async () => {
      const mine = await seedTenant();
      const theirs = await seedTenant();
      const userId = await seedUser();

      await addMember(mine.orgId, userId, 'owner');

      await expect(permissions.for(theirs.orgId, userId)).resolves.toEqual(new Set());
    });

    it('never reaches another user’s membership', async () => {
      const { orgId } = await seedTenant();
      const owner = await seedUser();

      await addMember(orgId, owner, 'owner');

      await expect(permissions.for(orgId, await seedUser())).resolves.toEqual(new Set());
    });

    /**
     * The read-through, proved by the one observation that distinguishes a cache from a query: the
     * rows change and the answer does not, until the entry is deleted.
     *
     * This is also the setup for T27. A stale set after a role change is the bug §11's invalidation
     * rule exists to prevent, and it is a *real* bug here rather than a theoretical one — which is
     * why membership changes must call `PermissionCache.invalidate` rather than trusting the TTL.
     */
    it('serves the second call from the cache, and a fresh one after invalidation', async () => {
      const { orgId } = await seedTenant();
      const userId = await seedUser();

      await addMember(orgId, userId, 'member');

      await expect(permissions.for(orgId, userId)).resolves.toEqual(
        new Set(ORG_ROLE_PERMISSIONS.member),
      );

      await transactions.runInTenantTransaction(orgId, async (tx) => {
        await tx
          .update(schema.memberships)
          .set({ role: 'owner' })
          .where(eq(schema.memberships.userId, userId));
      });

      await expect(permissions.for(orgId, userId)).resolves.toEqual(
        new Set(ORG_ROLE_PERMISSIONS.member),
      );

      await cache.invalidate(orgId, userId);

      await expect(permissions.for(orgId, userId)).resolves.toEqual(
        new Set(ORG_ROLE_PERMISSIONS.owner),
      );
    });
  });
});
