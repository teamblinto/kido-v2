import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SESSION_REVOKED, sessionListResponseSchema } from '@repo/contracts';
import { schema } from '@repo/db';
import { inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { SESSION_REDIS } from '../src/common/redis/redis.constants';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../src/modules/identity/password/breached-password.port';
import { PasswordHasher } from '../src/modules/identity/password/hasher';
import { sessionIndexKey, sessionKey } from '../src/modules/identity/services/session.service';
import { unsafe } from './support/csrf-client';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  // Argon2id at the local floor: this suite signs in many times and hashes nothing it asserts on.
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  // Loose, because every request here arrives from the same runner and none of these tests is
  // about the throttle.
  process.env.LOGIN_THROTTLE_ACCOUNT_BURST = '100';
  process.env.LOGIN_THROTTLE_IP_BURST = '4000';
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const LIST = '/api/v1/auth/sessions';
const LOGIN = '/api/v1/auth/login';
const PASSWORD = 'thermos-quibble-tundra-vellum';

/** `198.29/16`, distinct from the ranges the other e2e suites claim against the same Redis. */
const RUN = randomInt(0, 256);
let issuedAddresses = 0;

function nextClientAddress(): string {
  issuedAddresses += 1;

  const slot = (RUN * 256 + issuedAddresses) % 65_536;

  return `198.29.${Math.floor(slot / 256)}.${slot % 256}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** The adapter fails open on a network error (ADR 008), so it is driven rather than reached. */
class ScriptedBreachPort implements BreachedPasswordPort {
  isBreached(_password: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}

interface SignedIn {
  /** `name=value`, ready for a `Cookie` header. */
  readonly cookie: string;
  readonly token: string;
}

describe('Sessions list and revocation (e2e)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and the session Redis role', () => {
    let app: INestApplication;
    let database: ForgeDatabase;
    let hasher: PasswordHasher;
    let store: Redis;
    const created: string[] = [];
    const mailboxes = new Set<string>();

    function http(): request.Agent {
      return request(app.getHttpServer() as Server);
    }

    function mailbox(): string {
      const address = `t18-${randomUUID()}@example.test`;

      mailboxes.add(address);

      return address;
    }

    /** An account put there directly: this suite is about sessions, not about signing up. */
    async function seed(): Promise<string> {
      const email = mailbox();
      const [user] = await database
        .insert(schema.users)
        .values({ email, emailVerifiedAt: new Date(), passwordHash: await hasher.hash(PASSWORD) })
        .returning({ id: schema.users.id });

      created.push(user!.id);

      return email;
    }

    /**
     * Sign in through the real route, so the session under test is one the product made — with the
     * device fields `LoginService` records and the index entry T15 writes.
     */
    async function signIn(email: string, userAgent = 'Mozilla/5.0 (Macintosh)'): Promise<SignedIn> {
      const response = await unsafe(http().post(LOGIN))
        .set('User-Agent', userAgent)
        .set('X-Forwarded-For', nextClientAddress())
        .send({ email, password: PASSWORD })
        .expect(200);
      const header = ((response.headers as unknown as Record<string, string[] | undefined>)[
        'set-cookie'
      ] ?? [])[0];

      const cookie = header!.split(';')[0]!;

      return { cookie, token: cookie.slice(cookie.indexOf('=') + 1) };
    }

    function list(caller: SignedIn): request.Test {
      return http().get(LIST).set('Cookie', caller.cookie);
    }

    function revoke(caller: SignedIn, id: string): request.Test {
      return unsafe(http().delete(`${LIST}/${id}`), [caller.cookie]);
    }

    async function listed(caller: SignedIn) {
      const response = await list(caller).expect(200);

      return sessionListResponseSchema.parse(response.body).sessions;
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
      store = app.get<Redis>(SESSION_REDIS);
    }, 60_000);

    afterAll(async () => {
      if (created.length > 0) {
        await store.del(...created.map((id) => sessionIndexKey(id)));
        await database.delete(schema.users).where(inArray(schema.users.email, [...mailboxes]));
      }

      await app?.close();
    });

    describe('GET /auth/sessions', () => {
      it('lists the device, address, creation and last-seen of a signed-in device', async () => {
        const caller = await signIn(await seed());
        const [session] = await listed(caller);

        expect(session!.userAgent).toBe('Mozilla/5.0 (Macintosh)');
        expect(session!.fingerprint).toMatch(/^[0-9a-f]{32}$/);
        expect(session!.ip).toMatch(/^198\.29\./);
        expect(Date.parse(session!.createdAt)).not.toBeNaN();
        expect(Date.parse(session!.lastSeenAt)).not.toBeNaN();
      });

      it('lists every device the caller is signed in on', async () => {
        const email = await seed();
        const caller = await signIn(email, 'a laptop');

        await signIn(email, 'a phone');
        await signIn(email, 'a tablet');

        const sessions = await listed(caller);

        expect(sessions).toHaveLength(3);
        expect(sessions.map((session) => session.userAgent).sort()).toEqual([
          'a laptop',
          'a phone',
          'a tablet',
        ]);
      });

      /**
       * Criterion 6's "the caller's own". Two accounts, each holding a session, and neither list
       * contains the other's — asserted from the wire rather than from the store, because the
       * store is what our own code just wrote.
       */
      it('never contains another account’s session', async () => {
        const mine = await signIn(await seed(), 'my laptop');
        const theirs = await signIn(await seed(), 'their laptop');

        const [ours] = await listed(mine);
        const [others] = await listed(theirs);

        await expect(listed(mine)).resolves.toHaveLength(1);
        expect(ours!.userAgent).toBe('my laptop');
        expect(others!.userAgent).toBe('their laptop');
        expect(ours!.id).not.toBe(others!.id);
      });

      /**
       * The standing rule for this task. Neither the token in the caller's own cookie nor the hash
       * it is stored under may appear in a response that enumerates sessions.
       */
      it('returns neither a session token nor its hash', async () => {
        const caller = await signIn(await seed());

        await signIn(await seed());

        const response = await list(caller).expect(200);

        expect(response.text).not.toContain(caller.token);
        expect(response.text).not.toContain(sha256(caller.token));
      });

      it('refuses a caller with no session at all', async () => {
        await http().get(LIST).expect(401);
      });
    });

    describe('DELETE /auth/sessions/:id', () => {
      /**
       * Criterion 6's "within one request", proved from the revoked client rather than from Redis.
       *
       * The second device is authenticated *before* the revocation, so the 401 afterwards cannot
       * be a session that was never good. There is no waiting, no second call and no TTL in
       * between: the request that follows the revoke is the one that is refused.
       */
      it('invalidates the revoked session on its very next request', async () => {
        const email = await seed();
        const caller = await signIn(email, 'my laptop');
        const other = await signIn(email, 'a phone');

        await list(other).expect(200);

        const target = (await listed(caller)).find((session) => session.userAgent === 'a phone');

        const response = await revoke(caller, target!.id).expect(200);

        expect(response.body).toEqual({ status: SESSION_REVOKED });
        await list(other).expect(401);
      });

      /** And the key is gone, not merely unreachable — the store holds nothing to expire later. */
      it('deletes the session rather than leaving it to a TTL', async () => {
        const email = await seed();
        const caller = await signIn(email, 'my laptop');
        const other = await signIn(email, 'a phone');
        const target = (await listed(caller)).find((session) => session.userAgent === 'a phone');

        await revoke(caller, target!.id).expect(200);

        await expect(store.exists(sessionKey(sha256(other.token)))).resolves.toBe(0);
      });

      it('leaves the caller’s other devices signed in', async () => {
        const email = await seed();
        const caller = await signIn(email, 'my laptop');
        const other = await signIn(email, 'a phone');
        const target = (await listed(caller)).find((session) => session.userAgent === 'a phone');

        await revoke(caller, target!.id).expect(200);

        await list(caller).expect(200);
        expect(other.token).not.toBe(caller.token);
        await expect(listed(caller)).resolves.toHaveLength(1);
      });

      it('drops the revoked device from the list', async () => {
        const email = await seed();
        const caller = await signIn(email, 'my laptop');

        await signIn(email, 'a phone');

        const target = (await listed(caller)).find((session) => session.userAgent === 'a phone');

        await revoke(caller, target!.id).expect(200);

        const remaining = await listed(caller);

        expect(remaining.map((session) => session.userAgent)).toEqual(['my laptop']);
      });

      /**
       * **The cross-user proof.** One account asks to revoke a session that belongs to another, by
       * an id it genuinely holds — and is told the session does not exist.
       *
       * `404` rather than `403`, and the difference is not cosmetic: a `403` states that the id is
       * real, so anybody with an account could walk ids and learn which ones name somebody's live
       * session. The victim's session is still authenticated afterwards, which is the other half —
       * a refusal that had nonetheless revoked would be worse than one that said too much.
       */
      it('answers 404, never 403, for a session belonging to another account', async () => {
        const attacker = await signIn(await seed(), 'an attacker');
        const victim = await signIn(await seed(), 'a victim');
        const [theirs] = await listed(victim);

        const response = await revoke(attacker, theirs!.id).expect(404);

        expect(response.status).not.toBe(403);
        expect(response.body).toMatchObject({
          status: 404,
          type: 'https://forge.dev/problems/not-found',
        });

        await list(victim).expect(200);
      });

      /**
       * And the same answer, byte for byte apart from the correlation id, for an id nobody was ever
       * issued. If the two differed at all — in status, in detail, in shape — the difference would
       * be the oracle, whatever the status line said.
       */
      it('answers an unknown id exactly as it answers another account’s', async () => {
        const attacker = await signIn(await seed(), 'an attacker');
        const victim = await signIn(await seed(), 'a victim');
        const [theirs] = await listed(victim);

        const foreign = await revoke(attacker, theirs!.id).expect(404);
        const unknown = await revoke(attacker, randomUUID()).expect(404);

        expect(withoutCorrelation(foreign)).toEqual(withoutCorrelation(unknown));
      });

      it('answers a malformed id with the same 404, not a 422', async () => {
        const caller = await signIn(await seed());

        const response = await revoke(caller, 'not-a-uuid').expect(404);

        expect(response.body).toMatchObject({ type: 'https://forge.dev/problems/not-found' });
      });

      it('answers the second revocation of the same session with a 404', async () => {
        const email = await seed();
        const caller = await signIn(email, 'my laptop');

        await signIn(email, 'a phone');

        const target = (await listed(caller)).find((session) => session.userAgent === 'a phone');

        await revoke(caller, target!.id).expect(200);
        await revoke(caller, target!.id).expect(404);
      });

      it('refuses a caller with no session at all', async () => {
        await unsafe(http().delete(`${LIST}/${randomUUID()}`)).expect(401);
      });

      /** It is an unsafe method, so T17 applies to it exactly as it does to everything else. */
      it('is refused without the CSRF pair, before the session is even looked at', async () => {
        const caller = await signIn(await seed());
        const [session] = await listed(caller);

        const response = await http()
          .delete(`${LIST}/${session!.id}`)
          .set('Cookie', caller.cookie)
          .expect(403);

        expect(response.body).toMatchObject({
          type: 'https://forge.dev/problems/csrf-check-failed',
        });
        await list(caller).expect(200);
      });
    });
  });
});

/**
 * A problem document without the two members that are *supposed* to differ between two requests:
 * `requestId` is minted per request, and `instance` is the path, which carries the id that was
 * asked about. Everything else is what a caller could compare.
 */
function withoutCorrelation(response: request.Response): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(response.body as Record<string, unknown>).filter(
      ([member]) => member !== 'requestId' && member !== 'instance',
    ),
  );
}
