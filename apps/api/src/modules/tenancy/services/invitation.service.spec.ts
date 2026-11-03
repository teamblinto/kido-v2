import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { INVITATION_ACCEPTED, INVITATION_SENT } from '@repo/contracts';
import { outbox, schema } from '@repo/db';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { AppModule } from '../../../app.module';
import { CLOCK } from '../../../common/clock/clock.port';
import { FakeClock } from '../../../common/clock/fake-clock';
import { DomainError } from '../../../common/errors/domain-error';
import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { TokenService } from '../../identity/services/token.service';
import { PermissionCache } from '../../rbac/permission-cache';
import { InvitationService } from './invitation.service';
import { OrgService } from './org.service';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

/** The instant every test in this file starts at. Nothing here reads the host clock. */
const START = '2026-03-01T09:00:00.000Z';

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

/** The slug and nothing else — the assertion that survives a reworded sentence. */
function slugOf(error: unknown): string {
  return error instanceof DomainError ? error.type : `not a DomainError: ${String(error)}`;
}

describe('InvitationService', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and both Redis roles', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let invitations: InvitationService;
    let orgs: OrgService;
    let cache: PermissionCache;
    let transactions: TenantTransactionRunner;
    let clock: FakeClock;
    let tokens: TokenService;
    const userIds: string[] = [];
    const orgIds: string[] = [];

    async function seedUser(): Promise<{ email: string; id: string }> {
      const email = `t29s-${randomUUID()}@example.test`;
      const [user] = await database
        .insert(schema.users)
        .values({ email, emailVerifiedAt: clock.now(), passwordHash: 'x' })
        .returning({ id: schema.users.id });

      userIds.push(user!.id);

      return { email, id: user!.id };
    }

    /** An organisation through the product's own path, so the fixture is not a second one. */
    async function seedOrg(ownerId: string): Promise<string> {
      const org = await orgs.create(ownerId, {
        name: 'Invitation fixture',
        slug: `t29s-${randomUUID().slice(0, 8)}`,
      });

      orgIds.push(org.id);

      return org.id;
    }

    /** Run `fn` the way a request would: inside the tenant scope, hooks drained on the way out. */
    async function asRequest<T>(orgId: string, userId: string, fn: () => Promise<T>): Promise<T> {
      return transactions.runInTenantScope({ orgId, userId }, () => fn());
    }

    /**
     * A link for the newest open invitation in the organisation, minted the way the consumer mints
     * one (spec 006): rotate `token_hash` to a token this test holds. The consumer's own rotation
     * is `invitation-mail.consumer.spec.ts`'s; this suite is about issuing and accepting.
     */
    async function mintedToken(orgId: string): Promise<string> {
      const issued = tokens.issue(60);
      const [rotated] = await transactions.runInTenantTransaction(orgId, (tx) =>
        tx
          .update(schema.invitations)
          .set({ tokenHash: issued.tokenHash })
          .where(
            inArray(
              schema.invitations.id,
              tx
                .select({ id: schema.invitations.id })
                .from(schema.invitations)
                .where(
                  and(
                    eq(schema.invitations.orgId, orgId),
                    isNull(schema.invitations.acceptedAt),
                    isNull(schema.invitations.revokedAt),
                  ),
                )
                .orderBy(desc(schema.invitations.createdAt))
                .limit(1),
            ),
          )
          .returning({ id: schema.invitations.id }),
      );

      return rotated === undefined
        ? expect.unreachable('no open invitation to mint a link for')
        : issued.token;
    }

    /** The mail events appended for an address — what `invite` produces in place of a send. */
    async function eventsFor(email: string): Promise<{ orgId: string | null; type: string }[]> {
      return database
        .select({ orgId: outbox.originOrgId, type: outbox.type })
        .from(outbox)
        .where(sql`${outbox.payload}->>'recipient' = ${email}`)
        .orderBy(outbox.seq);
    }
    async function joined(orgId: string) {
      return database
        .select({ orgId: outbox.originOrgId, payload: outbox.payload })
        .from(outbox)
        .where(and(eq(outbox.type, 'member.joined'), eq(outbox.originOrgId, orgId)));
    }

    async function auditActions(orgId: string): Promise<string[]> {
      const rows = await transactions.runInTenantTransaction(orgId, (tx) =>
        tx.select({ action: schema.auditLog.action }).from(schema.auditLog),
      );

      return rows.map((row) => row.action).sort();
    }

    beforeAll(async () => {
      clock = new FakeClock(START);

      moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(CLOCK)
        .useValue(clock)
        .compile();
      await moduleRef.init();

      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      invitations = moduleRef.get(InvitationService);
      orgs = moduleRef.get(OrgService);
      cache = moduleRef.get(PermissionCache);
      transactions = moduleRef.get(TenantTransactionRunner);
      tokens = moduleRef.get(TokenService, { strict: false });
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

    describe('invite', () => {
      it('records an invitation and answers with it', async () => {
        const owner = await seedUser();
        const orgId = await seedOrg(owner.id);

        const response = await asRequest(orgId, owner.id, () =>
          invitations.invite({
            actorId: owner.id,
            email: 'ada@example.test',
            orgId,
            role: 'member',
          }),
        );

        expect(response.status).toBe(INVITATION_SENT);

        const [row] = await transactions.runInTenantTransaction(orgId, (tx) =>
          tx.select().from(schema.invitations).where(eq(schema.invitations.id, response.id)),
        );

        expect(row?.email).toBe('ada@example.test');
        expect(row?.role).toBe('member');
        expect(row?.invitedBy).toBe(owner.id);
        expect(row?.acceptedAt).toBeNull();
      });

      /**
       * The window is arithmetic on the injected clock, not on the host's. Asserting the exact
       * instant is what makes that true — a `new Date()` anywhere in the path would put the expiry
       * a few milliseconds past this value and fail here rather than in a year's time.
       */
      it('expires the invitation a week after the injected clock, to the millisecond', async () => {
        const owner = await seedUser();
        const orgId = await seedOrg(owner.id);

        const response = await asRequest(orgId, owner.id, () =>
          invitations.invite({
            actorId: owner.id,
            email: 'ada@example.test',
            orgId,
            role: 'member',
          }),
        );

        expect(response.expiresAt).toBe(new Date(Date.parse(START) + 7 * DAY).toISOString());
      });

      /**
       * The column is `not null` and the consumer rotates it before any link exists (spec 006), so
       * what the producer stores is a digest of a token nobody holds — never a token.
       */
      it('stores a digest and never a token', async () => {
        const owner = await seedUser();
        const orgId = await seedOrg(owner.id);

        await asRequest(orgId, owner.id, () =>
          invitations.invite({
            actorId: owner.id,
            email: 'ada@example.test',
            orgId,
            role: 'member',
          }),
        );

        const [row] = await transactions.runInTenantTransaction(orgId, (tx) =>
          tx.select({ tokenHash: schema.invitations.tokenHash }).from(schema.invitations),
        );

        expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      });

      /** The mail is one outbox row on the tenant transaction, after the audit entry (spec 006). */
      it('appends one invitation event carrying the organisation', async () => {
        const owner = await seedUser();
        const orgId = await seedOrg(owner.id);
        const email = `t29s-${randomUUID()}@example.test`;

        await asRequest(orgId, owner.id, () =>
          invitations.invite({ actorId: owner.id, email, orgId, role: 'member' }),
        );

        expect(await eventsFor(email)).toEqual([{ orgId, type: 'mail.invitation' }]);
      });

      /** Resolving to the open row is not a second invitation, so it is not a second mail. */
      it('appends no event when it resolves to the open invitation', async () => {
        const owner = await seedUser();
        const orgId = await seedOrg(owner.id);
        const email = `t29s-${randomUUID()}@example.test`;

        await asRequest(orgId, owner.id, () =>
          invitations.invite({ actorId: owner.id, email, orgId, role: 'member' }),
        );
        await asRequest(orgId, owner.id, () =>
          invitations.invite({ actorId: owner.id, email, orgId, role: 'member' }),
        );

        expect(await eventsFor(email)).toHaveLength(1);
      });

      it('writes invitation.created in the same transaction as the row', async () => {
        const owner = await seedUser();
        const orgId = await seedOrg(owner.id);

        await asRequest(orgId, owner.id, () =>
          invitations.invite({
            actorId: owner.id,
            email: 'ada@example.test',
            orgId,
            role: 'member',
          }),
        );

        expect(await auditActions(orgId)).toContain('invitation.created');
      });

      /**
       * §11's second layer, and the same rule `MembershipService.changeRole` holds for an existing
       * member: `org:members.invite` belongs to `admin`, and without this an admin could invite an
       * accomplice as `owner` and be outranked by their own invitation an hour later.
       */
      it('refuses to confer a role above the inviter’s own', async () => {
        const owner = await seedUser();
        const admin = await seedUser();
        const orgId = await seedOrg(owner.id);

        await asRequest(orgId, owner.id, () =>
          invitations.invite({ actorId: owner.id, email: admin.email, orgId, role: 'admin' }),
        );
        await asRequest(orgId, admin.id, async () =>
          invitations.accept({ actorId: admin.id, orgId, token: await mintedToken(orgId) }),
        );

        const error = await asRequest(orgId, admin.id, () =>
          invitations
            .invite({ actorId: admin.id, email: 'ada@example.test', orgId, role: 'owner' })
            .catch((thrown: unknown) => thrown),
        );

        expect(slugOf(error)).toBe('forbidden');
      });

      /**
       * Criterion 10's enumeration property, held down where it could break. An address with a Forge
       * account and one without must produce responses that differ in nothing but the two random
       * values every invitation has — and in particular the service must not have *looked*, because
       * a lookup is the thing a later refactor turns into a branch.
       */
      it('answers identically for an address that has an account and one that does not', async () => {
        const owner = await seedUser();
        const existing = await seedUser();
        const orgId = await seedOrg(owner.id);

        const known = await asRequest(orgId, owner.id, () =>
          invitations.invite({ actorId: owner.id, email: existing.email, orgId, role: 'member' }),
        );
        const unknown = await asRequest(orgId, owner.id, () =>
          invitations.invite({
            actorId: owner.id,
            email: `t29s-${randomUUID()}@example.test`,
            orgId,
            role: 'member',
          }),
        );

        expect(Object.keys(known).sort()).toStrictEqual(Object.keys(unknown).sort());
        expect(known.status).toBe(unknown.status);
        expect(known.expiresAt).toBe(unknown.expiresAt);
      });

      /**
       * The same property for the case the task names: an address that is *already a member*. An
       * admin may legitimately list their own members, so this is not about hiding membership — it
       * is that the only way to answer "is this address a member" is to look it up in `users`, and a
       * response that varied on the result would answer "does this address have an account" for
       * every address on earth.
       */
      it('answers identically for an address that is already a member', async () => {
        const owner = await seedUser();
        const member = await seedUser();
        const orgId = await seedOrg(owner.id);

        await asRequest(orgId, owner.id, () =>
          invitations.invite({ actorId: owner.id, email: member.email, orgId, role: 'member' }),
        );
        await asRequest(orgId, member.id, async () =>
          invitations.accept({ actorId: member.id, orgId, token: await mintedToken(orgId) }),
        );

        const again = await asRequest(orgId, owner.id, () =>
          invitations.invite({ actorId: owner.id, email: member.email, orgId, role: 'member' }),
        );
        const fresh = await asRequest(orgId, owner.id, () =>
          invitations.invite({
            actorId: owner.id,
            email: `t29s-${randomUUID()}@example.test`,
            orgId,
            role: 'member',
          }),
        );

        expect(Object.keys(again).sort()).toStrictEqual(Object.keys(fresh).sort());
        expect(again.status).toBe(fresh.status);
      });

      /**
       * `invitations_org_id_email_open_key` allows one open invitation per address per organisation,
       * and `schema/rbac.ts` says what the service does with the collision: resolve to the first,
       * "rather than two links that both work". Two live links would each be single-use and the
       * older one would be refused after the newer was clicked, which is a confusing way to lose an
       * invitation somebody already accepted.
       */
      it('resolves a second invitation for one address to the open one', async () => {
        const owner = await seedUser();
        const orgId = await seedOrg(owner.id);

        const first = await asRequest(orgId, owner.id, () =>
          invitations.invite({
            actorId: owner.id,
            email: 'ada@example.test',
            orgId,
            role: 'member',
          }),
        );
        const second = await asRequest(orgId, owner.id, () =>
          invitations.invite({
            actorId: owner.id,
            email: 'ada@example.test',
            orgId,
            role: 'member',
          }),
        );

        expect(second.id).toBe(first.id);

        const rows = await transactions.runInTenantTransaction(orgId, (tx) =>
          tx.select({ id: schema.invitations.id }).from(schema.invitations),
        );

        expect(rows).toHaveLength(1);
      });
    });

    describe('accept', () => {
      it('creates the membership in the role the invitation named', async () => {
        const owner = await seedUser();
        const invitee = await seedUser();
        const orgId = await seedOrg(owner.id);

        await asRequest(orgId, owner.id, () =>
          invitations.invite({ actorId: owner.id, email: invitee.email, orgId, role: 'admin' }),
        );

        const accepted = await asRequest(orgId, invitee.id, async () =>
          invitations.accept({ actorId: invitee.id, orgId, token: await mintedToken(orgId) }),
        );

        expect(accepted).toStrictEqual({ orgId, role: 'admin', status: INVITATION_ACCEPTED });

        const [membership] = await transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .select({ role: schema.memberships.role })
            .from(schema.memberships)
            .where(eq(schema.memberships.userId, invitee.id)),
        );

        expect(membership?.role).toBe('admin');
      });

      /** Spec 029 T037: the webhook fan-out's source for `member.joined`. Ids and a role only. */
      it('appends one member.joined {orgId, role, userId} on accept', async () => {
        const owner = await seedUser();
        const invitee = await seedUser();
        const orgId = await seedOrg(owner.id);

        await asRequest(orgId, owner.id, () =>
          invitations.invite({ actorId: owner.id, email: invitee.email, orgId, role: 'admin' }),
        );
        await asRequest(orgId, invitee.id, async () =>
          invitations.accept({ actorId: invitee.id, orgId, token: await mintedToken(orgId) }),
        );

        expect(await joined(orgId)).toEqual([
          { orgId, payload: { orgId, role: 'admin', userId: invitee.id } },
        ]);
      });

      it('a refused accept appends no member.joined', async () => {
        const owner = await seedUser();
        const invitee = await seedUser();
        const bystander = await seedUser();
        const orgId = await seedOrg(owner.id);

        await asRequest(orgId, owner.id, () =>
          invitations.invite({ actorId: owner.id, email: invitee.email, orgId, role: 'member' }),
        );
        await asRequest(orgId, bystander.id, async () =>
          invitations
            .accept({ actorId: bystander.id, orgId, token: await mintedToken(orgId) })
            .catch((t: unknown) => t),
        );

        expect(await joined(orgId)).toEqual([]);
      });

      it('writes invitation.accepted in the same transaction as the membership', async () => {
        const owner = await seedUser();
        const invitee = await seedUser();
        const orgId = await seedOrg(owner.id);

        await asRequest(orgId, owner.id, () =>
          invitations.invite({ actorId: owner.id, email: invitee.email, orgId, role: 'member' }),
        );
        await asRequest(orgId, invitee.id, async () =>
          invitations.accept({ actorId: invitee.id, orgId, token: await mintedToken(orgId) }),
        );

        const actions = await auditActions(orgId);

        expect(actions).toContain('invitation.accepted');
        expect(actions).toContain('membership.created');
      });

      /**
       * §09's rule is "explicit delete on write, never TTL alone". A set is cached per `(org, user)`
       * and an empty set for somebody who was not a member yet is a perfectly cacheable one — anybody
       * who probed a route in this organisation before accepting has one. Leaving it would refuse the
       * new member everything until the backstop TTL ran out.
       */
      it('invalidates the permission cache the invitee may already have an empty entry in', async () => {
        const owner = await seedUser();
        const invitee = await seedUser();
        const orgId = await seedOrg(owner.id);

        await asRequest(orgId, owner.id, () =>
          invitations.invite({ actorId: owner.id, email: invitee.email, orgId, role: 'member' }),
        );
        await cache.write(orgId, invitee.id, new Set<string>());

        await asRequest(orgId, invitee.id, async () =>
          invitations.accept({ actorId: invitee.id, orgId, token: await mintedToken(orgId) }),
        );

        expect(await cache.read(orgId, invitee.id)).toBeNull();
      });

      /** Criterion 10's "single use", and the case the e2e proves over HTTP as well. */
      it('refuses a token that has already been accepted', async () => {
        const owner = await seedUser();
        const invitee = await seedUser();
        const orgId = await seedOrg(owner.id);

        await asRequest(orgId, owner.id, () =>
          invitations.invite({ actorId: owner.id, email: invitee.email, orgId, role: 'member' }),
        );

        const token = await mintedToken(orgId);

        await asRequest(orgId, invitee.id, () =>
          invitations.accept({ actorId: invitee.id, orgId, token }),
        );

        const error = await asRequest(orgId, invitee.id, () =>
          invitations.accept({ actorId: invitee.id, orgId, token }).catch((t: unknown) => t),
        );

        expect(slugOf(error)).toBe('token-already-used');
      });

      it('refuses a token past its expiry, measured on the injected clock', async () => {
        const owner = await seedUser();
        const invitee = await seedUser();
        const orgId = await seedOrg(owner.id);

        await asRequest(orgId, owner.id, () =>
          invitations.invite({ actorId: owner.id, email: invitee.email, orgId, role: 'member' }),
        );

        const token = await mintedToken(orgId);

        clock.advance(7 * DAY + 1);

        const error = await asRequest(orgId, invitee.id, () =>
          invitations.accept({ actorId: invitee.id, orgId, token }).catch((t: unknown) => t),
        );

        expect(slugOf(error)).toBe('token-expired');
      });

      /** One millisecond the other side of the same boundary, so the test above is about the edge. */
      it('accepts a token in the last millisecond of its window', async () => {
        const owner = await seedUser();
        const invitee = await seedUser();
        const orgId = await seedOrg(owner.id);

        await asRequest(orgId, owner.id, () =>
          invitations.invite({ actorId: owner.id, email: invitee.email, orgId, role: 'member' }),
        );

        const token = await mintedToken(orgId);

        clock.advance(7 * DAY - 1);

        await expect(
          asRequest(orgId, invitee.id, () =>
            invitations.accept({ actorId: invitee.id, orgId, token }),
          ),
        ).resolves.toMatchObject({ status: INVITATION_ACCEPTED });
      });

      it('refuses a token nobody minted', async () => {
        const owner = await seedUser();
        const invitee = await seedUser();
        const orgId = await seedOrg(owner.id);

        const error = await asRequest(orgId, invitee.id, () =>
          invitations
            .accept({ actorId: invitee.id, orgId, token: 'not-a-token-anybody-minted' })
            .catch((t: unknown) => t),
        );

        expect(slugOf(error)).toBe('token-invalid');
        expect(owner.id).toBeTruthy();
      });

      /**
       * The invitation names an address, and the token travels to that address by mail. Binding the
       * two is what stops a forwarded link — or one pasted into a group chat — from being a
       * membership: without it, the first authenticated person to open somebody else's link joins
       * the organisation, and the audit row names them as though they were invited.
       */
      it('refuses a caller who is not the invited address', async () => {
        const owner = await seedUser();
        const invitee = await seedUser();
        const bystander = await seedUser();
        const orgId = await seedOrg(owner.id);

        await asRequest(orgId, owner.id, () =>
          invitations.invite({ actorId: owner.id, email: invitee.email, orgId, role: 'member' }),
        );

        const error = await asRequest(orgId, bystander.id, async () =>
          invitations
            .accept({ actorId: bystander.id, orgId, token: await mintedToken(orgId) })
            .catch((t: unknown) => t),
        );

        expect(slugOf(error)).toBe('forbidden');
      });

      /**
       * A refused acceptance must leave the link usable. The claim is conditional on
       * `accepted_at is null`, so the row must still be unclaimed after the refusal above — otherwise
       * a bystander who opened the link once would have burned an invitation that was never theirs.
       */
      it('leaves the invitation open after refusing the wrong caller', async () => {
        const owner = await seedUser();
        const invitee = await seedUser();
        const bystander = await seedUser();
        const orgId = await seedOrg(owner.id);

        await asRequest(orgId, owner.id, () =>
          invitations.invite({ actorId: owner.id, email: invitee.email, orgId, role: 'member' }),
        );

        const token = await mintedToken(orgId);

        // The rejection has to escape the tenant scope, exactly as it does when a handler throws:
        // rolling the claim back *is* the mechanism that leaves the link open, and a `catch` inside
        // the transaction callback would commit the claim and prove the opposite of the point.
        await expect(
          asRequest(orgId, bystander.id, () =>
            invitations.accept({ actorId: bystander.id, orgId, token }),
          ),
        ).rejects.toThrow();

        await expect(
          asRequest(orgId, invitee.id, () =>
            invitations.accept({ actorId: invitee.id, orgId, token }),
          ),
        ).resolves.toMatchObject({ status: INVITATION_ACCEPTED });
      });

      /**
       * The other half of the enumeration decision: because `invite` never looks in `users`, an
       * address that is already a member can hold an open invitation. Accepting it must not try to
       * insert a second membership row — the unique key would abort the transaction and the reader
       * would get a 500 for clicking a link that was sent to them.
       */
      it('is a no-op for somebody who is already a member', async () => {
        const owner = await seedUser();
        const member = await seedUser();
        const orgId = await seedOrg(owner.id);

        await asRequest(orgId, owner.id, () =>
          invitations.invite({ actorId: owner.id, email: member.email, orgId, role: 'member' }),
        );
        await asRequest(orgId, member.id, async () =>
          invitations.accept({ actorId: member.id, orgId, token: await mintedToken(orgId) }),
        );

        await asRequest(orgId, owner.id, () =>
          invitations.invite({ actorId: owner.id, email: member.email, orgId, role: 'admin' }),
        );

        await expect(
          asRequest(orgId, member.id, async () =>
            invitations.accept({ actorId: member.id, orgId, token: await mintedToken(orgId) }),
          ),
        ).resolves.toMatchObject({ status: INVITATION_ACCEPTED });

        const rows = await transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .select({ role: schema.memberships.role })
            .from(schema.memberships)
            .where(
              and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, member.id)),
            ),
        );

        // Still one row, and still the role they actually joined with: a second invitation is not a
        // promotion, and `org:members.role-change` is the route that exists for that.
        expect(rows).toHaveLength(1);
        expect(rows[0]?.role).toBe('member');
      });
    });
  });
});
