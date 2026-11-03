import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { outbox, schema } from '@repo/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../../../app.module';
import { DomainError } from '../../../common/errors/domain-error';
import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { PresenceService } from '../presence/presence.service';
import { OrgService } from './org.service';
import { ProjectGrantService } from './project-grant.service';
import { ProjectService } from './project.service';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

/**
 * Spec 031 US2 (data-model § 3, contracts/sharing.md § 5): the rules a grant change gained — the
 * last owner stays, a changed role is audited as a change, and losing the right to run tells the
 * run line (`project.access-removed`) and presence.
 */
describe('ProjectGrantService', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and both Redis roles', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let orgs: OrgService;
    let projects: ProjectService;
    let grants: ProjectGrantService;
    let presence: PresenceService;
    let transactions: TenantTransactionRunner;
    const orgIds: string[] = [];
    const userIds: string[] = [];

    async function seedUser(): Promise<string> {
      const [user] = await database
        .insert(schema.users)
        .values({ email: `t031g-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });

      userIds.push(user!.id);

      return user!.id;
    }

    async function asRequest<T>(orgId: string, userId: string, fn: () => Promise<T>): Promise<T> {
      return transactions.runInTenantScope({ orgId, userId }, () => fn());
    }

    /** An org, and one project in it whose only owner (by grant) is its creator. */
    async function fixture(): Promise<{ orgId: string; ownerId: string; projectId: string }> {
      const ownerId = await seedUser();
      const org = await orgs.create(ownerId, {
        name: 'Grants',
        slug: `t031g-${randomUUID().slice(0, 8)}`,
      });

      orgIds.push(org.id);

      const [workspace] = await transactions.runInTenantTransaction(org.id, (tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      );
      const project = await asRequest(org.id, ownerId, () =>
        projects.create({
          actorId: ownerId,
          name: 'Shared',
          orgId: org.id,
          ownerId,
          workspaceId: workspace!.id,
        }),
      );

      return { orgId: org.id, ownerId, projectId: project.id };
    }

    async function refusal(promise: Promise<unknown>): Promise<unknown> {
      return promise.then(
        () => expect.unreachable('expected a refusal'),
        (caught: unknown) => caught,
      );
    }

    async function auditActions(orgId: string): Promise<string[]> {
      const rows = await transactions.runInTenantTransaction(orgId, (tx) =>
        tx
          .select({ action: schema.auditLog.action })
          .from(schema.auditLog)
          .where(sql`${schema.auditLog.action} like 'project-grant.%'`),
      );

      return rows.map((row) => row.action).sort();
    }

    async function accessRemoved(orgId: string, userId: string) {
      return database
        .select({ payload: outbox.payload })
        .from(outbox)
        .where(
          and(
            eq(outbox.type, 'project.access-removed'),
            eq(outbox.originOrgId, orgId),
            sql`${outbox.payload}->>'userId' = ${userId}`,
          ),
        );
    }

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await moduleRef.init();

      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      orgs = moduleRef.get(OrgService);
      projects = moduleRef.get(ProjectService);
      grants = moduleRef.get(ProjectGrantService);
      presence = moduleRef.get(PresenceService);
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

    it('refuses removing the last owner with 409 last-owner', async () => {
      const { orgId, ownerId, projectId } = await fixture();

      const caught = await refusal(
        asRequest(orgId, ownerId, () =>
          grants.revoke({ actorId: ownerId, orgId, projectId, userId: ownerId }),
        ),
      );

      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).type).toBe('conflict');
      expect((caught as DomainError).extensions).toMatchObject({ reason: 'last-owner' });
    });

    it('refuses demoting the last owner with 409 last-owner', async () => {
      const { orgId, ownerId, projectId } = await fixture();

      const caught = await refusal(
        asRequest(orgId, ownerId, () =>
          grants.grant({ actorId: ownerId, orgId, projectId, role: 'editor', userId: ownerId }),
        ),
      );

      expect((caught as DomainError).type).toBe('conflict');
      expect((caught as DomainError).extensions).toMatchObject({ reason: 'last-owner' });

      // And a second owner makes the same demotion legal.
      const other = await seedUser();

      await asRequest(orgId, ownerId, async () => {
        await grants.grant({ actorId: ownerId, orgId, projectId, role: 'owner', userId: other });
        await grants.grant({ actorId: ownerId, orgId, projectId, role: 'editor', userId: ownerId });
      });
    });

    it('records project-grant.role-changed when a row already existed', async () => {
      const { orgId, ownerId, projectId } = await fixture();
      const guest = await seedUser();

      await asRequest(orgId, ownerId, async () => {
        await grants.grant({ actorId: ownerId, orgId, projectId, role: 'viewer', userId: guest });
        await grants.grant({ actorId: ownerId, orgId, projectId, role: 'editor', userId: guest });
      });

      // `projects.create` grants its owner too, which is the first `granted` here.
      expect(await auditActions(orgId)).toEqual([
        'project-grant.granted',
        'project-grant.granted',
        'project-grant.role-changed',
      ]);
    });

    it('appends project.access-removed on revoke', async () => {
      const { orgId, ownerId, projectId } = await fixture();
      const guest = await seedUser();

      await asRequest(orgId, ownerId, async () => {
        await grants.grant({ actorId: ownerId, orgId, projectId, role: 'editor', userId: guest });
      });

      expect(await accessRemoved(orgId, guest)).toEqual([]);

      await asRequest(orgId, ownerId, () =>
        grants.revoke({ actorId: ownerId, orgId, projectId, userId: guest }),
      );

      expect(await accessRemoved(orgId, guest)).toEqual([
        { payload: { orgId, projectId, userId: guest } },
      ]);
    });

    it('appends project.access-removed when the new role lacks project:agent.run', async () => {
      const { orgId, ownerId, projectId } = await fixture();
      const guest = await seedUser();

      await asRequest(orgId, ownerId, async () => {
        await grants.grant({ actorId: ownerId, orgId, projectId, role: 'editor', userId: guest });
        // editor → owner keeps the right to run: nothing to tell the line.
        await grants.grant({ actorId: ownerId, orgId, projectId, role: 'owner', userId: guest });
      });

      expect(await accessRemoved(orgId, guest)).toEqual([]);

      await asRequest(orgId, ownerId, () =>
        grants.grant({ actorId: ownerId, orgId, projectId, role: 'viewer', userId: guest }),
      );

      expect(await accessRemoved(orgId, guest)).toHaveLength(1);
    });

    it('deletes the presence field after commit on revoke', async () => {
      const { orgId, ownerId, projectId } = await fixture();
      const guest = await seedUser();
      const forget = vi.spyOn(presence, 'forget');

      try {
        await asRequest(orgId, ownerId, async () => {
          await grants.grant({ actorId: ownerId, orgId, projectId, role: 'viewer', userId: guest });
          await grants.revoke({ actorId: ownerId, orgId, projectId, userId: guest });

          // Queued, not yet run: the write has not committed.
          expect(forget).not.toHaveBeenCalled();
        });

        expect(forget).toHaveBeenCalledWith(orgId, projectId, guest);
      } finally {
        forget.mockRestore();
      }
    });
  });
});
