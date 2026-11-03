import { ConfigModule, ConfigService } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { hash as argon2Hash } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { ClockModule } from '../../../common/clock/clock.module';
import { CLOCK } from '../../../common/clock/clock.port';
import { FakeClock } from '../../../common/clock/fake-clock';
import { type DomainError, RateLimitedError } from '../../../common/errors/domain-error';
import { RatelimitModule } from '../../../common/ratelimit/ratelimit.module';
import {
  RedisThrottleStorage,
  throttleKey,
} from '../../../common/ratelimit/redis-throttler.storage';
import { SESSION_REDIS } from '../../../common/redis/redis.constants';
import { RedisModule } from '../../../common/redis/redis.module';
import { validateEnvironment } from '../../../config/environment';
import { APP_DATABASE } from '../../../database/database.constants';
import { DatabaseModule } from '../../../database/database.module';
import type { ForgeDatabase } from '../../../database/database.types';
import { deviceFingerprintOf } from '../device-fingerprint';
import { PasswordHasher } from '../password/hasher';
import { PasswordModule } from '../password/password.module';
import { CryptoModule } from '../../../common/crypto/crypto.module';
import {
  type LoginAttempt,
  type SignedIn,
  InvalidCredentialsError,
  LoginService,
} from './login.service';
import { MfaService } from './mfa.service';
import { SessionService, sessionIndexKey, sessionKey } from './session.service';

/**
 * A throttle small enough to trip inside a test and still shaped like the real one: two free
 * failures, then four seconds, doubling to a sixteen-second ceiling, one failure forgiven a minute.
 * Set through the environment because that is how the service is configured, so the wiring is
 * under test rather than bypassed. Hoisted, because `ConfigModule.forRoot` validates while the
 * module graph is built — earlier than any `beforeAll`.
 */
const THROTTLE = {
  accountBurst: 2,
  decaySeconds: 60,
  firstDelaySeconds: 4,
  ipBurst: 6,
  maxDelaySeconds: 16,
};

vi.hoisted(() => {
  process.env.LOGIN_THROTTLE_ACCOUNT_BURST = '2';
  process.env.LOGIN_THROTTLE_DECAY_SECONDS = '60';
  process.env.LOGIN_THROTTLE_DELAY_SECONDS = '4';
  process.env.LOGIN_THROTTLE_IP_BURST = '6';
  process.env.LOGIN_THROTTLE_MAX_DELAY_SECONDS = '16';
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const START = '2026-08-16T10:00:00.000Z';
const PASSWORD = 'correct horse battery staple';
const DEVICE = deviceFingerprintOf({ ip: '203.0.113.7', userAgent: 'curl/8.4.0' });

const seconds = (count: number): number => count * 1_000;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Every mailbox and client address this suite invents, so `afterAll` can delete the throttle
 * records they left. The suite drives a fake clock, so a record it abandons never decays — it sits
 * in the shared instance for its whole TTL and greets the next run as history.
 */
const minted = { addresses: new Set<string>(), mailboxes: new Set<string>() };

/** A fresh mailbox per test, so nothing inherits another test's account bucket. */
function address(): string {
  const mailbox = `t16-${randomUUID()}@example.test`;

  minted.mailboxes.add(mailbox);

  return mailbox;
}

/**
 * And a fresh client address per test, for the same reason and a less obvious one: the per-IP
 * bucket is shared by every account, so a suite that signs in from one address is a suite where
 * each test starts closer to the limit than the last. The clock is reset between tests, so nothing
 * decays either.
 *
 * `198.18/16` here and `198.19/16` in `login.e2e-spec.ts`, with a random third octet per run: the
 * two files run in parallel workers against the same Redis, and a run that fails part way through
 * leaves records a fixed sequence would walk straight back into.
 */
const RUN = randomInt(0, 256);
let issuedAddresses = 0;

function nextClientAddress(): string {
  issuedAddresses += 1;

  const client = `198.18.${RUN}.${issuedAddresses % 256}`;

  minted.addresses.add(client);

  return client;
}

describe('LoginService', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and the session Redis role', () => {
    let moduleRef: TestingModule;
    let login: LoginService;
    let mfa: MfaService;
    let sessions: SessionService;
    let hasher: PasswordHasher;
    let database: ForgeDatabase;
    let sessionRedis: Redis;
    let clock: FakeClock;
    let clientAddress: string;
    const created: string[] = [];

    /** Put a user in the table, and remember it so the shared database is left as it was found. */
    async function seed(
      email: string,
      passwordHash: string | null,
      emailVerifiedAt: Date | null = null,
    ): Promise<string> {
      const [user] = await database
        .insert(schema.users)
        .values({ email, emailVerifiedAt, passwordHash })
        .returning({ id: schema.users.id });

      created.push(user!.id);

      return user!.id;
    }

    async function seedWithPassword(email: string, password = PASSWORD): Promise<string> {
      return seed(email, await hasher.hash(password));
    }

    function attempt(email: string, password: string, ip = clientAddress) {
      return { device: deviceFingerprintOf({ ip, userAgent: 'curl/8.4.0' }), email, password };
    }

    /**
     * The error an attempt was refused with. A `.catch()` that returns the error types as the
     * union of "signed in" and "refused", and every assertion about the refusal then has to be
     * narrowed; failing loudly when the attempt *succeeds* is also the honest thing for a test
     * that only makes sense if it did not.
     */
    async function refusalOf(pending: LoginAttempt): Promise<DomainError> {
      try {
        await login.authenticate(pending);
      } catch (error: unknown) {
        return error as DomainError;
      }

      throw new Error('expected the attempt to be refused, but it signed in');
    }

    /** Fail `count` times, ignoring the refusals — the record they leave is the point. */
    async function failRepeatedly(email: string, count: number, ip?: string): Promise<void> {
      for (let index = 0; index < count; index += 1) {
        await expect(login.authenticate(attempt(email, 'wrong password', ip))).rejects.toThrow();
      }
    }

    /**
     * A sign-in that is expected to complete, narrowed to the arm that carries an account.
     *
     * `authenticate` answers a union since T21 — an account with a second factor stops at a
     * challenge — and every account this file seeds has none. Asserting the arm rather than casting
     * means a regression that started answering `mfa_required` for a plain account fails here,
     * naming the test, instead of surfacing as `undefined` somewhere further down.
     */
    async function signIn(credentials: LoginAttempt): Promise<SignedIn> {
      const outcome = await login.authenticate(credentials);

      if (outcome.kind !== 'signed-in') {
        expect.unreachable(`expected a completed sign-in, got "${outcome.kind}"`);
      }

      return outcome;
    }

    beforeAll(async () => {
      clock = new FakeClock(START);
      moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            ignoreEnvFile: true,
            isGlobal: true,
            validate: validateEnvironment,
          }),
          ClockModule,
          // `MfaService` seals the seed through the account-scoped half of the crypto module, and
          // `LoginService` asks it whether the account it just authenticated owes a second factor.
          CryptoModule,
          DatabaseModule,
          RedisModule,
          RatelimitModule,
          PasswordModule,
        ],
        providers: [LoginService, MfaService, SessionService],
      })
        .overrideProvider(CLOCK)
        .useValue(clock)
        .compile();

      await moduleRef.init();

      login = moduleRef.get(LoginService);
      mfa = moduleRef.get(MfaService);
      sessions = moduleRef.get(SessionService);
      hasher = moduleRef.get(PasswordHasher);
      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      sessionRedis = moduleRef.get<Redis>(SESSION_REDIS);
    });

    beforeEach(() => {
      clock.set(START);
      clientAddress = nextClientAddress();
    });

    afterAll(async () => {
      for (const id of created) {
        await database.delete(schema.users).where(eq(schema.users.id, id));
      }

      // Named exactly rather than scanned for: §09 rules out a `SCAN` of this instance, and the
      // keys are derivable from what the suite invented.
      await sessionRedis.del(
        ...[...minted.mailboxes].map((mailbox) => throttleKey('login-account', sha256(mailbox))),
        ...[...minted.addresses].map((client) => throttleKey('login-ip', client)),
      );

      await moduleRef.close();
    });

    /**
     * Criterion 4. The password was right and it is not enough: the account has a second factor, so
     * the sign-in stops at a challenge and no full session exists until that factor is presented.
     */
    describe('a sign-in by an account with MFA', () => {
      /** Seed an account, enrol it, and hand back what a test needs to drive its challenge. */
      async function enrolled(): Promise<{ email: string; userId: string }> {
        const email = address();
        const userId = await seedWithPassword(email);
        const { otpauthUri } = await mfa.beginEnrolment(userId);
        const secret = new URL(otpauthUri.replace('otpauth://', 'https://')).searchParams.get(
          'secret',
        )!;

        // Generated at the instant the fake clock is pinned to, which `beforeEach` resets to START.
        await mfa.confirmEnrolment(
          userId,
          TOTP.generate({ secret: Secret.fromBase32(secret), timestamp: Date.parse(START) }),
        );

        return { email, userId };
      }

      it('answers with a challenge rather than an account', async () => {
        const { email } = await enrolled();

        const outcome = await login.authenticate(attempt(email, PASSWORD));

        expect(outcome.kind).toBe('mfa-required');
      });

      /**
       * The disclosure the challenge exists to withhold. Naming the account here would confirm the
       * address and the password to somebody who has one of them and is guessing at the other, at
       * the exact moment we have decided not to sign them in.
       */
      it('names nobody in what it answers with', async () => {
        const { email, userId } = await enrolled();

        const outcome = await login.authenticate(attempt(email, PASSWORD));

        expect(JSON.stringify(outcome)).not.toContain(email);
        expect(JSON.stringify(outcome)).not.toContain(userId);
      });

      /**
       * It does still establish a session — the challenge has to be bound to something — and the
       * whole of criterion 4 rests on that session being refused everywhere else. `SessionGuard`
       * enforces it; this asserts the state it enforces on.
       */
      it('establishes a session that is not yet authenticated', async () => {
        const { email, userId } = await enrolled();

        const outcome = await login.authenticate(attempt(email, PASSWORD));

        await expect(sessions.authenticate(outcome.session.token)).resolves.toMatchObject({
          pendingMfa: true,
          userId,
        });
      });

      /** Minutes. A half-authenticated cookie must not outlive the sign-in that abandoned it. */
      it('gives that session the short challenge window, not the session TTL', async () => {
        const { email } = await enrolled();

        const outcome = await login.authenticate(attempt(email, PASSWORD));

        await expect(
          sessionRedis.ttl(sessionKey(sha256(outcome.session.token))),
        ).resolves.toBeLessThanOrEqual(300);
      });

      /** A wrong password on an MFA account is still a wrong password, told in the same words. */
      it('refuses a wrong password before it ever reaches the challenge', async () => {
        const { email } = await enrolled();

        const refusal = await refusalOf(attempt(email, 'wrong password'));

        expect(refusal).toBeInstanceOf(InvalidCredentialsError);
      });

      /** Session fixation, on this branch too: what the caller arrived holding stops working. */
      it('kills the session the request arrived with', async () => {
        const { email } = await enrolled();
        const stale = await sessions.create(await seedWithPassword(address()));

        await login.authenticate({ ...attempt(email, PASSWORD), currentToken: stale.token });

        await expect(sessions.authenticate(stale.token)).resolves.toBeNull();
      });
    });

    describe('a sign-in that succeeds', () => {
      it('answers with the account, and with a session to write to a cookie', async () => {
        const email = address();
        const id = await seedWithPassword(email);

        const result = await signIn(attempt(email, PASSWORD));

        expect(result.user).toEqual({ email, emailVerified: false, id, mfaEnabled: false });
        expect(result.session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      });

      it('resolves the session it issued, so the next request is authenticated', async () => {
        const email = address();
        const id = await seedWithPassword(email);

        const { session } = await signIn(attempt(email, PASSWORD));

        await expect(sessions.authenticate(session.token)).resolves.toMatchObject({ userId: id });
      });

      /** §11 records a device at exactly this moment; T18 renders it. */
      it('records the device the session was established from', async () => {
        const email = address();

        await seedWithPassword(email);

        const { session } = await signIn({
          ...attempt(email, PASSWORD),
          device: DEVICE,
        });

        await expect(
          sessionRedis.hgetall(sessionKey(sha256(session.token))),
        ).resolves.toMatchObject({
          fingerprint: DEVICE.fingerprint,
          ip: DEVICE.ip,
          userAgent: DEVICE.userAgent,
        });
      });

      /**
       * Session fixation, the other half of criterion 5. A caller who arrives holding a session —
       * one an attacker planted, or one belonging to somebody else on a shared machine — must not
       * still hold a working one afterwards.
       */
      it('kills the session the request arrived with', async () => {
        const email = address();

        await seedWithPassword(email);

        const planted = await sessions.create(randomUUID(), DEVICE);
        const { session } = await signIn({
          ...attempt(email, PASSWORD),
          currentToken: planted.token,
        });

        await expect(sessions.authenticate(planted.token)).resolves.toBeNull();
        await expect(sessions.authenticate(session.token)).resolves.not.toBeNull();
      });

      /** T12's rehash-on-verify is realised here or nowhere: this is the only place it can run. */
      it('upgrades a hash that was made at weaker parameters', async () => {
        const email = address();
        const weak = await argon2Hash(PASSWORD, {
          algorithm: 2,
          memoryCost: 19_456,
          parallelism: 1,
          timeCost: 2,
          version: 1,
        });
        const id = await seed(email, weak);

        await login.authenticate(attempt(email, PASSWORD));

        const [stored] = await database
          .select({ passwordHash: schema.users.passwordHash })
          .from(schema.users)
          .where(eq(schema.users.id, id));

        expect(stored!.passwordHash).not.toBe(weak);
        expect(stored!.passwordHash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
      });

      it('clears the failures the caller made on the way in', async () => {
        const email = address();

        await seedWithPassword(email);
        await failRepeatedly(email, THROTTLE.accountBurst + 1);

        clock.advance(seconds(THROTTLE.firstDelaySeconds));
        await login.authenticate(attempt(email, PASSWORD));

        // Straight back to a full burst: had the record survived, the next failure would refuse.
        await failRepeatedly(email, THROTTLE.accountBurst);
        await expect(login.authenticate(attempt(email, PASSWORD))).resolves.toBeDefined();
      });

      /**
       * And clears *only* those. Clearing the address bucket too would hand an attacker who holds
       * one valid account anywhere a way to reset their spray budget on demand: guess nineteen
       * passwords, sign in to their own account, guess nineteen more. The address record is not
       * theirs to forgive — it decays on its own and on nobody's say-so.
       */
      it('leaves the address bucket alone, which is not the signed-in account to forgive', async () => {
        const attacker = nextClientAddress();

        for (let index = 0; index < THROTTLE.ipBurst; index += 1) {
          await failRepeatedly(address(), 1, attacker);
        }

        const email = address();

        await seedWithPassword(email);
        await login.authenticate(attempt(email, PASSWORD, attacker));

        // One more failure is all the address bucket has left, whatever just succeeded on it.
        await failRepeatedly(address(), 1, attacker);

        await expect(login.authenticate(attempt(email, PASSWORD, attacker))).rejects.toBeInstanceOf(
          RateLimitedError,
        );
      }, 60_000);
    });

    /**
     * The property this task exists to hold down. Every failure is the same failure: the same
     * class, the same slug and the same sentence. `login.e2e-spec.ts` asserts the bytes on the
     * wire and the time they take; these assert that the service has only one way to say no.
     */
    describe('a sign-in that fails', () => {
      it('refuses a wrong password', async () => {
        const email = address();

        await seedWithPassword(email);

        await expect(login.authenticate(attempt(email, 'wrong password'))).rejects.toBeInstanceOf(
          InvalidCredentialsError,
        );
      });

      it('refuses an address with no account in exactly the same words', async () => {
        const known = address();

        await seedWithPassword(known);

        const wrongPassword = await refusalOf(attempt(known, 'wrong password'));
        const noSuchAccount = await refusalOf(attempt(address(), 'wrong password'));

        expect(noSuchAccount.constructor).toBe(wrongPassword.constructor);
        expect(noSuchAccount.type).toBe(wrongPassword.type);
        expect(noSuchAccount.detail).toBe(wrongPassword.detail);
        expect(noSuchAccount.extensions).toEqual(wrongPassword.extensions);
      });

      /** An OAuth-only account has no password to be wrong; it must not be a third answer. */
      it('refuses an account that has no password the same way', async () => {
        const email = address();

        await seed(email, null);

        await expect(login.authenticate(attempt(email, PASSWORD))).rejects.toBeInstanceOf(
          InvalidCredentialsError,
        );
      });

      /**
       * The timing half, asserted here as a fact about the code rather than about the clock: the
       * miss path verifies against a real Argon2id digest. `login.e2e-spec.ts` measures what that
       * buys; this fails the moment somebody returns early instead, which is the regression the
       * measurement is slow and noisy at catching.
       */
      it('spends the same Argon2id work on an address that does not exist', async () => {
        const verify = vi.spyOn(hasher, 'verify');

        await expect(login.authenticate(attempt(address(), PASSWORD))).rejects.toThrow();

        expect(verify).toHaveBeenCalledTimes(1);
        expect(verify.mock.calls[0]![0]).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
      });

      /**
       * A `LoginService` whose `onModuleInit` never ran has no dummy hash, and verifying against
       * an empty string answers false in microseconds — every miss fast, every hit slow, and no
       * test anywhere the wiser. It refuses to serve instead.
       */
      it('refuses to answer at all rather than answer without a dummy hash', async () => {
        const uninitialised = new LoginService(
          database,
          hasher,
          mfa,
          sessions,
          moduleRef.get(RedisThrottleStorage),
          moduleRef.get(ConfigService),
        );

        await expect(uninitialised.authenticate(attempt(address(), PASSWORD))).rejects.toThrow(
          /dummy hash/,
        );
      });

      it('spends it on an account with no password, too', async () => {
        const email = address();

        await seed(email, null);

        const verify = vi.spyOn(hasher, 'verify');

        await expect(login.authenticate(attempt(email, PASSWORD))).rejects.toThrow();

        expect(verify).toHaveBeenCalledTimes(1);
        expect(verify.mock.calls[0]![0]).toMatch(/^\$argon2id\$/);
      });

      it('never issues a session on the way out', async () => {
        const email = address();
        const id = await seedWithPassword(email);

        await expect(login.authenticate(attempt(email, 'wrong password'))).rejects.toThrow();

        await expect(sessionRedis.smembers(sessionIndexKey(id))).resolves.toEqual([]);
      });
    });

    describe('the throttle', () => {
      it('lets a burst of typos through, because a typo is not an attack', async () => {
        const email = address();

        await seedWithPassword(email);
        await failRepeatedly(email, THROTTLE.accountBurst);

        await expect(login.authenticate(attempt(email, PASSWORD))).resolves.toBeDefined();
      });

      it('refuses the attempt after the burst with a Retry-After a client can act on', async () => {
        const email = address();

        await seedWithPassword(email);
        await failRepeatedly(email, THROTTLE.accountBurst + 1);

        const refusal = await refusalOf(attempt(email, PASSWORD));

        expect(refusal).toBeInstanceOf(RateLimitedError);
        expect((refusal as RateLimitedError).retryAfterSeconds).toBe(THROTTLE.firstDelaySeconds);
        expect(refusal.type).toBe('rate-limited');
      });

      /** Refused before the work, or the throttle is an amplifier rather than a defence. */
      it('costs nothing to refuse', async () => {
        const email = address();

        await seedWithPassword(email);
        await failRepeatedly(email, THROTTLE.accountBurst + 1);

        const verify = vi.spyOn(hasher, 'verify');

        await expect(login.authenticate(attempt(email, PASSWORD))).rejects.toBeInstanceOf(
          RateLimitedError,
        );

        expect(verify).not.toHaveBeenCalled();
      });

      /**
       * The enumeration oracle a per-account throttle creates if it is keyed on the account rather
       * than on the address that was typed: an address that never throttles is an address with no
       * account behind it, and no amount of care over the 401 would hide it.
       */
      it('throttles an address with no account exactly as it throttles a real one', async () => {
        const unknown = address();

        await failRepeatedly(unknown, THROTTLE.accountBurst + 1);

        await expect(login.authenticate(attempt(unknown, PASSWORD))).rejects.toBeInstanceOf(
          RateLimitedError,
        );
      });

      /**
       * Criterion 16, the half that matters: a locked-out account recovers on its own. Nothing is
       * cleared here and nobody is asked — the only thing that changes is the time.
       */
      it('lets the account back in once the delay has run out', async () => {
        const email = address();

        await seedWithPassword(email);
        await failRepeatedly(email, THROTTLE.accountBurst + 1);

        await expect(login.authenticate(attempt(email, PASSWORD))).rejects.toBeInstanceOf(
          RateLimitedError,
        );

        clock.advance(seconds(THROTTLE.firstDelaySeconds));

        await expect(login.authenticate(attempt(email, PASSWORD))).resolves.toBeDefined();
      });

      /**
       * And recovers from the worst record it can hold. An attacker who keeps guessing against a
       * known address must not be able to hold its owner out indefinitely — the delay has a
       * ceiling, and the count that produces it has one too.
       */
      it('recovers even from a sustained attack on a known address', async () => {
        const email = address();

        await seedWithPassword(email);

        // Comfortably past the count at which the delay reaches its ceiling, which is the point
        // where an unbounded record would start lengthening the owner's recovery without bound.
        for (let round = 0; round < 20; round += 1) {
          clock.advance(seconds(THROTTLE.maxDelaySeconds));
          await expect(login.authenticate(attempt(email, 'wrong password'))).rejects.toThrow();
        }

        clock.advance(seconds(THROTTLE.maxDelaySeconds));

        await expect(login.authenticate(attempt(email, PASSWORD))).resolves.toBeDefined();
      }, 60_000);

      /** §11 asks for both buckets. This one catches the spray across many addresses. */
      it('refuses an address that has been guessing at accounts generally', async () => {
        const attacker = nextClientAddress();

        for (let index = 0; index <= THROTTLE.ipBurst; index += 1) {
          await failRepeatedly(address(), 1, attacker);
        }

        const email = address();

        await seedWithPassword(email);

        await expect(login.authenticate(attempt(email, PASSWORD, attacker))).rejects.toBeInstanceOf(
          RateLimitedError,
        );
      });

      it('leaves every other address alone while it does', async () => {
        const attacker = nextClientAddress();

        for (let index = 0; index <= THROTTLE.ipBurst; index += 1) {
          await failRepeatedly(address(), 1, attacker);
        }

        const email = address();

        await seedWithPassword(email);

        await expect(
          login.authenticate(attempt(email, PASSWORD, nextClientAddress())),
        ).resolves.toBeDefined();
      });
    });

    describe('signing out', () => {
      it('revokes the session the request arrived on', async () => {
        const email = address();

        await seedWithPassword(email);

        const { session } = await signIn(attempt(email, PASSWORD));

        await expect(login.signOut(session.token)).resolves.toBe(true);
        await expect(sessions.authenticate(session.token)).resolves.toBeNull();
      });

      it('is untroubled by a session that is already gone', async () => {
        await expect(login.signOut('not-a-session-token')).resolves.toBe(false);
      });
    });
  });
});
