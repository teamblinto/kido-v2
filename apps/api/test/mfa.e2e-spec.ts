import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { MFA_DISABLED, MFA_REQUIRED, MFA_STEPPED_UP } from '@repo/contracts';
import { schema } from '@repo/db';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { Secret, TOTP } from 'otpauth';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { CLOCK } from '../src/common/clock/clock.port';
import { FakeClock } from '../src/common/clock/fake-clock';
import { throttleKey } from '../src/common/ratelimit/redis-throttler.storage';
import type { Environment } from '../src/config/environment';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import { PasswordHasher } from '../src/modules/identity/password/hasher';
import { sessionKey } from '../src/modules/identity/services/session.service';
import { unsafe } from './support/csrf-client';
import { openClient } from './support/integration-redis';

/**
 * The step-up window and the challenge budget this suite drives, set through the environment
 * because that is how the application is configured — the wiring is under test rather than
 * bypassed. Hoisted, because `ConfigModule.forRoot` validates while the module graph is built.
 *
 * The per-IP login burst is loose for the reason `login.e2e-spec.ts` gives: every request here
 * arrives from one test runner, and a tight address bucket would refuse assertions for the wrong
 * reason.
 */
const STEP_UP_WINDOW_SECONDS = 300;
const MAX_CHALLENGE_ATTEMPTS = 3;

vi.hoisted(() => {
  process.env.LOGIN_THROTTLE_IP_BURST = '400';
  process.env.MFA_CHALLENGE_MAX_ATTEMPTS = '3';
  process.env.MFA_CHALLENGE_TTL_SECONDS = '300';
  process.env.MFA_STEP_UP_TTL_SECONDS = '300';
  process.env.MFA_TOTP_DRIFT_STEPS = '1';
  process.env.MFA_TOTP_PERIOD_SECONDS = '30';
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
});

/**
 * Every test here enrols an account, and enrolling writes ten Argon2id digests at 64 MB before the
 * test has asserted anything; a challenge answered with a recovery code costs up to ten more
 * verifications at the same price. Vitest's five-second default is comfortable for that work alone
 * and is not comfortable for it running in a worker beside the rest of the suite — so the budget is
 * raised for the file rather than the assertions being thinned to fit inside it.
 *
 * These are cost ceilings, not waits. Nothing here sleeps: the clock is fake, and every test takes
 * exactly as long as the hashing it asks for.
 */
vi.setConfig({ hookTimeout: 120_000, testTimeout: 120_000 });

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

/** A whole multiple of the thirty-second period, so counter arithmetic is exact. */
const START = '2026-08-16T10:00:00.000Z';
const START_MS = Date.parse(START);

const PASSWORD = 'correct horse battery staple';
const LOGIN = '/api/v1/auth/login';
const ENROL = '/api/v1/auth/mfa/totp';
const CONFIRM = '/api/v1/auth/mfa/totp/confirm';
const CHALLENGE = '/api/v1/auth/mfa/challenge';
const STEP_UP = '/api/v1/auth/mfa/step-up';

/** Everything the suite invents, so `afterAll` can name the throttle records it left behind. */
const minted = { addresses: new Set<string>(), mailboxes: new Set<string>() };
const RUN = randomInt(0, 256);

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface ParsedCookie {
  readonly name: string;
  readonly value: string;
}

function setCookies(response: request.Response): ParsedCookie[] {
  const headers = response.headers as unknown as Record<string, string[] | undefined>;

  return (headers['set-cookie'] ?? []).map((header) => {
    const [pair] = header.split(';');
    const separator = pair!.indexOf('=');

    return { name: pair!.slice(0, separator), value: pair!.slice(separator + 1) };
  });
}

/** The session cookie a response set, failing loudly when it set none. */
function sessionCookie(response: request.Response, name: string): ParsedCookie {
  const cookie = setCookies(response).find((candidate) => candidate.name === name);

  return cookie ?? expect.unreachable(`no ${name} cookie on the response`);
}

describe('MFA login challenge and step-up (e2e)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and Redis', () => {
    let app: INestApplication;
    let database: ForgeDatabase;
    let hasher: PasswordHasher;
    let clock: FakeClock;
    let probe: Redis;
    let cookieName: string;
    const created: string[] = [];
    let addressCounter = 0;

    function http(): request.Agent {
      return request(app.getHttpServer() as Server);
    }

    /**
     * A client address per caller, out of a range no other suite claims and with a random third
     * octet per run: these files run in parallel workers against one Redis, and this suite drives a
     * fake clock, so a throttle record it abandons never decays on its own.
     */
    function nextClientAddress(): string {
      addressCounter += 1;

      const client = `198.21.${RUN}.${addressCounter % 256}`;

      minted.addresses.add(client);

      return client;
    }

    function mailbox(): string {
      const address = `t21-${randomUUID()}@example.test`;

      minted.mailboxes.add(address);

      return address;
    }

    /**
     * Every unsafe request here goes through `unsafe`, which presents the double-submit pair and
     * the `Origin` T17 now requires — the same two things the browser this stands in for sends.
     * The session cookie is passed alongside rather than set separately, because supertest's
     * `.set('Cookie', ...)` replaces rather than appends.
     */
    function post(path: string, body?: object, cookie?: ParsedCookie): request.Test {
      const pending = unsafe(
        http().post(path),
        cookie === undefined ? [] : [`${cookie.name}=${cookie.value}`],
      )
        .set('X-Forwarded-For', nextClientAddress())
        .set('User-Agent', 'forge-e2e/1.0');

      return body === undefined ? pending : pending.send(body);
    }

    /** `DELETE` is unsafe too, and `/auth/mfa/totp` is the only route this suite removes through. */
    function remove(path: string, cookie?: ParsedCookie): request.Test {
      return unsafe(
        http().delete(path),
        cookie === undefined ? [] : [`${cookie.name}=${cookie.value}`],
      );
    }

    async function seed(email: string): Promise<string> {
      const [user] = await database
        .insert(schema.users)
        .values({ email, passwordHash: await hasher.hash(PASSWORD) })
        .returning({ id: schema.users.id });

      created.push(user!.id);

      return user!.id;
    }

    /**
     * An account with MFA, enrolled over HTTP exactly as a user would — sign in, scan, confirm.
     *
     * Driving the T20 routes rather than reaching into the service is deliberate: the seed this
     * suite's codes are generated from is the one a phone would have read out of the QR code, so a
     * provisioning URI that stopped carrying a usable secret would fail here rather than nowhere.
     */
    async function enrolledAccount(): Promise<{
      email: string;
      recoveryCodes: string[];
      secret: Secret;
      userId: string;
    }> {
      const email = mailbox();
      const userId = await seed(email);
      const signedIn = await post(LOGIN, { email, password: PASSWORD }).expect(200);
      const cookie = sessionCookie(signedIn, cookieName);

      const started = await post(ENROL, undefined, cookie).expect(200);
      const otpauthUri = (started.body as { otpauthUri: string }).otpauthUri;
      const secret = Secret.fromBase32(
        new URL(otpauthUri.replace('otpauth://', 'https://')).searchParams.get('secret')!,
      );

      // Against the clock as it stands rather than against `START`. One test below deliberately
      // pushes the clock past the step-up window, and a helper that always signed codes at `START`
      // would then mint one outside the drift window and fail here for a reason that has nothing to
      // do with the test doing the asking.
      const confirmed = await post(CONFIRM, { code: totpNow(secret) }, cookie).expect(200);

      return {
        email,
        recoveryCodes: (confirmed.body as { recoveryCodes: string[] }).recoveryCodes,
        secret,
        userId,
      };
    }

    /** The code an authenticator app would show at `atMs`. */
    function totpAt(secret: Secret, atMs: number): string {
      return TOTP.generate({ period: 30, secret, timestamp: atMs });
    }

    /** The code a phone would show right now — "now" being wherever the fake clock is standing. */
    function totpNow(secret: Secret): string {
      return totpAt(secret, clock.now().getTime());
    }

    beforeAll(async () => {
      clock = new FakeClock(START);

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(CLOCK)
        .useValue(clock)
        .compile();

      app = moduleRef.createNestApplication();
      configureApplication(app);
      await app.init();

      database = app.get<ForgeDatabase>(APP_DATABASE);
      hasher = app.get(PasswordHasher);
      cookieName = app
        .get(ConfigService<Environment, true>)
        .get('SESSION_COOKIE_NAME', { infer: true });
      probe = openClient(process.env.REDIS_SESSION_URL!);
      await probe.connect();
    }, 120_000);

    /**
     * The clock is shared by the whole application under test, and two tests below deliberately
     * push it past the step-up window. Without this, the *next* test would enrol against a clock
     * five minutes ahead of where it thinks it is and fail somewhere unrelated to what it asserts.
     */
    beforeEach(() => {
      clock.set(START);
    });

    afterAll(async () => {
      for (const id of created) {
        // `mfa_recovery_codes` cascades on the user, so one delete clears both tables.
        await database.delete(schema.users).where(eq(schema.users.id, id));
      }

      // Named exactly rather than scanned for: §09 rules out a `SCAN` of this instance, and the
      // keys are derivable from what the suite invented.
      await probe.del(
        ...[...minted.mailboxes].map((address) => throttleKey('login-account', sha256(address))),
        ...[...minted.addresses].map((client) => throttleKey('login-ip', client)),
      );

      probe.disconnect();
      await app.close();
    }, 120_000);

    /** Criterion 4, over the wire: the password alone does not sign an MFA account in. */
    describe('signing in to an account with MFA', () => {
      it('answers mfa_required and names nobody', async () => {
        const { email, userId } = await enrolledAccount();

        const response = await post(LOGIN, { email, password: PASSWORD }).expect(200);

        expect(response.body).toEqual({ status: MFA_REQUIRED });
        expect(response.text).not.toContain(userId);
        expect(response.text).not.toContain(email);
      });

      /**
       * The half of criterion 4 that a body assertion cannot reach. The login does set a cookie —
       * the challenge has to be bound to something — so "no full session" is a claim about what
       * that cookie can *do*, and the only way to test it is to try to use it.
       */
      it('establishes no session that any guarded route will accept', async () => {
        const { email } = await enrolledAccount();

        const challenged = await post(LOGIN, { email, password: PASSWORD }).expect(200);
        const cookie = sessionCookie(challenged, cookieName);

        // A guarded route from another module entirely, so this is not a claim about the MFA
        // controller being careful — it is a claim about the guard.
        await post(ENROL, undefined, cookie).expect(401);
        await post(
          '/api/v1/auth/password/change',
          { currentPassword: PASSWORD, newPassword: 'x' },
          cookie,
        ) //
          .expect(401);
      });
    });

    /** The first of the four flows: challenge → TOTP → session. */
    describe('challenge → TOTP → session', () => {
      it('completes the sign-in and authenticates the session it hands back', async () => {
        const { email, secret, userId } = await enrolledAccount();

        const challenged = await post(LOGIN, { email, password: PASSWORD }).expect(200);
        const pending = sessionCookie(challenged, cookieName);

        const completed = await post(CHALLENGE, { code: totpAt(secret, START_MS) }, pending) //
          .expect(200);
        const session = sessionCookie(completed, cookieName);

        expect(completed.body).toEqual({
          user: { email, emailVerified: false, id: userId, mfaEnabled: true },
        });

        // The cookie it handed back is a real session: a guarded route accepts it.
        await post(STEP_UP, { code: totpAt(secret, START_MS) }, session).expect(200);
      });

      /**
       * §11's privilege change, and the fixation vector the task names. Asserted three ways,
       * because "it changed" alone would pass for a cookie that changed and still resolved to the
       * same live session: the value differs, the old hash is gone from Redis, and the old value no
       * longer authenticates anything.
       */
      it('rotates the session identifier, and the old one stops working', async () => {
        const { email, secret } = await enrolledAccount();

        const challenged = await post(LOGIN, { email, password: PASSWORD }).expect(200);
        const pending = sessionCookie(challenged, cookieName);

        const completed = await post(CHALLENGE, { code: totpAt(secret, START_MS) }, pending) //
          .expect(200);
        const session = sessionCookie(completed, cookieName);

        expect(session.value).not.toBe(pending.value);
        await expect(probe.exists(sessionKey(sha256(pending.value)))).resolves.toBe(0);
        await expect(probe.exists(sessionKey(sha256(session.value)))).resolves.toBe(1);

        // And the retired value is not merely absent from Redis — it is refused at the door.
        await post(STEP_UP, { code: totpAt(secret, START_MS) }, pending).expect(401);
      });

      /** The drift window reaches the wire, not just the service. */
      it('accepts a code from one step of drift and refuses one from two', async () => {
        const inside = await enrolledAccount();
        const outside = await enrolledAccount();

        const insideChallenge = sessionCookie(
          await post(LOGIN, { email: inside.email, password: PASSWORD }).expect(200),
          cookieName,
        );
        const outsideChallenge = sessionCookie(
          await post(LOGIN, { email: outside.email, password: PASSWORD }).expect(200),
          cookieName,
        );

        await post(CHALLENGE, { code: totpAt(inside.secret, START_MS - 30_000) }, insideChallenge) //
          .expect(200);
        await post(CHALLENGE, { code: totpAt(outside.secret, START_MS - 60_000) }, outsideChallenge) //
          .expect(401);
      });
    });

    /** The second: challenge → recovery code → session. */
    describe('challenge → recovery code → session', () => {
      it('completes the sign-in with a recovery code', async () => {
        const { email, recoveryCodes, userId } = await enrolledAccount();

        const pending = sessionCookie(
          await post(LOGIN, { email, password: PASSWORD }).expect(200),
          cookieName,
        );

        const completed = await post(CHALLENGE, { code: recoveryCodes[0] }, pending).expect(200);

        expect(completed.body).toEqual({
          user: { email, emailVerified: false, id: userId, mfaEnabled: true },
        });
        await expect(
          probe.exists(sessionKey(sha256(sessionCookie(completed, cookieName).value))),
        ).resolves.toBe(1);
      });

      it('rotates the identifier on this route too', async () => {
        const { email, recoveryCodes } = await enrolledAccount();

        const pending = sessionCookie(
          await post(LOGIN, { email, password: PASSWORD }).expect(200),
          cookieName,
        );
        const completed = await post(CHALLENGE, { code: recoveryCodes[0] }, pending).expect(200);

        expect(sessionCookie(completed, cookieName).value).not.toBe(pending.value);
      });
    });

    /** The third: a recovery code replayed is refused. */
    describe('a recovery code replayed', () => {
      it('is refused the second time, and signs nobody in', async () => {
        const { email, recoveryCodes } = await enrolledAccount();

        const first = sessionCookie(
          await post(LOGIN, { email, password: PASSWORD }).expect(200),
          cookieName,
        );

        await post(CHALLENGE, { code: recoveryCodes[0] }, first).expect(200);

        // A fresh sign-in, so the refusal below is about the code rather than about a spent session.
        const second = sessionCookie(
          await post(LOGIN, { email, password: PASSWORD }).expect(200),
          cookieName,
        );

        const replayed = await post(CHALLENGE, { code: recoveryCodes[0] }, second).expect(401);

        expect(replayed.body).toMatchObject({
          status: 401,
          type: 'https://forge.dev/problems/unauthorized',
        });
        // Nothing was promoted: the pending cookie is still pending, not a session.
        await post(ENROL, undefined, second).expect(401);
      });

      it('leaves the other nine codes working', async () => {
        const { email, recoveryCodes } = await enrolledAccount();

        const first = sessionCookie(
          await post(LOGIN, { email, password: PASSWORD }).expect(200),
          cookieName,
        );

        await post(CHALLENGE, { code: recoveryCodes[0] }, first).expect(200);

        const second = sessionCookie(
          await post(LOGIN, { email, password: PASSWORD }).expect(200),
          cookieName,
        );

        await post(CHALLENGE, { code: recoveryCodes[1] }, second).expect(200);
      });

      /** The challenge is not an unbounded guessing budget. */
      it('throws the challenge away after too many wrong codes', async () => {
        const { email, secret } = await enrolledAccount();

        const pending = sessionCookie(
          await post(LOGIN, { email, password: PASSWORD }).expect(200),
          cookieName,
        );

        for (let attempt = 0; attempt < MAX_CHALLENGE_ATTEMPTS; attempt += 1) {
          await post(CHALLENGE, { code: '000000' }, pending).expect(401);
        }

        // Even the right code, now: the session it was bound to is gone.
        await post(CHALLENGE, { code: totpAt(secret, START_MS) }, pending).expect(401);
        await expect(probe.exists(sessionKey(sha256(pending.value)))).resolves.toBe(0);
      });
    });

    /** The fourth: MFA removal without a step-up is refused. */
    describe('removing MFA', () => {
      /** Sign in and finish the challenge, leaving a full session. */
      async function signedInWithMfa(): Promise<{ cookie: ParsedCookie; secret: Secret }> {
        const { email, secret } = await enrolledAccount();
        const pending = sessionCookie(
          await post(LOGIN, { email, password: PASSWORD }).expect(200),
          cookieName,
        );
        const completed = await post(CHALLENGE, { code: totpAt(secret, START_MS) }, pending) //
          .expect(200);

        return { cookie: sessionCookie(completed, cookieName), secret };
      }

      /**
       * Criterion 12. The session is perfectly good — every other guarded route accepts it — and
       * this one still refuses, because the step-up the challenge stamped has expired.
       */
      it('answers 403 with step-up-required when the step-up has gone stale', async () => {
        const { cookie } = await signedInWithMfa();

        clock.advance((STEP_UP_WINDOW_SECONDS + 1) * 1_000);

        const refused = await remove(ENROL, cookie).expect(403);

        expect(refused.body).toMatchObject({
          status: 403,
          type: 'https://forge.dev/problems/step-up-required',
        });
        expect(refused.headers['content-type']).toMatch(/application\/problem\+json/);
      });

      /** And the session survives the refusal — a 403 here is not a sign-out. */
      it('leaves the caller signed in after refusing', async () => {
        const { cookie, secret } = await signedInWithMfa();

        clock.advance((STEP_UP_WINDOW_SECONDS + 1) * 1_000);

        await remove(ENROL, cookie).expect(403);

        await post(STEP_UP, { code: totpAt(secret, clock.now().getTime()) }, cookie).expect(200);
      });

      it('succeeds once the caller has stepped up', async () => {
        const { cookie, secret } = await signedInWithMfa();

        clock.advance((STEP_UP_WINDOW_SECONDS + 1) * 1_000);

        const steppedUp = await post(
          STEP_UP,
          { code: totpAt(secret, clock.now().getTime()) },
          cookie,
        ).expect(200);

        expect(steppedUp.body).toEqual({ status: MFA_STEPPED_UP });

        const removed = await remove(ENROL, cookie).expect(200);

        expect(removed.body).toEqual({ status: MFA_DISABLED });
      });

      /**
       * The challenge that signed the caller in *is* a recent second factor, so removing MFA
       * immediately after signing in does not ask for the code they just typed.
       */
      it('accepts the step-up the challenge itself performed', async () => {
        const { cookie } = await signedInWithMfa();

        await remove(ENROL, cookie).expect(200);
      });

      /** And afterwards the account signs in with a password alone again. */
      it('leaves the account without a second factor', async () => {
        const { email, secret } = await enrolledAccount();
        const pending = sessionCookie(
          await post(LOGIN, { email, password: PASSWORD }).expect(200),
          cookieName,
        );
        const completed = await post(CHALLENGE, { code: totpAt(secret, START_MS) }, pending) //
          .expect(200);
        const cookie = sessionCookie(completed, cookieName);

        await remove(ENROL, cookie).expect(200);

        const signedIn = await post(LOGIN, { email, password: PASSWORD }).expect(200);

        expect(signedIn.body).toMatchObject({ user: { email } });
      });

      it('refuses an unauthenticated caller before it ever considers step-up', async () => {
        await remove(ENROL).expect(401);
      });
    });
  });
});
