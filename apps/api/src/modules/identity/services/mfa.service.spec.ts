import { ConfigModule } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { TOTP, URI } from 'otpauth';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from 'vitest';

import { ClockModule } from '../../../common/clock/clock.module';
import { CLOCK } from '../../../common/clock/clock.port';
import { FakeClock } from '../../../common/clock/fake-clock';
import { CryptoModule } from '../../../common/crypto/crypto.module';
import { DomainError } from '../../../common/errors/domain-error';
import { SESSION_REDIS } from '../../../common/redis/redis.constants';
import { RedisModule } from '../../../common/redis/redis.module';
import { validateEnvironment } from '../../../config/environment';
import { APP_DATABASE } from '../../../database/database.constants';
import { DatabaseModule } from '../../../database/database.module';
import type { ForgeDatabase } from '../../../database/database.types';
import { PasswordModule } from '../password/password.module';
import { MfaService, pendingEnrolmentKey } from './mfa.service';
import { SessionService } from './session.service';

/**
 * The TOTP parameters this file drives, set through the environment rather than passed in, so the
 * wiring is under test rather than bypassed — the argument `login.service.spec.ts` makes. Hoisted
 * above the imports because `ConfigModule.forRoot` validates while the module graph is built.
 *
 * The drift window is pinned to one step of thirty seconds. Both boundary tests below compute their
 * instants from these two numbers, so raising either in `environment.ts` moves the boundaries with
 * it rather than turning this file red.
 */
const PERIOD_SECONDS = 30;
const DRIFT_STEPS = 1;

/** Small enough to spend inside a test, and shaped like the real cap. */
const MAX_ATTEMPTS = 3;

vi.hoisted(() => {
  process.env.MFA_CHALLENGE_MAX_ATTEMPTS = '3';
  process.env.MFA_CHALLENGE_TTL_SECONDS = '300';
  process.env.MFA_ISSUER = 'Forge';
  process.env.MFA_TOTP_DIGITS = '6';
  process.env.MFA_TOTP_DRIFT_STEPS = '1';
  process.env.MFA_TOTP_PERIOD_SECONDS = '30';
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

/**
 * Ten o'clock exactly, which is a whole multiple of the thirty-second period. Every drift
 * assertion below is a whole number of steps from here, so the counter arithmetic is exact rather
 * than "somewhere in this bucket" — a start instant a few seconds into a step would make the
 * just-inside case pass for the wrong reason.
 */
const START = '2026-08-16T10:00:00.000Z';
const START_MS = Date.parse(START);

/** One step of drift, in milliseconds. */
const STEP_MS = PERIOD_SECONDS * 1_000;

describe('MfaService', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and the session Redis role', () => {
    let moduleRef: TestingModule;
    let mfa: MfaService;
    let sessions: SessionService;
    let database: ForgeDatabase;
    let sessionRedis: Redis;
    let clock: FakeClock;
    const created: string[] = [];

    /** An account, put in the table directly. Signup's own wiring is `signup.service.spec.ts`. */
    async function seed(): Promise<{ email: string; userId: string }> {
      const email = `t20-${randomUUID()}@example.test`;
      const [user] = await database
        .insert(schema.users)
        .values({ email, passwordHash: null })
        .returning({ id: schema.users.id });

      created.push(user!.id);

      return { email, userId: user!.id };
    }

    /**
     * The code an authenticator app would show at `atMs`, derived from the provisioning URI exactly
     * as a phone derives it. Reading the seed out of the URI rather than out of the service is the
     * point: the URI is the only place the seed is ever legible, and a test that reached past it
     * would not notice if the URI stopped carrying a usable one.
     */
    function codeAt(otpauthUri: string, atMs: number): string {
      return URI.parse(otpauthUri).generate({ timestamp: atMs });
    }

    /** Enrol and confirm, leaving the account with live TOTP and ten recovery codes. */
    async function enrol(): Promise<{
      otpauthUri: string;
      recoveryCodes: readonly string[];
      userId: string;
    }> {
      const { userId } = await seed();
      const { otpauthUri } = await mfa.beginEnrolment(userId);
      const { recoveryCodes } = await mfa.confirmEnrolment(userId, codeAt(otpauthUri, START_MS));

      return { otpauthUri, recoveryCodes, userId };
    }

    async function userRow(id: string) {
      const [row] = await database.select().from(schema.users).where(eq(schema.users.id, id));

      return row;
    }

    async function recoveryRows(userId: string) {
      return database
        .select()
        .from(schema.mfaRecoveryCodes)
        .where(eq(schema.mfaRecoveryCodes.userId, userId));
    }

    /** The error a call was refused with, failing loudly when it was not refused. */
    async function refusalOf(call: Promise<unknown>): Promise<DomainError> {
      try {
        await call;
      } catch (error: unknown) {
        return error as DomainError;
      }

      return expect.unreachable('expected the call to be refused, but it succeeded');
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
          CryptoModule,
          DatabaseModule,
          PasswordModule,
          RedisModule,
        ],
        providers: [MfaService, SessionService],
      })
        .overrideProvider(CLOCK)
        .useValue(clock)
        .compile();

      await moduleRef.init();

      mfa = moduleRef.get(MfaService);
      sessions = moduleRef.get(SessionService);
      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      sessionRedis = moduleRef.get<Redis>(SESSION_REDIS);
    }, 60_000);

    beforeEach(() => {
      clock.set(START);
    });

    afterAll(async () => {
      for (const id of created) {
        // `mfa_recovery_codes` cascades on the user, so one delete clears both tables.
        await database.delete(schema.users).where(eq(schema.users.id, id));
        await sessionRedis.del(pendingEnrolmentKey(id));
      }

      await moduleRef.close();
    }, 60_000);

    describe('beginning an enrolment', () => {
      it('hands back a provisioning URI an authenticator app can read', async () => {
        const { email, userId } = await seed();

        const { otpauthUri } = await mfa.beginEnrolment(userId);

        const parsed = URI.parse(otpauthUri);

        // `URI.parse` answers `TOTP | HOTP`, and the narrowing is an assertion rather than a cast:
        // an `otpauth://hotp/` URI is a counter-based enrolment no phone would keep in step with a
        // clock, and it would satisfy every other line here.
        expect(parsed).toBeInstanceOf(TOTP);
        expect(otpauthUri.startsWith('otpauth://totp/')).toBe(true);
        expect(parsed.issuer).toBe('Forge');
        expect(parsed.label).toBe(email);
        expect((parsed as TOTP).period).toBe(PERIOD_SECONDS);
        expect(parsed.digits).toBe(6);
      });

      /**
       * The property this task exists for. A user who mis-scans the QR and walks away must not have
       * locked themselves out — until a confirming code arrives, the account is exactly as it was.
       */
      it('does not activate MFA on the account', async () => {
        const { userId } = await seed();

        await mfa.beginEnrolment(userId);

        expect((await userRow(userId))?.mfaSecretEnc).toBeNull();
        await expect(mfa.isEnrolled(userId)).resolves.toBe(false);
      });

      /** And issues nothing that would have to be honoured for an enrolment that never completes. */
      it('issues no recovery codes yet', async () => {
        const { userId } = await seed();

        await mfa.beginEnrolment(userId);

        await expect(recoveryRows(userId)).resolves.toHaveLength(0);
      });

      /**
       * The pending seed is held encrypted, not in the clear. The session store is a different
       * process with a different failure mode from Postgres, and a seed sitting in it as base32 is
       * a seed a `KEYS`-shaped incident hands over.
       */
      it('parks the pending seed as ciphertext, never as the seed', async () => {
        const { userId } = await seed();

        const { otpauthUri } = await mfa.beginEnrolment(userId);
        const seedInUri = new URL(otpauthUri.replace('otpauth://', 'https://')).searchParams.get(
          'secret',
        );
        const parked = await sessionRedis.getBuffer(pendingEnrolmentKey(userId));

        expect(seedInUri).toMatch(/^[A-Z2-7]{32}$/);
        expect(parked).not.toBeNull();
        expect(parked!.toString('utf8')).not.toContain(seedInUri!);
        expect(parked!.toString('base64')).not.toContain(seedInUri!);
      });

      /** Starting over is how a user recovers from scanning the code onto the wrong phone. */
      it('replaces a pending enrolment rather than refusing a second attempt', async () => {
        const { userId } = await seed();

        const first = await mfa.beginEnrolment(userId);
        const second = await mfa.beginEnrolment(userId);

        expect(second.otpauthUri).not.toBe(first.otpauthUri);
        await expect(
          mfa.confirmEnrolment(userId, codeAt(first.otpauthUri, START_MS)),
        ).rejects.toThrow(DomainError);
        await expect(
          mfa.confirmEnrolment(userId, codeAt(second.otpauthUri, START_MS)),
        ).resolves.toBeDefined();
      });

      it('refuses to start one for an account that already has MFA', async () => {
        const { userId } = await enrol();

        const refusal = await refusalOf(mfa.beginEnrolment(userId));

        expect(refusal.type).toBe('conflict');
      });
    });

    describe('confirming an enrolment', () => {
      it('activates MFA when the code is right', async () => {
        const { userId } = await seed();
        const { otpauthUri } = await mfa.beginEnrolment(userId);

        await mfa.confirmEnrolment(userId, codeAt(otpauthUri, START_MS));

        await expect(mfa.isEnrolled(userId)).resolves.toBe(true);
      });

      /**
       * The seed reaches the column as envelope ciphertext (§05, purpose `mfa_seed`). Asserted on
       * the bytes rather than on the call, because "we called the encryptor" and "the column does
       * not contain the seed" are different claims and only the second one is the requirement.
       */
      it('stores the seed as ciphertext, never as the seed', async () => {
        const { userId } = await seed();
        const { otpauthUri } = await mfa.beginEnrolment(userId);
        const seedInUri = new URL(otpauthUri.replace('otpauth://', 'https://')).searchParams.get(
          'secret',
        )!;

        await mfa.confirmEnrolment(userId, codeAt(otpauthUri, START_MS));

        const stored = (await userRow(userId))?.mfaSecretEnc;

        expect(stored).toBeInstanceOf(Buffer);
        expect(stored!.toString('utf8')).not.toContain(seedInUri);
        expect(stored!.toString('base64')).not.toContain(seedInUri);
      });

      it('refuses a code that is not the one the pending seed produces', async () => {
        const { userId } = await seed();

        await mfa.beginEnrolment(userId);

        const refusal = await refusalOf(mfa.confirmEnrolment(userId, '000000'));

        expect(refusal.type).toBe('mfa-code-incorrect');
        await expect(mfa.isEnrolled(userId)).resolves.toBe(false);
      });

      /** A wrong code is a typo, not the end of the enrolment: the pending seed survives it. */
      it('leaves the pending enrolment claimable after a wrong code', async () => {
        const { userId } = await seed();
        const { otpauthUri } = await mfa.beginEnrolment(userId);

        await refusalOf(mfa.confirmEnrolment(userId, '000000'));

        await expect(
          mfa.confirmEnrolment(userId, codeAt(otpauthUri, START_MS)),
        ).resolves.toBeDefined();
      });

      it('refuses when there is no enrolment in progress', async () => {
        const { userId } = await seed();

        const refusal = await refusalOf(mfa.confirmEnrolment(userId, '000000'));

        expect(refusal.type).toBe('conflict');
      });

      /** The pending seed is spent by the confirmation that used it. */
      it('clears the pending enrolment once it has been confirmed', async () => {
        const { userId } = await enrol();

        await expect(sessionRedis.exists(pendingEnrolmentKey(userId))).resolves.toBe(0);
      });
    });

    describe('the recovery codes', () => {
      it('issues exactly ten', async () => {
        const { recoveryCodes, userId } = await enrol();

        expect(recoveryCodes).toHaveLength(10);
        expect(new Set(recoveryCodes).size).toBe(10);
        await expect(recoveryRows(userId)).resolves.toHaveLength(10);
      });

      /**
       * Hashed at rest, and hashed the way a *password* is. A recovery code is short enough to be
       * worth brute-forcing offline, which is the whole reason `mfa_recovery_codes.code_hash` is
       * sized for an Argon2id digest rather than for a SHA-256 of a 32-byte mint.
       */
      it('stores an Argon2id digest and never the code', async () => {
        const { recoveryCodes, userId } = await enrol();
        const rows = await recoveryRows(userId);

        for (const row of rows) {
          expect(row.codeHash).toMatch(/^\$argon2id\$v=19\$/);

          for (const code of recoveryCodes) {
            expect(row.codeHash).not.toContain(code);
          }
        }
      });

      /**
       * Shown exactly once (criterion 8), asserted as behaviour rather than as an API-surface
       * shape: `confirmEnrolment` is the only call that has ever returned a code, and it cannot be
       * made to return the same ones twice. The pending seed it needs is spent, so the second call
       * has nothing to confirm.
       */
      it('cannot be talked into handing the same codes back', async () => {
        const { otpauthUri, userId } = await enrol();

        const refusal = await refusalOf(mfa.confirmEnrolment(userId, codeAt(otpauthUri, START_MS)));

        expect(refusal.type).toBe('conflict');
      });

      /**
       * And the way back to a readable set is to issue a *new* one, which invalidates the old.
       * Somebody who lost their printout gets ten fresh codes, not the ten they lost — so a copy of
       * the old list found later is worth nothing.
       */
      it('issues a disjoint set when the account enrols again', async () => {
        const { recoveryCodes: first, userId } = await enrol();

        await mfa.disable(userId);

        const { otpauthUri } = await mfa.beginEnrolment(userId);
        const { recoveryCodes: second } = await mfa.confirmEnrolment(
          userId,
          codeAt(otpauthUri, START_MS),
        );

        expect(second.filter((code) => first.includes(code))).toEqual([]);

        for (const code of first) {
          await expect(mfa.verify(userId, code)).resolves.toBeNull();
        }
        // Two enrolments and ten refused codes, each of which is compared against ten live Argon2id
        // digests at 64 MB. The cost is the point — it is what makes a recovery code worth hashing
        // rather than digesting — so the budget is raised rather than the assertion narrowed.
      }, 180_000);
    });

    /**
     * §11's drift window, driven against `FakeClock` from both directions.
     *
     * A window test that only proves acceptance proves nothing: a service that accepted every code
     * regardless of the clock would pass the two "just inside" cases and fail no other test in this
     * file. Each direction therefore comes in a pair, and the pair differs by exactly one step.
     */
    describe('the TOTP drift window', () => {
      let userId: string;
      let code: string;
      let strangersCode: string;

      /**
       * One enrolment for the whole group, rather than one per assertion.
       *
       * Nothing here consumes anything — every test below moves the clock and verifies a TOTP code,
       * which mutates no state — so a fresh account per test would buy no isolation. It would cost
       * ten Argon2id hashes at 64 MB each time, and this file already runs in a worker beside
       * `login.e2e-spec.ts` and `password.e2e-spec.ts`, whose assertions are *timing* medians. Work
       * this group does not need is CPU those two measure.
       *
       * The clock is pinned first: the enclosing `beforeEach` has not run yet at this point, so the
       * confirming code below would otherwise be checked against wherever the previous group left
       * the clock.
       */
      beforeAll(async () => {
        clock.set(START);

        const enrolled = await enrol();
        const stranger = await enrol();

        userId = enrolled.userId;
        code = codeAt(enrolled.otpauthUri, START_MS);
        strangersCode = codeAt(stranger.otpauthUri, START_MS);
      }, 60_000);

      it('accepts the code of the current step', async () => {
        await expect(mfa.verify(userId, code)).resolves.toBe('totp');
      });

      it(`accepts a code ${DRIFT_STEPS} step(s) behind the clock`, async () => {
        clock.set(START_MS + DRIFT_STEPS * STEP_MS);

        await expect(mfa.verify(userId, code)).resolves.toBe('totp');
      });

      it(`rejects a code ${DRIFT_STEPS + 1} step(s) behind the clock`, async () => {
        clock.set(START_MS + (DRIFT_STEPS + 1) * STEP_MS);

        await expect(mfa.verify(userId, code)).resolves.toBeNull();
      });

      it(`accepts a code ${DRIFT_STEPS} step(s) ahead of the clock`, async () => {
        clock.set(START_MS - DRIFT_STEPS * STEP_MS);

        await expect(mfa.verify(userId, code)).resolves.toBe('totp');
      });

      it(`rejects a code ${DRIFT_STEPS + 1} step(s) ahead of the clock`, async () => {
        clock.set(START_MS - (DRIFT_STEPS + 1) * STEP_MS);

        await expect(mfa.verify(userId, code)).resolves.toBeNull();
      });

      /**
       * The clock is the only thing that moved in the four assertions above. This is the control:
       * with the clock exactly where it was, a code from a seed nobody enrolled is refused — so
       * "accepted" above means the seed matched, not that the verifier waves everything through.
       */
      it('rejects a well-formed code from another account’s seed', async () => {
        await expect(mfa.verify(userId, strangersCode)).resolves.toBeNull();
      });

      it('rejects a code for an account that never enrolled', async () => {
        const { userId: stranger } = await seed();

        await expect(mfa.verify(stranger, code)).resolves.toBeNull();
      });
    });

    describe('a recovery code', () => {
      it('is accepted once', async () => {
        const { recoveryCodes, userId } = await enrol();

        await expect(mfa.verify(userId, recoveryCodes[0]!)).resolves.toBe('recovery');
      });

      /** Criterion 8's "one-time", and the single most important assertion in this file. */
      it('is refused the second time', async () => {
        const { recoveryCodes, userId } = await enrol();

        await mfa.verify(userId, recoveryCodes[0]!);

        await expect(mfa.verify(userId, recoveryCodes[0]!)).resolves.toBeNull();
      });

      it('is marked consumed rather than deleted, so the burn is auditable', async () => {
        const { recoveryCodes, userId } = await enrol();

        await mfa.verify(userId, recoveryCodes[0]!);

        const rows = await recoveryRows(userId);
        const consumed = rows.filter((row) => row.consumedAt !== null);

        expect(rows).toHaveLength(10);
        expect(consumed).toHaveLength(1);
        expect(consumed[0]!.consumedAt).toEqual(new Date(START_MS));
      });

      /** Burning one is not burning the rest — nine remain, and the tenth is not one of them. */
      it('leaves the other nine working', async () => {
        const { recoveryCodes, userId } = await enrol();

        await mfa.verify(userId, recoveryCodes[0]!);

        for (const code of recoveryCodes.slice(1)) {
          await expect(mfa.verify(userId, code)).resolves.toBe('recovery');
        }
        // Nine codes, each compared against the digests still live when its turn comes — about
        // fifty Argon2id verifications at 64 MB. Asserting all nine is the point of the test, so
        // the budget is raised rather than the loop shortened.
      }, 120_000);

      /**
       * The codes are per account. Without the `user_id` predicate the lookup would be "is this
       * anybody's recovery code", which one leaked code turns into a key to every account.
       */
      it('does not work on another account', async () => {
        const mine = await enrol();
        const theirs = await enrol();

        await expect(mfa.verify(theirs.userId, mine.recoveryCodes[0]!)).resolves.toBeNull();
      });

      /** Users type what they were shown, in whatever case their keyboard was in. */
      it('is accepted with the case and spacing a user retypes it in', async () => {
        const { recoveryCodes, userId } = await enrol();

        await expect(mfa.verify(userId, ` ${recoveryCodes[0]!.toUpperCase()} `)).resolves.toBe(
          'recovery',
        );
      });
    });

    /**
     * The second leg of a sign-in (T21, criterion 4). The password leg leaves a half-authenticated
     * session; this is what turns it into a real one, or refuses to.
     */
    describe('the login challenge', () => {
      /** Enrol an account and put it in the state the password leg leaves it in. */
      async function challenged(): Promise<{
        otpauthUri: string;
        recoveryCodes: readonly string[];
        token: string;
        userId: string;
      }> {
        const { otpauthUri, recoveryCodes, userId } = await enrol();
        const { token } = await sessions.create(userId, undefined, {
          pendingMfa: true,
          ttlSeconds: 300,
        });

        return { otpauthUri, recoveryCodes, token, userId };
      }

      it('completes with a TOTP code and hands back a session', async () => {
        const { otpauthUri, token, userId } = await challenged();

        const completed = await mfa.completeChallenge(token, codeAt(otpauthUri, START_MS));

        expect(completed.user.id).toBe(userId);
        expect(completed.session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      });

      /**
       * §11 calls completing a challenge a privilege change, and criterion 5 rotates on one. The
       * value the client held while it could do nothing must not be the value it holds afterwards:
       * a cookie fixed on a shared machine before the challenge would otherwise still be live.
       */
      it('rotates the session identifier, retiring the one the challenge was answered on', async () => {
        const { otpauthUri, token } = await challenged();

        const completed = await mfa.completeChallenge(token, codeAt(otpauthUri, START_MS));

        expect(completed.session.token).not.toBe(token);
        await expect(sessions.authenticate(token)).resolves.toBeNull();
      });

      it('leaves a session that is authenticated rather than pending', async () => {
        const { otpauthUri, token } = await challenged();

        const completed = await mfa.completeChallenge(token, codeAt(otpauthUri, START_MS));

        await expect(sessions.authenticate(completed.session.token)).resolves.toMatchObject({
          pendingMfa: false,
        });
      });

      /**
       * The factor just presented is the proof `StepUpGuard` asks for. Without this a user who
       * signed in ten seconds ago would be told to present a code before removing MFA, which is
       * the code they just presented.
       */
      it('counts as a step-up, so the factor just presented is not asked for twice', async () => {
        const { otpauthUri, token } = await challenged();

        const completed = await mfa.completeChallenge(token, codeAt(otpauthUri, START_MS));

        await expect(sessions.authenticate(completed.session.token)).resolves.toMatchObject({
          steppedUpAt: START,
        });
      });

      it('completes with a recovery code just as well', async () => {
        const { recoveryCodes, token, userId } = await challenged();

        const completed = await mfa.completeChallenge(token, recoveryCodes[0]!);

        expect(completed.user.id).toBe(userId);
      });

      /** Criterion 8's "one-time", over the challenge rather than over the service call. */
      it('refuses a recovery code that has already been spent', async () => {
        const first = await challenged();

        await mfa.completeChallenge(first.token, first.recoveryCodes[0]!);

        const { token } = await sessions.create(first.userId, undefined, {
          pendingMfa: true,
          ttlSeconds: 300,
        });

        const refusal = await refusalOf(mfa.completeChallenge(token, first.recoveryCodes[0]!));

        expect(refusal.type).toBe('unauthorized');
      });

      /**
       * A wrong code is `unauthorized`, not the `mfa-code-incorrect` a signed-in caller gets.
       * Nobody is signed in yet, and the two failures a caller can reach here — wrong password,
       * wrong code — must not be told apart by anyone sorting responses.
       */
      it('refuses a wrong code without saying what was wrong with it', async () => {
        const { token } = await challenged();

        const refusal = await refusalOf(mfa.completeChallenge(token, '000000'));

        expect(refusal.type).toBe('unauthorized');
      });

      it('leaves the challenge answerable after a wrong code, because typos happen', async () => {
        const { otpauthUri, token } = await challenged();

        await refusalOf(mfa.completeChallenge(token, '000000'));

        await expect(
          mfa.completeChallenge(token, codeAt(otpauthUri, START_MS)),
        ).resolves.toBeDefined();
      });

      /**
       * But not indefinitely. Six digits is a million guesses and the window is minutes, so an
       * unbounded challenge is a guessing budget rather than a factor.
       */
      it('throws the challenge away once the attempts are spent', async () => {
        const { otpauthUri, token } = await challenged();

        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
          await refusalOf(mfa.completeChallenge(token, '000000'));
        }

        // Even the *right* code now: the session it was bound to is gone.
        await refusalOf(mfa.completeChallenge(token, codeAt(otpauthUri, START_MS)));
        await expect(sessions.authenticate(token)).resolves.toBeNull();
      });

      /** Single use. The token that answered a challenge cannot answer a second one. */
      it('cannot be answered twice with the same session token', async () => {
        const { otpauthUri, token } = await challenged();
        const code = codeAt(otpauthUri, START_MS);

        await mfa.completeChallenge(token, code);

        const refusal = await refusalOf(mfa.completeChallenge(token, code));

        expect(refusal.type).toBe('unauthorized');
      });

      /**
       * And a *full* session cannot be run through it. Otherwise any signed-in caller could rotate
       * their own identifier and stamp a step-up by replaying a code, which is the step-up
       * requirement answered by the thing it is supposed to gate.
       */
      it('refuses a session that was never awaiting a factor', async () => {
        const { otpauthUri, userId } = await enrol();
        const { token } = await sessions.create(userId);

        const refusal = await refusalOf(mfa.completeChallenge(token, codeAt(otpauthUri, START_MS)));

        expect(refusal.type).toBe('unauthorized');
      });

      it('refuses a token that is not a session at all', async () => {
        const refusal = await refusalOf(mfa.completeChallenge('not-a-session-token', '000000'));

        expect(refusal.type).toBe('unauthorized');
      });
    });

    /** Step-up re-authentication (T21, criterion 12). */
    describe('stepping up', () => {
      it('stamps the caller’s session when the code is right', async () => {
        const { otpauthUri, userId } = await enrol();
        const { token } = await sessions.create(userId);
        const sessionId = (await sessions.authenticate(token))!.sessionId;

        await mfa.stepUp(sessionId, userId, codeAt(otpauthUri, START_MS));

        await expect(sessions.authenticate(token)).resolves.toMatchObject({ steppedUpAt: START });
      });

      it('accepts a recovery code, and spends it', async () => {
        const { recoveryCodes, userId } = await enrol();
        const { token } = await sessions.create(userId);
        const sessionId = (await sessions.authenticate(token))!.sessionId;

        await mfa.stepUp(sessionId, userId, recoveryCodes[0]!);

        await expect(sessions.authenticate(token)).resolves.toMatchObject({ steppedUpAt: START });
        await expect(mfa.verify(userId, recoveryCodes[0]!)).resolves.toBeNull();
      });

      /**
       * `mfa-code-incorrect`, not `unauthorized`: this caller *is* signed in, and a 401 would tell
       * their client the session had died over a mistyped code.
       */
      it('refuses a wrong code without disturbing the session', async () => {
        const { userId } = await enrol();
        const { token } = await sessions.create(userId);
        const sessionId = (await sessions.authenticate(token))!.sessionId;

        const refusal = await refusalOf(mfa.stepUp(sessionId, userId, '000000'));

        expect(refusal.type).toBe('mfa-code-incorrect');
        await expect(sessions.authenticate(token)).resolves.toMatchObject({ steppedUpAt: null });
      });
    });

    describe('turning MFA off', () => {
      it('clears the seed and every recovery code', async () => {
        const { userId } = await enrol();

        await mfa.disable(userId);

        expect((await userRow(userId))?.mfaSecretEnc).toBeNull();
        await expect(recoveryRows(userId)).resolves.toHaveLength(0);
        await expect(mfa.isEnrolled(userId)).resolves.toBe(false);
      });

      /** The codes go with the seed. One left behind is a second factor nobody knows still exists. */
      it('leaves no recovery code working afterwards', async () => {
        const { recoveryCodes, userId } = await enrol();

        await mfa.disable(userId);

        await expect(mfa.verify(userId, recoveryCodes[0]!)).resolves.toBeNull();
      });

      it('refuses for an account that has no MFA to remove', async () => {
        const { userId } = await seed();

        const refusal = await refusalOf(mfa.disable(userId));

        expect(refusal.type).toBe('conflict');
      });
    });

    /**
     * §11 and spec 001's "never do" list: no MFA seed and no recovery code in a log line, even at
     * `trace`. Asserted against every level, because the one that leaks is always the one nobody
     * thought was on in production.
     */
    describe('what it writes to the log', () => {
      const written: string[] = [];

      beforeEach(() => {
        written.length = 0;

        for (const level of ['debug', 'error', 'log', 'verbose', 'warn'] as const) {
          vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
            written.push(args.map((part) => String(part)).join(' '));
          });
        }
      });

      afterEach(() => {
        vi.restoreAllMocks();
      });

      it('names neither the seed nor a recovery code through a whole lifecycle', async () => {
        const { userId } = await seed();
        const { otpauthUri } = await mfa.beginEnrolment(userId);
        const seedInUri = new URL(otpauthUri.replace('otpauth://', 'https://')).searchParams.get(
          'secret',
        )!;
        const { recoveryCodes } = await mfa.confirmEnrolment(userId, codeAt(otpauthUri, START_MS));

        await mfa.verify(userId, codeAt(otpauthUri, START_MS));
        await mfa.verify(userId, recoveryCodes[0]!);
        await mfa.verify(userId, '000000');
        await mfa.disable(userId);

        const everything = written.join('\n');

        expect(everything).not.toContain(seedInUri);
        expect(everything).not.toContain('otpauth://');

        for (const code of recoveryCodes) {
          expect(everything).not.toContain(code);
        }
      });
    });
  });
});

/**
 * The one thing worth asserting without Postgres: that the pending-enrolment key is namespaced and
 * derived from the user id, so a machine with no Docker still fails on a key that collides with the
 * session keyspace `session.service.ts` owns.
 */
describe('pendingEnrolmentKey', () => {
  it('namespaces the pending seed away from the session keys', () => {
    const id = randomUUID();

    expect(pendingEnrolmentKey(id)).toBe(`mfa:enrol:${id}`);
  });

  it('refuses anything that is not a user id', () => {
    expect(() => pendingEnrolmentKey('*')).toThrow(TypeError);
  });
});
