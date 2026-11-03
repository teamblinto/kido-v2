import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  MEMBER_REMOVED,
  orgListResponseSchema,
  orgMemberListResponseSchema,
  orgResponseSchema,
  workspaceListResponseSchema,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { eq, inArray } from 'drizzle-orm';
import { randomInt, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../src/modules/identity/password/breached-password.port';
import { PasswordHasher } from '../src/modules/identity/password/hasher';
import { MembershipService } from '../src/modules/tenancy/services/membership.service';
import { WorkspaceService } from '../src/modules/tenancy/services/workspace.service';
import { unsafe } from './support/csrf-client';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.LOGIN_THROTTLE_ACCOUNT_BURST = '100';
  process.env.LOGIN_THROTTLE_IP_BURST = '4000';
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const LOGIN = '/api/v1/auth/login';
const ORGS = '/api/v1/orgs';
const PASSWORD = 'thermos-quibble-tundra-vellum';

/** `198.32/16`, distinct from the ranges the other e2e suites claim against the same Redis. */
const RUN = randomInt(0, 256);
let issuedAddresses = 0;

function nextClientAddress(): string {
  issuedAddresses += 1;

  const slot = (RUN * 256 + issuedAddresses) % 65_536;

  return `198.32.${Math.floor(slot / 256)}.${slot % 256}`;
}

class ScriptedBreachPort implements BreachedPasswordPort {
  isBreached(_password: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/**
 * A signed-in HTTP client, held for the life of a test.
 *
 * Deliberately a *client* rather than a token: the removal proof turns on a second client that
 * opened its session before the removal and keeps using it afterwards, which is the situation a
 * removed collaborator is actually in.
 */
interface Client {
  readonly cookie: string;
  readonly email: string;
  readonly userId: string;
}

describe('Tenancy: orgs, memberships, workspaces (e2e)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and both Redis roles', () => {
    let app: INestApplication;
    let database: ForgeDatabase;
    let hasher: PasswordHasher;
    let transactions: TenantTransactionRunner;
    let workspaces: WorkspaceService;
    let memberships: MembershipService;
    const orgIds: string[] = [];
    const mailboxes = new Set<string>();

    function http(): request.Agent {
      return request(app.getHttpServer() as Server);
    }

    async function signUpAndIn(): Promise<Client> {
      const email = `t27e-${randomUUID()}@example.test`;

      mailboxes.add(email);

      const [user] = await database
        .insert(schema.users)
        .values({ email, emailVerifiedAt: new Date(), passwordHash: await hasher.hash(PASSWORD) })
        .returning({ id: schema.users.id });

      return { ...(await signIn(email)), userId: user!.id };
    }

    /** A *new* client for an account that already exists — a second device, or a second browser. */
    async function signIn(email: string): Promise<{ cookie: string; email: string }> {
      const response = await unsafe(http().post(LOGIN))
        .set('X-Forwarded-For', nextClientAddress())
        .send({ email, password: PASSWORD })
        .expect(200);

      const header = ((response.headers as unknown as Record<string, string[] | undefined>)[
        'set-cookie'
      ] ?? [])[0];

      return { cookie: header!.split(';')[0]!, email };
    }

    /** An organisation created the way a user creates one — through the product's only path. */
    async function createOrg(owner: Client): Promise<string> {
      const response = await unsafe(http().post(ORGS), [owner.cookie])
        .send({ name: 'Acme', slug: `t27e-${randomUUID().slice(0, 8)}` })
        .expect(201);

      const { org } = orgResponseSchema.parse(response.body);

      orgIds.push(org.id);

      return org.id;
    }

    async function defaultWorkspace(orgId: string): Promise<string> {
      const [workspace] = await transactions.runInTenantTransaction(orgId, (tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      );

      return workspace!.id;
    }

    async function addMember(
      orgId: string,
      actor: Client,
      member: Client,
      role: 'owner' | 'admin' | 'member' | 'billing' = 'member',
    ): Promise<void> {
      await transactions.runInTenantScope({ orgId, userId: actor.userId }, () =>
        memberships.add({ invitedBy: actor.userId, orgId, role, userId: member.userId }),
      );
    }

    async function addToWorkspace(
      orgId: string,
      workspaceId: string,
      member: Client,
      role: 'admin' | 'editor' | 'viewer' = 'viewer',
    ): Promise<void> {
      await transactions.runInTenantTransaction(orgId, (tx) =>
        tx
          .insert(schema.workspaceMembers)
          .values({ orgId, role, userId: member.userId, workspaceId }),
      );
    }

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(BREACHED_PASSWORD_PORT)
        .useClass(ScriptedBreachPort)
        .compile();

      app = moduleRef.createNestApplication();
      configureApplication(app);
      await app.init();

      database = app.get<ForgeDatabase>(APP_DATABASE);
      hasher = app.get(PasswordHasher);
      transactions = app.get(TenantTransactionRunner);
      workspaces = app.get(WorkspaceService);
      memberships = app.get(MembershipService);
    }, 60_000);

    afterAll(async () => {
      if (orgIds.length > 0) {
        await database.delete(schema.orgs).where(inArray(schema.orgs.id, orgIds));
      }

      if (mailboxes.size > 0) {
        await database.delete(schema.users).where(inArray(schema.users.email, [...mailboxes]));
      }

      await app?.close();
    });

    describe('POST /orgs', () => {
      it('creates an organisation the caller immediately owns', async () => {
        const owner = await signUpAndIn();
        const orgId = await createOrg(owner);

        const response = await http()
          .get(`${ORGS}/${orgId}`)
          .set('Cookie', owner.cookie)
          .expect(200);

        expect(orgResponseSchema.parse(response.body).org.id).toBe(orgId);
      });

      it('refuses a slug that is already taken', async () => {
        const owner = await signUpAndIn();
        const slug = `t27e-${randomUUID().slice(0, 8)}`;

        const first = await unsafe(http().post(ORGS), [owner.cookie])
          .send({ name: 'Acme', slug })
          .expect(201);

        orgIds.push(orgResponseSchema.parse(first.body).org.id);

        const conflict = await unsafe(http().post(ORGS), [owner.cookie])
          .send({ name: 'Acme again', slug })
          .expect(409);

        expect(conflict.body).toMatchObject({ type: 'https://forge.dev/problems/conflict' });
      });

      it('refuses a caller with no session', async () => {
        await unsafe(http().post(ORGS))
          .send({ name: 'Acme', slug: `t27e-${randomUUID().slice(0, 8)}` })
          .expect(401);
      });
    });

    /**
     * ## `GET /orgs` — the one read that spans tenants
     *
     * Every other route in this suite derives its organisation from an `:orgId` in the path, and
     * row-level security filters on the tenant that derivation produced. This one has no such
     * segment: it runs in the user-scoped transaction ADR 023 introduces, where the `memberships`
     * policy filters on the caller instead. So the assertion that matters is the same one T32
     * makes for every other route, made here by hand because the sweep cannot aim a probe at a
     * route with no parameters.
     */
    describe('GET /orgs', () => {
      it('lists the organisations the caller belongs to, with the role in each', async () => {
        const owner = await signUpAndIn();
        const member = await signUpAndIn();
        const own = await createOrg(owner);
        const joined = await createOrg(member);

        await addMember(own, owner, member, 'admin');

        const response = await http().get(ORGS).set('Cookie', member.cookie).expect(200);
        const listed = orgListResponseSchema.parse(response.body).orgs;

        expect(listed.map((org) => [org.id, org.role]).sort()).toEqual(
          [
            [joined, 'owner'],
            [own, 'admin'],
          ].sort(),
        );
      });

      /**
       * The isolation property, over HTTP. Two accounts, two organisations, and the one route in
       * the API that could conceivably answer with both.
       */
      it('says nothing of an organisation the caller is not in', async () => {
        const owner = await signUpAndIn();
        const stranger = await signUpAndIn();
        const orgId = await createOrg(owner);

        const response = await http().get(ORGS).set('Cookie', stranger.cookie).expect(200);

        expect(response.text).not.toContain(orgId);
        expect(orgListResponseSchema.parse(response.body).orgs).toEqual([]);
      });

      /** A brand-new account. `200` with nothing in it — the create-an-organisation screen. */
      it('answers an account in no organisation with an empty list, not a 404', async () => {
        const response = await http()
          .get(ORGS)
          .set('Cookie', (await signUpAndIn()).cookie)
          .expect(200);

        expect(response.body).toEqual({ orgs: [] });
      });

      it('refuses a caller with no session', async () => {
        await http().get(ORGS).expect(401);
      });

      /**
       * Removal revokes the member's sessions wholesale (§11), so the list is not something a
       * removed collaborator keeps a stale copy of — their next request is a `401` and the one after
       * that, on a fresh session, no longer names the organisation at all.
       */
      it('drops an organisation the caller has been removed from', async () => {
        const owner = await signUpAndIn();
        const member = await signUpAndIn();
        const orgId = await createOrg(owner);

        await addMember(orgId, owner, member);

        const before = await http().get(ORGS).set('Cookie', member.cookie).expect(200);

        expect(orgListResponseSchema.parse(before.body).orgs.map((org) => org.id)).toEqual([orgId]);

        await unsafe(http().delete(`${ORGS}/${orgId}/members/${member.userId}`), [
          owner.cookie,
        ]).expect(200);

        await http().get(ORGS).set('Cookie', member.cookie).expect(401);

        const returning = await signIn(member.email);
        const after = await http().get(ORGS).set('Cookie', returning.cookie).expect(200);

        expect(orgListResponseSchema.parse(after.body).orgs).toEqual([]);
      });
    });

    describe('a stranger to the organisation', () => {
      it('cannot read it, and is told nothing about whether it exists', async () => {
        const owner = await signUpAndIn();
        const stranger = await signUpAndIn();
        const orgId = await createOrg(owner);

        const refused = await http()
          .get(`${ORGS}/${orgId}`)
          .set('Cookie', stranger.cookie)
          .expect(403);
        const unknown = await http()
          .get(`${ORGS}/${randomUUID()}`)
          .set('Cookie', stranger.cookie)
          .expect(403);

        expect(refused.body).toMatchObject({
          type: 'https://forge.dev/problems/permission-denied',
        });
        expect(withoutCorrelation(refused)).toEqual(withoutCorrelation(unknown));
      });
    });

    /**
     * ## Criterion 11's wrong-role case
     *
     * A member of the organisation, with a role in one workspace and none in the other. Both
     * workspaces belong to the same tenant, so RLS shows the request both of them — the refusal is
     * the guard's, and it is the difference between `workspace:read@{first}` being in the resolved
     * set and `workspace:read@{second}` not being.
     */
    describe('an org member of the wrong role', () => {
      it('cannot read a workspace they hold no role in', async () => {
        const owner = await signUpAndIn();
        const member = await signUpAndIn();
        const orgId = await createOrg(owner);
        const first = await defaultWorkspace(orgId);

        const second = await transactions.runInTenantScope({ orgId, userId: owner.userId }, () =>
          workspaces.create({
            actorId: owner.userId,
            name: 'Second',
            orgId,
            ownerId: owner.userId,
          }),
        );

        await addMember(orgId, owner, member);
        await addToWorkspace(orgId, first, member);

        // Their own: allowed, and the role they hold comes back with it.
        const mine = await http()
          .get(`${ORGS}/${orgId}/workspaces/${first}`)
          .set('Cookie', member.cookie)
          .expect(200);

        expect(mine.body).toMatchObject({ workspace: { id: first, role: 'viewer' } });

        // The other one, in the same organisation: refused.
        const refused = await http()
          .get(`${ORGS}/${orgId}/workspaces/${second.id}`)
          .set('Cookie', member.cookie)
          .expect(403);

        expect(refused.body).toMatchObject({
          type: 'https://forge.dev/problems/permission-denied',
        });
      });

      /** And the listing excludes it rather than mentioning it — no count of what they cannot see. */
      it('sees only their own workspace in the listing', async () => {
        const owner = await signUpAndIn();
        const member = await signUpAndIn();
        const orgId = await createOrg(owner);
        const first = await defaultWorkspace(orgId);

        await transactions.runInTenantScope({ orgId, userId: owner.userId }, () =>
          workspaces.create({
            actorId: owner.userId,
            name: 'Second',
            orgId,
            ownerId: owner.userId,
          }),
        );

        await addMember(orgId, owner, member);
        await addToWorkspace(orgId, first, member);

        const response = await http()
          .get(`${ORGS}/${orgId}/workspaces`)
          .set('Cookie', member.cookie)
          .expect(200);

        const listed = workspaceListResponseSchema.parse(response.body).workspaces;

        expect(listed.map((workspace) => workspace.id)).toEqual([first]);
      });

      it('cannot change anybody’s role', async () => {
        const owner = await signUpAndIn();
        const member = await signUpAndIn();
        const orgId = await createOrg(owner);

        await addMember(orgId, owner, member);

        await unsafe(http().patch(`${ORGS}/${orgId}/members/${owner.userId}`), [member.cookie])
          .send({ role: 'member' })
          .expect(403);
      });
    });

    /**
     * ## The second-client revocation proof
     *
     * The removed member is a **live client** that signed in before the removal and is still holding
     * its cookie — not a token fabricated for the assertion. It is proved to work first, so the
     * refusal afterwards cannot be a session that was never good.
     */
    describe('removing a member', () => {
      it('kills the session the removed member is already holding', async () => {
        const owner = await signUpAndIn();
        const member = await signUpAndIn();
        const orgId = await createOrg(owner);

        await addMember(orgId, owner, member);

        // The second client, working. This is the state a collaborator is in when they are removed:
        // signed in, on a device nobody is holding a token for.
        await http().get(`${ORGS}/${orgId}`).set('Cookie', member.cookie).expect(200);
        await http().get('/api/v1/auth/sessions').set('Cookie', member.cookie).expect(200);

        const removal = await unsafe(http().delete(`${ORGS}/${orgId}/members/${member.userId}`), [
          owner.cookie,
        ]).expect(200);

        expect(removal.body).toEqual({ status: MEMBER_REMOVED });

        // The very next request from that same client. `401`, not `403`: the session itself is gone,
        // which is §11's "revoked wholesale on member removal" — cache invalidation alone would have
        // left this a `403` and the account still signed in.
        await http().get(`${ORGS}/${orgId}`).set('Cookie', member.cookie).expect(401);
        await http().get('/api/v1/auth/sessions').set('Cookie', member.cookie).expect(401);
      });

      /**
       * The other half. A session revoked but a permission set left cached would let the removed
       * member back in the moment they signed in again — "session-only leaves a stale permission set
       * for their next login". So they sign in again, with a brand-new session, and are refused.
       */
      it('leaves nothing cached for them to use on their next sign-in', async () => {
        const owner = await signUpAndIn();
        const member = await signUpAndIn();
        const orgId = await createOrg(owner);

        await addMember(orgId, owner, member);
        await http().get(`${ORGS}/${orgId}`).set('Cookie', member.cookie).expect(200);

        await unsafe(http().delete(`${ORGS}/${orgId}/members/${member.userId}`), [
          owner.cookie,
        ]).expect(200);

        const returning = await signIn(member.email);

        await http().get(`${ORGS}/${orgId}`).set('Cookie', returning.cookie).expect(403);
      });

      /** Every device, not the one that happened to make a request. */
      it('revokes every device the removed member was signed in on', async () => {
        const owner = await signUpAndIn();
        const member = await signUpAndIn();
        const orgId = await createOrg(owner);
        const phone = await signIn(member.email);

        await addMember(orgId, owner, member);

        await http().get(`${ORGS}/${orgId}`).set('Cookie', member.cookie).expect(200);
        await http().get(`${ORGS}/${orgId}`).set('Cookie', phone.cookie).expect(200);

        await unsafe(http().delete(`${ORGS}/${orgId}/members/${member.userId}`), [
          owner.cookie,
        ]).expect(200);

        await http().get(`${ORGS}/${orgId}`).set('Cookie', member.cookie).expect(401);
        await http().get(`${ORGS}/${orgId}`).set('Cookie', phone.cookie).expect(401);
      });

      /** The remover keeps working — the revocation is the target's, not the whole organisation's. */
      it('leaves the remover, and everybody else, signed in', async () => {
        const owner = await signUpAndIn();
        const member = await signUpAndIn();
        const bystander = await signUpAndIn();
        const orgId = await createOrg(owner);

        await addMember(orgId, owner, member);
        await addMember(orgId, owner, bystander);

        await unsafe(http().delete(`${ORGS}/${orgId}/members/${member.userId}`), [
          owner.cookie,
        ]).expect(200);

        await http().get(`${ORGS}/${orgId}`).set('Cookie', owner.cookie).expect(200);
        await http().get(`${ORGS}/${orgId}`).set('Cookie', bystander.cookie).expect(200);
      });

      it('drops them from the member list', async () => {
        const owner = await signUpAndIn();
        const member = await signUpAndIn();
        const orgId = await createOrg(owner);

        await addMember(orgId, owner, member);

        await unsafe(http().delete(`${ORGS}/${orgId}/members/${member.userId}`), [
          owner.cookie,
        ]).expect(200);

        const response = await http()
          .get(`${ORGS}/${orgId}/members`)
          .set('Cookie', owner.cookie)
          .expect(200);

        const listed = orgMemberListResponseSchema.parse(response.body).members;

        expect(listed.map((entry) => entry.userId)).toEqual([owner.userId]);
      });

      it('refuses to remove the last owner, and the organisation survives', async () => {
        const owner = await signUpAndIn();
        const orgId = await createOrg(owner);

        const refused = await unsafe(http().delete(`${ORGS}/${orgId}/members/${owner.userId}`), [
          owner.cookie,
        ]).expect(409);

        expect(refused.body).toMatchObject({ type: 'https://forge.dev/problems/conflict' });
        await http().get(`${ORGS}/${orgId}`).set('Cookie', owner.cookie).expect(200);
      });
    });

    /**
     * ## The cache invalidation, seen from outside
     *
     * A role change has to take effect on the target's next request, not when a TTL runs out. The
     * member's set is deliberately warmed first — by a successful request — so that a cache that was
     * merely left to expire would still be holding the old answer when the second request arrives.
     */
    describe('changing a member’s role', () => {
      it('takes effect on the member’s very next request', async () => {
        const owner = await signUpAndIn();
        const member = await signUpAndIn();
        const orgId = await createOrg(owner);

        await addMember(orgId, owner, member);

        // Warm: they can read the org, and cannot read the member list.
        await http().get(`${ORGS}/${orgId}`).set('Cookie', member.cookie).expect(200);
        await http().get(`${ORGS}/${orgId}/members`).set('Cookie', member.cookie).expect(200);

        // `member` holds `org:members.read` but not `org:settings.update`. Promote to admin and the
        // difference has to be immediate.
        await unsafe(http().patch(`${ORGS}/${orgId}/members/${member.userId}`), [owner.cookie])
          .send({ role: 'admin' })
          .expect(200);

        const listed = orgMemberListResponseSchema.parse(
          (await http().get(`${ORGS}/${orgId}/members`).set('Cookie', owner.cookie).expect(200))
            .body,
        ).members;

        expect(listed.find((entry) => entry.userId === member.userId)?.role).toBe('admin');
      });

      /**
       * The direction that matters. A demoted member must lose the permission at once — a cache
       * that only expired would leave them holding it for as long as the backstop lasts.
       */
      it('withdraws a permission at once when the role goes down', async () => {
        const owner = await signUpAndIn();
        const admin = await signUpAndIn();
        const orgId = await createOrg(owner);

        await addMember(orgId, owner, admin, 'admin');

        // Warm the admin's set with a request that uses a permission `member` does not have.
        await unsafe(http().patch(`${ORGS}/${orgId}/members/${admin.userId}`), [admin.cookie])
          .send({ role: 'admin' })
          .expect(200);

        await unsafe(http().patch(`${ORGS}/${orgId}/members/${admin.userId}`), [owner.cookie])
          .send({ role: 'member' })
          .expect(200);

        // The same request, from the same client, immediately afterwards.
        await unsafe(http().patch(`${ORGS}/${orgId}/members/${admin.userId}`), [admin.cookie])
          .send({ role: 'admin' })
          .expect(403);
      });

      /** They keep their session: a demotion is not a sign-out, only a smaller permission set. */
      it('does not sign the member out', async () => {
        const owner = await signUpAndIn();
        const member = await signUpAndIn();
        const orgId = await createOrg(owner);

        await addMember(orgId, owner, member, 'admin');

        await unsafe(http().patch(`${ORGS}/${orgId}/members/${member.userId}`), [owner.cookie])
          .send({ role: 'member' })
          .expect(200);

        await http().get('/api/v1/auth/sessions').set('Cookie', member.cookie).expect(200);
        await http().get(`${ORGS}/${orgId}`).set('Cookie', member.cookie).expect(200);
      });

      /**
       * §11's layering, at the layer the guard cannot reach. `ORG_ROLE_PERMISSIONS` gives `admin`
       * the `org:members.role-change` permission, so the guard admits this request — and the service
       * refuses it, because the role being conferred is above the actor's own.
       */
      it('refuses an admin promoting themselves to owner, after the guard admitted them', async () => {
        const owner = await signUpAndIn();
        const admin = await signUpAndIn();
        const orgId = await createOrg(owner);

        await addMember(orgId, owner, admin, 'admin');

        // The guard admits them for a change they *are* allowed to make.
        await unsafe(http().patch(`${ORGS}/${orgId}/members/${admin.userId}`), [admin.cookie])
          .send({ role: 'member' })
          .expect(200);

        await addMember(orgId, owner, await signUpAndIn(), 'member');

        const refused = await unsafe(http().patch(`${ORGS}/${orgId}/members/${admin.userId}`), [
          owner.cookie,
        ])
          .send({ role: 'admin' })
          .expect(200);

        expect(refused.body).toMatchObject({ role: 'admin' });

        const escalation = await unsafe(http().patch(`${ORGS}/${orgId}/members/${admin.userId}`), [
          admin.cookie,
        ])
          .send({ role: 'owner' })
          .expect(403);

        expect(escalation.body).toMatchObject({ type: 'https://forge.dev/problems/forbidden' });
      });
    });

    /**
     * The audit trail, as §11 and the standing rule require: every mutation writes one, in the same
     * transaction as the change it records.
     */
    describe('the audit trail', () => {
      it('records the creation, the role change and the removal', async () => {
        const owner = await signUpAndIn();
        const member = await signUpAndIn();
        const orgId = await createOrg(owner);

        await addMember(orgId, owner, member);
        await unsafe(http().patch(`${ORGS}/${orgId}/members/${member.userId}`), [owner.cookie])
          .send({ role: 'admin' })
          .expect(200);
        await unsafe(http().delete(`${ORGS}/${orgId}/members/${member.userId}`), [
          owner.cookie,
        ]).expect(200);

        const entries = await transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .select({ action: schema.auditLog.action, target: schema.auditLog.target })
            .from(schema.auditLog)
            .where(eq(schema.auditLog.orgId, orgId)),
        );
        const actions = entries
          .filter((entry) => entry.target === member.userId)
          .map((entry) => entry.action)
          .sort();

        expect(actions).toEqual([
          'membership.created',
          'membership.removed',
          'membership.role-changed',
        ]);
      });
    });
  });
});

function withoutCorrelation(response: request.Response): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(response.body as Record<string, unknown>).filter(
      ([member]) => member !== 'requestId' && member !== 'instance',
    ),
  );
}
