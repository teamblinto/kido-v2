import { ConfigModule } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { outbox, schema } from '@repo/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { ClockModule } from '../../../common/clock/clock.module';
import { CLOCK } from '../../../common/clock/clock.port';
import { FakeClock } from '../../../common/clock/fake-clock';
import { RateLimitedError } from '../../../common/errors/domain-error';
import { RatelimitModule } from '../../../common/ratelimit/ratelimit.module';
import { throttleKey } from '../../../common/ratelimit/redis-throttler.storage';
import { SESSION_REDIS } from '../../../common/redis/redis.constants';
import { RedisModule } from '../../../common/redis/redis.module';
import { validateEnvironment } from '../../../config/environment';
import { APP_DATABASE } from '../../../database/database.constants';
import { DatabaseModule } from '../../../database/database.module';
import type { ForgeDatabase } from '../../../database/database.types';
import { OutboxWriter } from '../../outbox/outbox-writer';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
  BreachedPasswordError,
} from '../password/breached-password.port';
import { PasswordHasher } from '../password/hasher';
import { PasswordModule } from '../password/password.module';
import { WeakPasswordError } from '../password/strength-policy';
import { PasswordResetService } from './password-reset.service';
import { SessionService } from './session.service';
import { DeadTokenError, TokenService } from './token.service';

/**
 * A throttle small enough to trip inside a test and still shaped like the real one, set through the
 * environment so the wiring is under test rather than bypassed. Hoisted, because
 * `ConfigModule.forRoot` validates while the module graph is built — earlier than any `beforeAll`.
 */
const THROTTLE = { accountBurst: 2, ipBurst: 40 };

vi.hoisted(() => {
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.PASSWORD_RESET_ACCOUNT_BURST = '2';
  process.env.PASSWORD_RESET_DECAY_SECONDS = '60';
  process.env.PASSWORD_RESET_DELAY_SECONDS = '4';
  process.env.PASSWORD_RESET_IP_BURST = '40';
  process.env.PASSWORD_RESET_MAX_DELAY_SECONDS = '16';
  process.env.SESSION_TTL_SECONDS = '900';
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const START = '2026-08-16T10:00:00.000Z';
const THIRTY_MINUTES_MS = 30 * 60 * 1_000;
const CHOSEN = 'kestrel-oxbow-parapet-sundial';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** `198.22/16`, distinct from the ranges the login and verification suites claim in the same Redis. */
const RUN = randomInt(0, 256);
let issuedAddresses = 0;

class ScriptedBreachPort implements BreachedPasswordPort {
  breached = false;

  isBreached(_password: string): Promise<boolean> {
    return Promise.resolve(this.breached);
  }
}

describe('PasswordResetService', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and the session Redis role', () => {
    let moduleRef: TestingModule;
    let resets: PasswordResetService;
    let sessions: SessionService;
    let hasher: PasswordHasher;
    let database: ForgeDatabase;
    let tokens: TokenService;
    let breach: ScriptedBreachPort;
    let clock: FakeClock;
    const created: string[] = [];
    const minted = { addresses: new Set<string>(), mailboxes: new Set<string>() };

    function mailbox(): string {
      const address = `t19-${randomUUID()}@example.test`;

      minted.mailboxes.add(address);

      return address;
    }

    /**
     * A fresh client address per request. The per-IP bucket is shared by every account, and the
     * suite drives a fake clock, so nothing a test leaves behind ever decays on its own.
     */
    function nextClientAddress(): string {
      issuedAddresses += 1;

      const client = `198.22.${RUN}.${issuedAddresses % 256}`;

      minted.addresses.add(client);

      return client;
    }

    async function seed(
      email = mailbox(),
      password: string | null = 'thermos-quibble-tundra',
    ): //
    Promise<{ email: string; userId: string }> {
      const [user] = await database
        .insert(schema.users)
        .values({ email, passwordHash: password === null ? null : await hasher.hash(password) })
        .returning({ id: schema.users.id });

      created.push(user!.id);

      return { email, userId: user!.id };
    }

    /**
     * Mint a link for an address the way the consumer does (spec 006), and hand back the raw token.
     *
     * Issuing is `IdentityMailConsumer`'s and is asserted in its own spec; this suite is about
     * asking and spending, so the row is written directly with the lifetime §11 names, restated.
     */
    async function mintFor(email: string): Promise<string> {
      const [user] = await database
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, email));
      const issued = tokens.issue(THIRTY_MINUTES_MS / 1_000);

      await database.insert(schema.passwordResetTokens).values({
        expiresAt: issued.expiresAt,
        tokenHash: issued.tokenHash,
        userId: user!.id,
      });

      return issued.token;
    }

    /** The mail events appended for an address — what a request produces now, in place of a send. */
    async function eventsFor(email: string): Promise<{ type: string; userId: unknown }[]> {
      return database
        .select({ type: outbox.type, userId: sql<unknown>`${outbox.payload}->>'userId'` })
        .from(outbox)
        .where(sql`${outbox.payload}->>'recipient' = ${email}`)
        .orderBy(outbox.seq);
    }

    async function tokenRowsFor(userId: string) {
      return database
        .select()
        .from(schema.passwordResetTokens)
        .where(eq(schema.passwordResetTokens.userId, userId));
    }

    async function storedHashOf(userId: string): Promise<string | null> {
      const [user] = await database
        .select({ passwordHash: schema.users.passwordHash })
        .from(schema.users)
        .where(eq(schema.users.id, userId));

      return user!.passwordHash;
    }

    beforeAll(async () => {
      clock = new FakeClock(START);
      breach = new ScriptedBreachPort();
      moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            ignoreEnvFile: true,
            isGlobal: true,
            validate: validateEnvironment,
          }),
          ClockModule,
          DatabaseModule,
          RedisModule,
          RatelimitModule,
          PasswordModule,
        ],
        // No `MAILER`: the service no longer asks for one, and the module would not compile if it did.
        providers: [OutboxWriter, PasswordResetService, SessionService, TokenService],
      })
        .overrideProvider(CLOCK)
        .useValue(clock)
        .overrideProvider(BREACHED_PASSWORD_PORT)
        .useValue(breach)
        .compile();

      await moduleRef.init();

      resets = moduleRef.get(PasswordResetService);
      sessions = moduleRef.get(SessionService);
      hasher = moduleRef.get(PasswordHasher);
      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      tokens = moduleRef.get(TokenService);
    }, 60_000);

    beforeEach(() => {
      clock.set(START);
      breach.breached = false;
    });

    afterAll(async () => {
      if (created.length > 0) {
        await database.delete(schema.users).where(inArray(schema.users.id, created));
      }

      const store = moduleRef.get<Redis>(SESSION_REDIS);
      const keys = [
        ...[...minted.mailboxes].map((box) => throttleKey('password-reset-account', sha256(box))),
        ...[...minted.addresses].map((client) => throttleKey('password-reset-ip', client)),
      ];

      if (keys.length > 0) {
        await store.del(...keys);
      }

      await moduleRef?.close();
    });

    /**
     * Asking is one outbox row (spec 006 FR-002); the token, its row and the mail are the
     * consumer's and are asserted in `identity-mail.consumer.spec.ts`. What the request path is
     * held to here is that it appends exactly the event, on exactly one branch, and mints nothing.
     */
    describe('requesting a link', () => {
      it('appends one reset event for an address that has an account', async () => {
        const { email, userId } = await seed();

        await resets.request({ email, ip: nextClientAddress() });

        expect(await eventsFor(email)).toEqual([{ type: 'mail.password-reset', userId }]);
      });

      /** The token is the consumer's to mint: a request path that wrote one would hold it. */
      it('writes no token row on the request path', async () => {
        const { email, userId } = await seed();

        await resets.request({ email, ip: nextClientAddress() });

        expect(await tokenRowsFor(userId)).toHaveLength(0);
      });

      /**
       * Criterion 7's first half at the service boundary: the method resolves the same way for both,
       * with nothing in the return value to tell them apart. The e2e suite asserts the bytes and the
       * timing over HTTP; this asserts that the service has no other answer to give.
       */
      it('resolves for an address with no account, exactly as it does for one with', async () => {
        await expect(resets.request({ email: mailbox(), ip: nextClientAddress() })) //
          .resolves.toBeUndefined();
      });

      it('appends nothing for an address with no account', async () => {
        const orphan = mailbox();

        await resets.request({ email: orphan, ip: nextClientAddress() });

        expect(await eventsFor(orphan)).toHaveLength(0);
      });

      it('mints no token for an address with no account', async () => {
        const orphan = mailbox();

        await resets.request({ email: orphan, ip: nextClientAddress() });

        const rows = await database
          .select()
          .from(schema.passwordResetTokens)
          .innerJoin(schema.users, eq(schema.users.id, schema.passwordResetTokens.userId))
          .where(eq(schema.users.email, orphan));

        expect(rows).toHaveLength(0);
      });

      /**
       * An account that has only ever signed in through OAuth has no password, and a reset is how it
       * gets one. Refusing here would leave such a user with no way to set a password at all.
       */
      it('appends a reset event for an account that has no password yet', async () => {
        const { email, userId } = await seed(mailbox(), null);

        await resets.request({ email, ip: nextClientAddress() });

        expect(await eventsFor(email)).toEqual([{ type: 'mail.password-reset', userId }]);
      });

      /**
       * Two outstanding links are two links that each work once and both die inside the window.
       * Superseding the older one would refuse the mail a user clicked first, which is the worse
       * answer to the more common mistake — the same judgement `EmailVerificationService.request`
       * makes.
       */
      it('leaves an earlier outstanding link alone', async () => {
        const { email, userId } = await seed();
        const first = await mintFor(email);

        await mintFor(email);

        expect(await tokenRowsFor(userId)).toHaveLength(2);
        await expect(resets.complete({ password: CHOSEN, token: first })).resolves.toBeTypeOf(
          'number',
        );
      });

      describe('the throttle', () => {
        it('refuses once the address has spent its burst', async () => {
          const { email } = await seed();
          const ip = nextClientAddress();

          for (let spent = 0; spent <= THROTTLE.accountBurst; spent += 1) {
            await resets.request({ email, ip });
          }

          await expect(resets.request({ email, ip })).rejects.toBeInstanceOf(RateLimitedError);
        });

        /**
         * The refusal must not depend on whether the address exists, or the 429 is the oracle the
         * 202 declines to be. Both buckets are charged before the lookup for exactly this reason.
         */
        it('refuses an address with no account the same way', async () => {
          const orphan = mailbox();
          const ip = nextClientAddress();

          for (let spent = 0; spent <= THROTTLE.accountBurst; spent += 1) {
            await resets.request({ email: orphan, ip });
          }

          await expect(resets.request({ email: orphan, ip })).rejects.toBeInstanceOf(
            RateLimitedError,
          );
        });

        it('appends nothing on the request it refused', async () => {
          const { email } = await seed();
          const ip = nextClientAddress();

          for (let spent = 0; spent <= THROTTLE.accountBurst; spent += 1) {
            await resets.request({ email, ip });
          }

          const before = (await eventsFor(email)).length;

          await expect(resets.request({ email, ip })).rejects.toThrow();

          expect(await eventsFor(email)).toHaveLength(before);
        });
      });
    });

    describe('spending a link', () => {
      it('stores a hash the chosen password verifies against', async () => {
        const { email, userId } = await seed();
        const token = await mintFor(email);

        await resets.complete({ password: CHOSEN, token: token });

        await expect(hasher.verify((await storedHashOf(userId))!, CHOSEN)).resolves.toMatchObject({
          valid: true,
        });
      });

      it('marks the token consumed rather than deleting it', async () => {
        const { email, userId } = await seed();
        const token = await mintFor(email);

        await resets.complete({ password: CHOSEN, token: token });

        expect((await tokenRowsFor(userId))[0]!.consumedAt).not.toBeNull();
      });

      it('refuses the same link a second time', async () => {
        const { email } = await seed();
        const token = await mintFor(email);

        await resets.complete({ password: CHOSEN, token: token });

        await expect(resets.complete({ password: CHOSEN, token: token })) //
          .rejects.toMatchObject({ type: 'token-already-used' });
      });

      it('refuses one past the thirty-minute window', async () => {
        const { email } = await seed();
        const token = await mintFor(email);

        clock.advance(THIRTY_MINUTES_MS);

        await expect(resets.complete({ password: CHOSEN, token: token })) //
          .rejects.toMatchObject({ type: 'token-expired' });
      });

      it('still works with one millisecond of the window left', async () => {
        const { email } = await seed();
        const token = await mintFor(email);

        clock.advance(THIRTY_MINUTES_MS - 1);

        await expect(resets.complete({ password: CHOSEN, token: token })).resolves.toBeTypeOf(
          'number',
        );
      });

      it('refuses a token nobody minted', async () => {
        await expect(
          resets.complete({ password: CHOSEN, token: 'Zm9yZ2Utbm90LWEtdG9rZW4tYXQtYWxs' }),
        ).rejects.toBeInstanceOf(DeadTokenError);
      });

      /**
       * §11, and the half of criterion 7 that matters most: **every** session, including the one
       * that made the request. A reset is what somebody does when they believe another device is
       * not theirs, and one that spared any session would leave that device signed in.
       */
      it('revokes every session the account has', async () => {
        const { email, userId } = await seed();
        const elsewhere = [await sessions.create(userId), await sessions.create(userId)];
        const token = await mintFor(email);

        await resets.complete({ password: CHOSEN, token: token });

        for (const session of elsewhere) {
          await expect(sessions.authenticate(session.token)).resolves.toBeNull();
        }
      });

      it('answers how many sessions it ended', async () => {
        const { email, userId } = await seed();

        await sessions.create(userId);
        await sessions.create(userId);

        const token = await mintFor(email);

        await expect(resets.complete({ password: CHOSEN, token: token })).resolves.toBe(2);
      });

      /**
       * The other live links die with the sessions, and for the same reason. If an attacker asked
       * for a reset an hour before the owner did, a reset that only spent the token in front of it
       * would leave the attacker holding a working link to an account whose password had just been
       * changed — the takeover the wholesale revocation exists to prevent, arriving a minute later.
       */
      it('kills the account’s other outstanding links', async () => {
        const { email } = await seed();
        const attackers = await mintFor(email);
        const owners = await mintFor(email);

        await resets.complete({ password: CHOSEN, token: owners });

        await expect(resets.complete({ password: CHOSEN, token: attackers })) //
          .rejects.toMatchObject({ type: 'token-already-used' });
      });

      it('leaves another account’s outstanding link alone', async () => {
        const mine = await seed();
        const theirs = await seed();
        const ours = await mintFor(mine.email);
        const yours = await mintFor(theirs.email);

        await resets.complete({ password: CHOSEN, token: ours });

        await expect(resets.complete({ password: CHOSEN, token: yours })).resolves.toBeTypeOf(
          'number',
        );
      });

      it('leaves another account’s sessions alone', async () => {
        const mine = await seed();
        const theirs = await seed();
        const bystander = await sessions.create(theirs.userId);
        const token = await mintFor(mine.email);

        await resets.complete({ password: CHOSEN, token: token });

        await expect(sessions.authenticate(bystander.token)).resolves.toMatchObject({
          userId: theirs.userId,
        });
      });

      describe('a password the policy refuses', () => {
        it('refuses a weak one', async () => {
          const { email } = await seed();
          const token = await mintFor(email);

          await expect(resets.complete({ password: 'password123456', token: token })) //
            .rejects.toBeInstanceOf(WeakPasswordError);
        });

        it('refuses one from a breach corpus', async () => {
          const { email } = await seed();
          const token = await mintFor(email);

          breach.breached = true;

          await expect(resets.complete({ password: CHOSEN, token: token })) //
            .rejects.toBeInstanceOf(BreachedPasswordError);
        });

        /**
         * And it does **not** spend the link. A single-use token burnt on a password the policy was
         * always going to refuse leaves the user locked out of their own reset, holding a dead link
         * and a fresh mail to wait for — for a mistake they can fix by typing a better password.
         */
        it('leaves the link usable', async () => {
          const { email } = await seed();
          const token = await mintFor(email);

          await expect(resets.complete({ password: 'password123456', token: token })) //
            .rejects.toThrow();

          await expect(resets.complete({ password: CHOSEN, token: token })).resolves.toBeTypeOf(
            'number',
          );
        });

        it('leaves the stored password alone', async () => {
          const { email, userId } = await seed();
          const before = await storedHashOf(userId);
          const token = await mintFor(email);

          await expect(resets.complete({ password: 'password123456', token: token })) //
            .rejects.toThrow();

          await expect(storedHashOf(userId)).resolves.toBe(before);
        });

        it('leaves the sessions alone', async () => {
          const { email, userId } = await seed();
          const live = await sessions.create(userId);
          const token = await mintFor(email);

          await expect(resets.complete({ password: 'password123456', token: token })) //
            .rejects.toThrow();

          await expect(sessions.authenticate(live.token)).resolves.toMatchObject({ userId });
        });
      });

      /**
       * Single use has to survive two clicks arriving together, which is the shape of a
       * double-clicked mail link. The conditional update is what makes exactly one of them match a
       * row; a read-then-write would let both through.
       */
      it('lets exactly one of two simultaneous attempts through', async () => {
        const { email, userId } = await seed();
        const token = await mintFor(email);

        const outcomes = await Promise.allSettled([
          resets.complete({ password: CHOSEN, token: token }),
          resets.complete({ password: CHOSEN, token: token }),
        ]);

        expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);

        const [row] = await database
          .select()
          .from(schema.passwordResetTokens)
          .where(
            and(
              eq(schema.passwordResetTokens.userId, userId),
              eq(schema.passwordResetTokens.tokenHash, sha256(token)),
            ),
          );

        expect(row!.consumedAt).not.toBeNull();
      });
    });
  });
});
