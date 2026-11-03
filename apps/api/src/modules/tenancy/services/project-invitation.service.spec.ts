import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { outbox, schema } from '@repo/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { AppModule } from '../../../app.module';
import { CLOCK } from '../../../common/clock/clock.port';
import { FakeClock } from '../../../common/clock/fake-clock';
import type { DomainError } from '../../../common/errors/domain-error';
import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase } from '../../../database/database.types';
import { TenantContext } from '../../../database/tenant-context';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { TokenService } from '../../identity/services/token.service';
import type { ProjectRole } from '../../rbac/permissions';
import { OrgService } from './org.service';
import { ProjectInvitationService } from './project-invitation.service';
import { ProjectService } from './project.service';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const START = '2026-09-23T09:00:00.000Z';
const DAY = 24 * 60 * 60 * 1_000;

/**
 * Spec 031 US2 (research R5, contracts/sharing.md §§ 2–4): inviting an address to one project,
 * withdrawing it, and accepting it.
 */
describe('ProjectInvitationService', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and both Redis roles', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let orgs: OrgService;
    let projects: ProjectService;
    let invitations: ProjectInvitationService;
    let tenant: TenantContext;
    let tokens: TokenService;
    let transactions: TenantTransactionRunner;
    let clock: FakeClock;
    const orgIds: string[] = [];
    const userIds: string[] = [];

    async function seedUser(): Promise<{ email: string; id: string }> {
      const email = `t031i-${randomUUID()}@example.test`;
      const [user] = await database
        .insert(schema.users)
        .values({ email, emailVerifiedAt: clock.now(), passwordHash: 'x' })
        .returning({ id: schema.users.id });

      userIds.push(user!.id);

      return { email, id: user!.id };
    }

    async function asRequest<T>(orgId: string, userId: string, fn: () => Promise<T>): Promise<T> {
      return transactions.runInTenantScope({ orgId, userId }, () => fn());
    }

    /** An org and two projects in it, owned (by grant) by their creator. */
    async function fixture() {
      const owner = await seedUser();
      const org = await orgs.create(owner.id, {
        name: 'Sharing',
        slug: `t031i-${randomUUID().slice(0, 8)}`,
      });

      orgIds.push(org.id);

      const [workspace] = await transactions.runInTenantTransaction(org.id, (tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      );
      const [project, other] = await asRequest(org.id, owner.id, async () => [
        await projects.create({
          actorId: owner.id,
          name: 'Shared',
          orgId: org.id,
          ownerId: owner.id,
          workspaceId: workspace!.id,
        }),
        await projects.create({
          actorId: owner.id,
          name: 'Not shared',
          orgId: org.id,
          ownerId: owner.id,
          workspaceId: workspace!.id,
        }),
      ]);

      return { orgId: org.id, otherProjectId: other.id, owner, projectId: project.id };
    }

    function invite(
      f: { orgId: string; owner: { id: string }; projectId: string },
      email: string,
      role: ProjectRole = 'editor',
    ) {
      return asRequest(f.orgId, f.owner.id, () =>
        invitations.invite({
          actorId: f.owner.id,
          email,
          orgId: f.orgId,
          projectId: f.projectId,
          role,
        }),
      );
    }

    /** Rotate the invitation's hash to a token this test holds, as the mail consumer does. */
    async function tokenFor(orgId: string, invitationId: string): Promise<string> {
      const issued = tokens.issue(60);

      await transactions.runInTenantTransaction(orgId, (tx) =>
        tx
          .update(schema.projectInvitations)
          .set({ tokenHash: issued.tokenHash })
          .where(eq(schema.projectInvitations.id, invitationId)),
      );

      return issued.token;
    }

    function accept(orgId: string, userId: string, token: string) {
      return asRequest(orgId, userId, () => invitations.accept({ actorId: userId, orgId, token }));
    }

    async function refusal(promise: Promise<unknown>): Promise<DomainError> {
      return promise.then(
        () => expect.unreachable('expected a refusal'),
        (caught: unknown) => caught as DomainError,
      );
    }

    async function grantOf(orgId: string, projectId: string, userId: string) {
      const [row] = await transactions.runInTenantTransaction(orgId, (tx) =>
        tx
          .select({ role: schema.projectGrants.role })
          .from(schema.projectGrants)
          .where(
            and(
              eq(schema.projectGrants.projectId, projectId),
              eq(schema.projectGrants.userId, userId),
            ),
          ),
      );

      return row?.role;
    }

    beforeAll(async () => {
      clock = new FakeClock(START);

      moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(CLOCK)
        .useValue(clock)
        .compile();
      await moduleRef.init();

      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      orgs = moduleRef.get(OrgService);
      projects = moduleRef.get(ProjectService);
      invitations = moduleRef.get(ProjectInvitationService);
      tenant = moduleRef.get(TenantContext);
      tokens = moduleRef.get(TokenService, { strict: false });
      transactions = moduleRef.get(TenantTransactionRunner);
    }, 60_000);

    beforeEach(() => {
      clock.set(START);
    });

    afterAll(async () => {
      if (orgIds.length > 0) {
        await database.delete(schema.orgs).where(inArray(schema.orgs.id, orgIds));
      }

      if (userIds.length > 0) {
        await database.delete(schema.users).where(inArray(schema.users.id, userIds));
      }

      await moduleRef?.close();
    });

    /**
     * SC-007 / FR-020, structurally: every `from(...)` the service issues during `invite` is
     * recorded, and neither `users` nor `project_grants` is among them — it cannot leak what it
     * never looks up. The three answers are then the same shape.
     */
    it('answers the same 202 body for an unknown address, an existing account and an address that already has access', async () => {
      const f = await fixture();
      const existing = await seedUser();
      const unknown = `t031i-${randomUUID()}@example.test`;
      const read: unknown[] = [];

      const answers = await asRequest(f.orgId, f.owner.id, async () => {
        const tx = tenant.tx;
        const select = tx.select.bind(tx);
        const selectDistinct = tx.selectDistinct.bind(tx);
        const record =
          <F extends (...args: never[]) => { from: (table: unknown) => unknown }>(fn: F) =>
          (...args: Parameters<F>) => {
            const builder = fn(...args);
            const from = builder.from.bind(builder);

            builder.from = (table: unknown) => {
              read.push(table);

              return from(table);
            };

            return builder;
          };

        Object.assign(tx, {
          select: record(select as never),
          selectDistinct: record(selectDistinct as never),
        });

        try {
          const request = { actorId: f.owner.id, orgId: f.orgId, projectId: f.projectId };

          return [
            await invitations.invite({ ...request, email: unknown, role: 'viewer' }),
            await invitations.invite({ ...request, email: existing.email, role: 'viewer' }),
            await invitations.invite({ ...request, email: f.owner.email, role: 'viewer' }),
          ];
        } finally {
          Object.assign(tx, { select, selectDistinct });
        }
      });

      expect(read).not.toContain(schema.users);
      expect(read).not.toContain(schema.projectGrants);

      for (const answer of answers) {
        expect(Object.keys(answer).sort()).toEqual(['expiresAt', 'id', 'status']);
        expect(answer.status).toBe('invitation-sent');
        expect(answer.expiresAt).toBe(new Date(Date.parse(START) + 7 * DAY).toISOString());
      }
    });

    it('a second invite to an open address answers the first invitation', async () => {
      const f = await fixture();
      const email = `t031i-${randomUUID()}@example.test`;

      const first = await invite(f, email);
      const second = await invite(f, email);

      expect(second).toEqual(first);
    });

    it('accept grants the invited role on that project only', async () => {
      const f = await fixture();
      const guest = await seedUser();
      const { id } = await invite(f, guest.email, 'commenter');

      const answer = await accept(f.orgId, guest.id, await tokenFor(f.orgId, id));

      expect(answer).toEqual({ projectId: f.projectId });
      expect(await grantOf(f.orgId, f.projectId, guest.id)).toBe('commenter');
      expect(await grantOf(f.orgId, f.otherProjectId, guest.id)).toBeUndefined();

      const [membership] = await transactions.runInTenantTransaction(f.orgId, (tx) =>
        tx.select().from(schema.memberships).where(eq(schema.memberships.userId, guest.id)),
      );

      expect(membership).toBeUndefined();
    });

    it('accept refuses a signed-in address that differs', async () => {
      const f = await fixture();
      const guest = await seedUser();
      const stranger = await seedUser();
      const { id } = await invite(f, guest.email);
      const token = await tokenFor(f.orgId, id);

      const caught = await refusal(accept(f.orgId, stranger.id, token));

      expect(caught.type).toBe('forbidden');
      expect(caught.message).toBe('That invitation was sent to a different address.');
      // The claim rolled back with the refusal: the right person can still use it.
      await expect(accept(f.orgId, guest.id, token)).resolves.toEqual({ projectId: f.projectId });
    });

    it("accept refuses an unknown, expired, used or withdrawn token with the org accept's one message", async () => {
      const f = await fixture();
      const guest = await seedUser();
      const messages = new Set<string>();

      // Unknown.
      messages.add((await refusal(accept(f.orgId, guest.id, tokens.issue(60).token))).message);

      // Used.
      const used = await invite(f, guest.email);
      const usedToken = await tokenFor(f.orgId, used.id);

      await accept(f.orgId, guest.id, usedToken);
      messages.add((await refusal(accept(f.orgId, guest.id, usedToken))).message);

      // Withdrawn.
      const withdrawn = await invite(f, `t031i-${randomUUID()}@example.test`);
      const withdrawnToken = await tokenFor(f.orgId, withdrawn.id);

      await asRequest(f.orgId, f.owner.id, () =>
        invitations.withdraw({
          actorId: f.owner.id,
          invitationId: withdrawn.id,
          orgId: f.orgId,
          projectId: f.projectId,
        }),
      );
      messages.add((await refusal(accept(f.orgId, guest.id, withdrawnToken))).message);

      // Expired.
      const expired = await invite(f, `t031i-${randomUUID()}@example.test`);
      const expiredToken = await tokenFor(f.orgId, expired.id);

      clock.set(new Date(Date.parse(START) + 8 * DAY).toISOString());
      messages.add((await refusal(accept(f.orgId, guest.id, expiredToken))).message);

      expect([...messages]).toEqual([
        'That invitation link is not one we recognise. Check that you copied the whole link.',
      ]);
    });

    it('accept never lowers an existing grant', async () => {
      const f = await fixture();
      const guest = await seedUser();

      await transactions.runInTenantTransaction(f.orgId, (tx) =>
        tx
          .insert(schema.projectGrants)
          .values({ orgId: f.orgId, projectId: f.projectId, role: 'editor', userId: guest.id }),
      );

      const { id } = await invite(f, guest.email, 'viewer');

      await accept(f.orgId, guest.id, await tokenFor(f.orgId, id));

      expect(await grantOf(f.orgId, f.projectId, guest.id)).toBe('editor');
    });

    it('withdraw stamps revoked_at and the token stops working', async () => {
      const f = await fixture();
      const guest = await seedUser();
      const { id } = await invite(f, guest.email);
      const token = await tokenFor(f.orgId, id);

      await asRequest(f.orgId, f.owner.id, () =>
        invitations.withdraw({
          actorId: f.owner.id,
          invitationId: id,
          orgId: f.orgId,
          projectId: f.projectId,
        }),
      );

      const [row] = await transactions.runInTenantTransaction(f.orgId, (tx) =>
        tx
          .select({ revokedAt: schema.projectInvitations.revokedAt })
          .from(schema.projectInvitations)
          .where(eq(schema.projectInvitations.id, id)),
      );

      expect(row?.revokedAt).toEqual(new Date(START));
      expect((await refusal(accept(f.orgId, guest.id, token))).type).toBe('token-invalid');

      // A second withdraw is a 404.
      const again = await refusal(
        asRequest(f.orgId, f.owner.id, () =>
          invitations.withdraw({
            actorId: f.owner.id,
            invitationId: id,
            orgId: f.orgId,
            projectId: f.projectId,
          }),
        ),
      );

      expect(again.type).toBe('not-found');
    });

    it('writes project-invitation.created, .accepted and .revoked audit rows', async () => {
      const f = await fixture();
      const guest = await seedUser();
      const accepted = await invite(f, guest.email);

      await accept(f.orgId, guest.id, await tokenFor(f.orgId, accepted.id));

      const revoked = await invite(f, `t031i-${randomUUID()}@example.test`);

      await asRequest(f.orgId, f.owner.id, () =>
        invitations.withdraw({
          actorId: f.owner.id,
          invitationId: revoked.id,
          orgId: f.orgId,
          projectId: f.projectId,
        }),
      );

      const rows = await transactions.runInTenantTransaction(f.orgId, (tx) =>
        tx
          .select({ action: schema.auditLog.action })
          .from(schema.auditLog)
          .where(sql`${schema.auditLog.action} like 'project-invitation.%'`),
      );

      expect(rows.map((row) => row.action).sort()).toEqual([
        'project-invitation.accepted',
        'project-invitation.created',
        'project-invitation.created',
        'project-invitation.revoked',
      ]);

      // And the mail events, ids only.
      const events = await database
        .select({ payload: outbox.payload })
        .from(outbox)
        .where(and(eq(outbox.type, 'mail.project-invitation'), eq(outbox.originOrgId, f.orgId)))
        .orderBy(outbox.seq);

      expect(events).toHaveLength(2);
      expect(events[0]?.payload).toEqual({ invitationId: accepted.id, orgId: f.orgId });
    });
  });
});
