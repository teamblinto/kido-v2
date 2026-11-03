import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  IDEMPOTENCY_KEY_HEADER,
  INVITATION_ACCEPTED,
  INVITATION_SENT,
  acceptInvitationResponseSchema,
  invitationAcceptedResponseSchema,
  orgResponseSchema,
  problemDetailSchema,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { and, eq, inArray } from 'drizzle-orm';
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
import { InMemoryMailer } from '../src/modules/mail/in-memory.mailer';
import { MAILER } from '../src/modules/mail/mailer.port';
import { CLOCK } from '../src/common/clock/clock.port';
import { FakeClock } from '../src/common/clock/fake-clock';
import { unsafe } from './support/csrf-client';
import { awaitMail } from './support/mail';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  // Off by default under test — one outbox table, one queue Redis, many parallel workers. This
  // suite reads mail, so it relays and drains under the outbox suite lock (spec 006).
  process.env.RUN_PROFILES = 'api,agent,events,cron';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.LOGIN_THROTTLE_ACCOUNT_BURST = '100';
  process.env.LOGIN_THROTTLE_IP_BURST = '4000';
});

/** The instant every test starts at; the suite moves it where the mail lane's hour matters. */
const START = '2026-09-14T09:00:00.000Z';
const HOUR_MS = 60 * 60 * 1_000;

/**
 * The wait for the outbox suite lock is inside `beforeAll`, and it is a wait behind every other
 * suite that relays — `password.e2e-spec.ts`'s measurement among them — so the hook's budget is
 * the serialised suites', not this one's boot.
 */
const LOCKED_BOOT_TIMEOUT_MS = 600_000;

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const LOGIN = '/api/v1/auth/login';
const ORGS = '/api/v1/orgs';
const PASSWORD = 'thermos-quibble-tundra-vellum';

/** `198.34/16`, distinct from the ranges the other e2e suites claim against the same Redis. */
const RUN = randomInt(0, 256);
let issuedAddresses = 0;

function nextClientAddress(): string {
  issuedAddresses += 1;

  const slot = (RUN * 256 + issuedAddresses) % 65_536;

  return `198.34.${Math.floor(slot / 256)}.${slot % 256}`;
}

class ScriptedBreachPort implements BreachedPasswordPort {
  isBreached(_password: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}

interface Client {
  readonly cookie: string;
  readonly email: string;
  readonly userId: string;
}

/**
 * Invitations end to end (T29, success criterion 10).
 *
 * This slice is `IdempotencyInterceptor`'s first real consumer and the interceptor is deliberately
 * **not** mocked here: the application is built from `AppModule`, so the `APP_INTERCEPTOR` under test
 * is the one production registers, and the replay record is a real entry on the real session Redis.
 * A mocked interceptor would prove that this suite can stub a class.
 */
describe('Invitations (e2e)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and both Redis roles', () => {
    let app: INestApplication;
    let database: ForgeDatabase;
    let hasher: PasswordHasher;
    let transactions: TenantTransactionRunner;
    let mailer: InMemoryMailer;
    let clock: FakeClock;
    let suiteLock: { release: () => Promise<void> } | undefined;
    const orgIds: string[] = [];
    const mailboxes = new Set<string>();

    function http(): request.Agent {
      return request(app.getHttpServer() as Server);
    }

    function invitationsUrl(orgId: string): string {
      return `${ORGS}/${orgId}/invitations`;
    }

    async function signUpAndIn(): Promise<Client> {
      const email = `t29e-${randomUUID()}@example.test`;

      mailboxes.add(email);

      const [user] = await database
        .insert(schema.users)
        .values({ email, emailVerifiedAt: new Date(), passwordHash: await hasher.hash(PASSWORD) })
        .returning({ id: schema.users.id });

      return { ...(await signIn(email)), userId: user!.id };
    }

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

    async function createOrg(owner: Client): Promise<string> {
      const response = await unsafe(http().post(ORGS), [owner.cookie])
        .send({ name: 'Acme', slug: `t29e-${randomUUID().slice(0, 8)}` })
        .expect(201);

      const { org } = orgResponseSchema.parse(response.body);

      orgIds.push(org.id);

      return org.id;
    }

    /** One invitation request, with or without a key — the shape every case here is built from. */
    function invite(
      orgId: string,
      actor: Client,
      body: { email: string; role?: string },
      key?: string,
    ): request.Test {
      const test = unsafe(http().post(invitationsUrl(orgId)), [actor.cookie]);

      if (key !== undefined) {
        test.set(IDEMPOTENCY_KEY_HEADER, key);
      }

      return test.send({ role: 'member', ...body });
    }

    function accept(orgId: string, actor: Client, token: string): request.Test {
      return unsafe(http().post(`${invitationsUrl(orgId)}/accept`), [actor.cookie]).send({ token });
    }

    /**
     * The raw token from the newest invitation mail sent to one address — the only place it
     * exists. Waited for, since the mail arrives through the queue (spec 006).
     */
    async function mailedToken(to: string): Promise<string> {
      const wanted = to.toLowerCase();
      const message = await awaitMail(
        mailer,
        (candidate) => candidate.template === 'invitation' && candidate.to.toLowerCase() === wanted,
      );
      const found = /[?&]token=([^&"'\s]+)/.exec(message.text);

      return found?.[1] ?? expect.unreachable(`no invitation mail reached ${to}`);
    }

    async function invitationRows(orgId: string): Promise<{ email: string; id: string }[]> {
      return transactions.runInTenantTransaction(orgId, (tx) =>
        tx
          .select({ email: schema.invitations.email, id: schema.invitations.id })
          .from(schema.invitations),
      );
    }

    /**
     * Withdraw an invitation behind the API's back.
     *
     * This is the lever that makes the replay proof unambiguous. `invitations_org_id_email_open_key`
     * already makes a second invite to the same address resolve to the first, so a replay that
     * merely returned the same body could be that index rather than the interceptor. Revoking the
     * row removes the index from the picture: a *re-executed* handler would now insert a new
     * invitation with a new id, so an identical response can only have come from the record T28
     * wrote.
     */
    async function revoke(orgId: string, id: string): Promise<void> {
      await transactions.runInTenantTransaction(orgId, (tx) =>
        tx
          .update(schema.invitations)
          .set({ revokedAt: new Date() })
          .where(eq(schema.invitations.id, id)),
      );
    }

    beforeAll(async () => {
      mailer = new InMemoryMailer();
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
      // A clock the suite can move: the mail lane collapses one template to one address within an
      // hour (spec 006 §10), and one case below invites the same address twice.
      clock = new FakeClock(START);

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(BREACHED_PASSWORD_PORT)
        .useClass(ScriptedBreachPort)
        .overrideProvider(MAILER)
        .useValue(mailer)
        .overrideProvider(CLOCK)
        .useValue(clock)
        .compile();

      app = moduleRef.createNestApplication();
      configureApplication(app);
      await app.init();

      database = app.get<ForgeDatabase>(APP_DATABASE);
      hasher = app.get(PasswordHasher);
      transactions = app.get(TenantTransactionRunner);
    }, LOCKED_BOOT_TIMEOUT_MS);

    afterAll(async () => {
      if (orgIds.length > 0) {
        await database.delete(schema.orgs).where(inArray(schema.orgs.id, orgIds));
      }

      if (mailboxes.size > 0) {
        await database.delete(schema.users).where(inArray(schema.users.email, [...mailboxes]));
      }

      await app?.close();
      await suiteLock?.release();
    });

    describe('POST /orgs/:orgId/invitations', () => {
      it('accepts an invitation from a caller holding org:members.invite', async () => {
        const owner = await signUpAndIn();
        const orgId = await createOrg(owner);

        const response = await invite(orgId, owner, { email: 'ada@example.test' }).expect(202);

        expect(invitationAcceptedResponseSchema.parse(response.body).status).toBe(INVITATION_SENT);
      });

      /** Criterion 11's shape, on this route: a member of the wrong role cannot invite. */
      it('refuses a plain member with permission-denied', async () => {
        const owner = await signUpAndIn();
        const member = await signUpAndIn();
        const orgId = await createOrg(owner);

        await invite(orgId, owner, { email: member.email }).expect(202);
        await accept(orgId, member, await mailedToken(member.email)).expect(201);

        const response = await invite(orgId, member, { email: 'ada@example.test' }).expect(403);

        expect(problemDetailSchema.parse(response.body).type).toContain('permission-denied');
      });

      it('refuses a caller with no membership at all', async () => {
        const owner = await signUpAndIn();
        const stranger = await signUpAndIn();
        const orgId = await createOrg(owner);

        await invite(orgId, stranger, { email: 'ada@example.test' }).expect(403);
      });
    });

    /**
     * The T28 proof, over HTTP, against the interceptor the application actually registers.
     */
    describe('a repeated Idempotency-Key', () => {
      it('returns the original response rather than inviting a second time', async () => {
        const owner = await signUpAndIn();
        const orgId = await createOrg(owner);
        const key = randomUUID();
        const email = `t29e-${randomUUID()}@example.test`;

        const first = await invite(orgId, owner, { email }, key).expect(202);
        const original = invitationAcceptedResponseSchema.parse(first.body);

        // Take the address-level index out of the picture entirely: with the row revoked, a handler
        // that ran again would insert a fresh invitation and answer with a different id.
        await revoke(orgId, original.id);

        const replay = await invite(orgId, owner, { email }, key).expect(202);

        expect(replay.body).toStrictEqual(first.body);
        expect(await invitationRows(orgId)).toHaveLength(1);
      });

      /**
       * The control for the test above. Same address, same body, *different* key — and now the
       * handler does run, which is what proves the identical response above was the interceptor's
       * doing and not something about this endpoint being naturally idempotent.
       */
      it('is what suppressed the second execution, because a different key does not', async () => {
        const owner = await signUpAndIn();
        const orgId = await createOrg(owner);
        const email = `t29e-${randomUUID()}@example.test`;

        const first = await invite(orgId, owner, { email }, randomUUID()).expect(202);
        const original = invitationAcceptedResponseSchema.parse(first.body);

        await revoke(orgId, original.id);

        const second = await invite(orgId, owner, { email }, randomUUID()).expect(202);

        expect(invitationAcceptedResponseSchema.parse(second.body).id).not.toBe(original.id);
        expect(await invitationRows(orgId)).toHaveLength(2);
      });

      /**
       * §14's second answer. The same key with a different body is a client bug, and serving the
       * first response would hide it behind a success — so it is a `409` with its own slug rather
       * than a replay of an invitation for somebody else's address.
       */
      it('is a 409 with a stable slug when the body differs', async () => {
        const owner = await signUpAndIn();
        const orgId = await createOrg(owner);
        const key = randomUUID();

        await invite(orgId, owner, { email: 'ada@example.test' }, key).expect(202);

        const response = await invite(orgId, owner, { email: 'grace@example.test' }, key).expect(
          409,
        );

        expect(problemDetailSchema.parse(response.body).type).toContain('idempotency-key-reused');
        expect(await invitationRows(orgId)).toHaveLength(1);
      });

      /**
       * The replay slot is namespaced by principal. Without that, an administrator who learned a
       * colleague's key — and could reproduce the request that went with it — would be handed the
       * colleague's response instead of performing their own invitation.
       */
      it('does not let one admin replay another admin’s slot', async () => {
        const owner = await signUpAndIn();
        const admin = await signUpAndIn();
        const orgId = await createOrg(owner);
        const key = randomUUID();
        const email = `t29e-${randomUUID()}@example.test`;

        await invite(orgId, owner, { email: admin.email, role: 'admin' }).expect(202);
        await accept(orgId, admin, await mailedToken(admin.email)).expect(201);

        const byOwner = await invite(orgId, owner, { email }, key).expect(202);

        await revoke(orgId, invitationAcceptedResponseSchema.parse(byOwner.body).id);

        const byAdmin = await invite(orgId, admin, { email }, key).expect(202);

        expect(invitationAcceptedResponseSchema.parse(byAdmin.body).id).not.toBe(
          invitationAcceptedResponseSchema.parse(byOwner.body).id,
        );
      });
    });

    describe('POST /orgs/:orgId/invitations/accept', () => {
      it('makes the invitee a member in the role the invitation named', async () => {
        const owner = await signUpAndIn();
        const invitee = await signUpAndIn();
        const orgId = await createOrg(owner);

        await invite(orgId, owner, { email: invitee.email, role: 'admin' }).expect(202);

        const response = await accept(orgId, invitee, await mailedToken(invitee.email)).expect(201);

        expect(acceptInvitationResponseSchema.parse(response.body)).toStrictEqual({
          orgId,
          role: 'admin',
          status: INVITATION_ACCEPTED,
        });
      });

      /**
       * Criterion 10's "single use", proved the way it fails in the wild: the same link clicked
       * twice. The membership is not created a second time and the second click is refused with the
       * slug that tells the reader what happened.
       */
      it('rejects a replayed token', async () => {
        const owner = await signUpAndIn();
        const invitee = await signUpAndIn();
        const orgId = await createOrg(owner);

        await invite(orgId, owner, { email: invitee.email }).expect(202);

        const token = await mailedToken(invitee.email);

        await accept(orgId, invitee, token).expect(201);

        const replay = await accept(orgId, invitee, token).expect(400);

        expect(problemDetailSchema.parse(replay.body).type).toContain('token-already-used');

        const members = await transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .select({ userId: schema.memberships.userId })
            .from(schema.memberships)
            .where(
              and(
                eq(schema.memberships.orgId, orgId),
                eq(schema.memberships.userId, invitee.userId),
              ),
            ),
        );

        expect(members).toHaveLength(1);
      });

      it('rejects a token nobody minted', async () => {
        const owner = await signUpAndIn();
        const stranger = await signUpAndIn();
        const orgId = await createOrg(owner);

        const response = await accept(orgId, stranger, 'a-token-nobody-ever-minted').expect(400);

        expect(problemDetailSchema.parse(response.body).type).toContain('token-invalid');
      });

      /**
       * A forwarded link is not a membership. Without this, the first authenticated person to open
       * somebody else's invitation joins the organisation and the audit row names them as invited.
       */
      it('refuses a caller who is not the invited address, and leaves the link usable', async () => {
        const owner = await signUpAndIn();
        const invitee = await signUpAndIn();
        const bystander = await signUpAndIn();
        const orgId = await createOrg(owner);

        await invite(orgId, owner, { email: invitee.email }).expect(202);

        const token = await mailedToken(invitee.email);

        await accept(orgId, bystander, token).expect(403);

        // The refusal rolled the claim back, so the person it was actually sent to can still use it.
        await accept(orgId, invitee, token).expect(201);
      });
    });

    /**
     * Criterion 10's third clause. The response must not let an org admin discover whether an
     * arbitrary address has a Forge account — so the three cases that a naive implementation
     * distinguishes have to be indistinguishable from the outside.
     */
    describe('inviting an address that is already a member', () => {
      it('answers exactly as it does for an address with no account at all', async () => {
        const owner = await signUpAndIn();
        const member = await signUpAndIn();
        const orgId = await createOrg(owner);

        await invite(orgId, owner, { email: member.email }).expect(202);
        await accept(orgId, member, await mailedToken(member.email)).expect(201);

        const again = await invite(orgId, owner, { email: member.email }).expect(202);
        const stranger = await invite(orgId, owner, {
          email: `t29e-${randomUUID()}@example.test`,
        }).expect(202);

        const asMember = invitationAcceptedResponseSchema.parse(again.body);
        const asStranger = invitationAcceptedResponseSchema.parse(stranger.body);

        expect(Object.keys(asMember).sort()).toStrictEqual(Object.keys(asStranger).sort());
        expect(asMember.status).toBe(asStranger.status);
        expect(again.status).toBe(stranger.status);
      });

      /** An address that has an account but is not a member is the third case, and matches too. */
      it('answers exactly as it does for an address that has an account but no membership', async () => {
        const owner = await signUpAndIn();
        const outsider = await signUpAndIn();
        const orgId = await createOrg(owner);

        const known = await invite(orgId, owner, { email: outsider.email }).expect(202);
        const unknown = await invite(orgId, owner, {
          email: `t29e-${randomUUID()}@example.test`,
        }).expect(202);

        expect(
          Object.keys(invitationAcceptedResponseSchema.parse(known.body)).sort(),
        ).toStrictEqual(Object.keys(invitationAcceptedResponseSchema.parse(unknown.body)).sort());
      });

      /**
       * And accepting one is a no-op rather than a unique-key violation. Because `invite` never
       * looks in `users` — which is *why* it cannot be an oracle — an existing member can genuinely
       * be issued a link, and clicking it must not answer 500.
       */
      it('lets the existing member click the link without a second membership', async () => {
        const owner = await signUpAndIn();
        const member = await signUpAndIn();
        const orgId = await createOrg(owner);

        await invite(orgId, owner, { email: member.email }).expect(202);
        await accept(orgId, member, await mailedToken(member.email)).expect(201);

        // Past the hour, or the second mail is the first one's duplicate and is never sent; and
        // the first link out of the fake, or the wait below answers with it.
        clock.advance(HOUR_MS);
        mailer.clear();
        await invite(orgId, owner, { email: member.email, role: 'admin' }).expect(202);
        await accept(orgId, member, await mailedToken(member.email)).expect(201);

        const rows = await transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .select({ role: schema.memberships.role })
            .from(schema.memberships)
            .where(
              and(
                eq(schema.memberships.orgId, orgId),
                eq(schema.memberships.userId, member.userId),
              ),
            ),
        );

        // One row, and still the role they joined with: an invitation is not a promotion.
        expect(rows).toHaveLength(1);
        expect(rows[0]?.role).toBe('member');
      });
    });
  });
});
