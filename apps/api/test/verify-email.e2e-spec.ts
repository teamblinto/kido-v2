import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  EMAIL_VERIFIED,
  VERIFICATION_RESEND_ACCEPTED,
  type ProblemDetail,
  problemDetailSchema,
  signedInResponseSchema,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { eq, inArray } from 'drizzle-orm';
import { randomInt, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { CLOCK } from '../src/common/clock/clock.port';
import { FakeClock } from '../src/common/clock/fake-clock';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../src/modules/identity/password/breached-password.port';
import { InMemoryMailer } from '../src/modules/mail/in-memory.mailer';
import { MAILER } from '../src/modules/mail/mailer.port';
import { unsafe } from './support/csrf-client';
import { awaitMail } from './support/mail';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  // Off by default under test — one outbox table, one queue Redis, many parallel workers. This
  // suite reads mail, so it relays and drains under the outbox suite lock (spec 006).
  process.env.RUN_PROFILES = 'api,agent,events,cron';
  // Three free requests, then a delay, so the bucket trips inside a test through the real route.
  process.env.VERIFICATION_RESEND_ACCOUNT_BURST = '2';
  process.env.VERIFICATION_RESEND_DECAY_SECONDS = '60';
  process.env.VERIFICATION_RESEND_DELAY_SECONDS = '4';
  process.env.VERIFICATION_RESEND_IP_BURST = '50';
  process.env.VERIFICATION_RESEND_MAX_DELAY_SECONDS = '16';
});

/**
 * The wait for the outbox suite lock is inside `beforeAll`, and it is a wait behind every other
 * suite that relays — `password.e2e-spec.ts`'s measurement among them — so the hook's budget is
 * the serialised suites', not this one's boot.
 */
const LOCKED_BOOT_TIMEOUT_MS = 600_000;

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const LOGIN = '/api/v1/auth/login';
const RESEND = '/api/v1/auth/verify/resend';
const SIGNUP = '/api/v1/auth/signup';
const VERIFY = '/api/v1/auth/verify';

const PASSWORD = 'thermos-quibble-tundra-vellum';
const START = '2026-08-16T10:00:00.000Z';
const HOUR_MS = 60 * 60 * 1_000;
const TWENTY_FOUR_HOURS_MS = 24 * HOUR_MS;

const problem = (slug: string): string => `https://forge.dev/problems/${slug}`;

/**
 * The refusal body, parsed through the schema a client would parse it with rather than cast.
 *
 * That makes criterion 17 an assertion on every refusal this file makes, instead of on the one test
 * that spells the members out: a 400 carrying a `type` and nothing else would satisfy `.type` and
 * fail here.
 */
function problemOf(response: request.Response): ProblemDetail {
  return problemDetailSchema.parse(response.body);
}

/** `198.21/16`, distinct from the ranges the two login suites claim against the same Redis. */
const RUN = randomInt(0, 256);
let issuedAddresses = 0;

function nextClientAddress(): string {
  issuedAddresses += 1;

  return `198.21.${RUN}.${issuedAddresses % 256}`;
}

/** The adapter fails open on a network error (ADR 008), so it is driven rather than reached. */
class ScriptedBreachPort implements BreachedPasswordPort {
  isBreached(_password: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}

describe('Email verification (e2e)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and Redis', () => {
    let app: INestApplication;
    let database: ForgeDatabase;
    let mailer: InMemoryMailer;
    let suiteLock: { release: () => Promise<void> } | undefined;
    let clock: FakeClock;
    const minted = new Set<string>();

    function http(): request.Agent {
      return request(app.getHttpServer() as Server);
    }

    function mailbox(): string {
      const address = `t14e2e-${randomUUID()}@example.test`;

      minted.add(address);

      return address;
    }

    /**
     * The raw token as it actually reaches a user: out of the link in the mail, through the query
     * parameter, exactly as a browser would hand it back. Waited for, since the mail arrives
     * through the queue (spec 006).
     */
    async function linkedToken(email: string): Promise<string> {
      const message = await awaitMail(
        mailer,
        (candidate) => candidate.template === 'email-verification' && candidate.to === email,
      );
      const found = /[?&]token=([A-Za-z0-9_-]+)/.exec(message.text);

      return found?.[1] ?? expect.unreachable('no verification mail carrying a token was sent');
    }

    /** Register through the route, and hand back the link the mail carried. */
    async function signUp(email = mailbox()): Promise<{ email: string; token: string }> {
      await unsafe(http().post(SIGNUP))
        .set('User-Agent', 'forge-e2e/1.0')
        .send({ email, password: PASSWORD })
        .expect(202);

      return { email, token: await linkedToken(email) };
    }

    function verify(token: string): request.Test {
      return unsafe(http().post(VERIFY)).set('User-Agent', 'forge-e2e/1.0').send({ token });
    }

    function resend(email: string, ip = nextClientAddress()): request.Test {
      return unsafe(http().post(RESEND))
        .set('User-Agent', 'forge-e2e/1.0')
        .set('X-Forwarded-For', ip)
        .send({ email });
    }

    async function userFor(email: string) {
      const [row] = await database.select().from(schema.users).where(eq(schema.users.email, email));

      return row;
    }

    beforeAll(async () => {
      clock = new FakeClock(START);
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
      mailer = new InMemoryMailer();

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(MAILER)
        .useValue(mailer)
        .overrideProvider(BREACHED_PASSWORD_PORT)
        .useValue(new ScriptedBreachPort())
        .overrideProvider(CLOCK)
        .useValue(clock)
        .compile();

      app = moduleRef.createNestApplication();
      configureApplication(app);
      await app.init();

      database = app.get<ForgeDatabase>(APP_DATABASE);
    }, LOCKED_BOOT_TIMEOUT_MS);

    beforeEach(() => {
      clock.set(START);
      mailer.clear();
    });

    afterAll(async () => {
      if (minted.size > 0) {
        await database.delete(schema.users).where(inArray(schema.users.email, [...minted]));
      }

      await app?.close();
      await suiteLock?.release();
    });

    /**
     * Criterion 2 end to end: the mail signup sends carries a link, and the link works. T13 deferred
     * this mail to T14 because T14 owns the token in it — until now the "confirm your address" mail
     * was a template nothing sent.
     */
    describe('the link signup mails', () => {
      it('is sent to the address that registered', async () => {
        const { email } = await signUp();

        expect((await awaitMail(mailer, (message) => message.to === email)).template) //
          .toBe('email-verification');
      });

      it('confirms the address exactly once', async () => {
        const { email, token } = await signUp();

        const response = await verify(token).expect(200);

        expect(response.body).toEqual({ status: EMAIL_VERIFIED });
        expect((await userFor(email))!.emailVerifiedAt).not.toBeNull();
      });

      /**
       * The verified state has to be visible to the client that has to act on it — §11 makes an
       * unverified account usable but bars it from creating sandboxes, and `signedInResponseSchema`
       * carries the flag so the client can say so without a second round trip.
       */
      it('is reflected in the next sign-in', async () => {
        const { email, token } = await signUp();

        await verify(token).expect(200);

        const response = await unsafe(http().post(LOGIN))
          .set('User-Agent', 'forge-e2e/1.0')
          // From this suite's own range. Without it the request is `127.0.0.1`, whose login-IP
          // bucket is shared with every other e2e file running in a parallel worker against the
          // same Redis — and this suite's frozen clock means nothing it finds there ever decays.
          .set('X-Forwarded-For', nextClientAddress())
          .send({ email, password: PASSWORD })
          .expect(200);

        // The signed-in arm specifically, not the union. This account has no second factor, so a
        // login that answered `mfa_required` would be a bug — and parsing against the union would
        // accept it and then have no `user` to read.
        expect(signedInResponseSchema.parse(response.body).user.emailVerified).toBe(true);
      });
    });

    /**
     * The three distinct slugs, as RFC 9457 documents over the wire (criterion 17). This is the test
     * that would catch a refactor collapsing them into one `bad-request`.
     */
    describe('the three ways a link is dead', () => {
      it('answers a replayed link with token-already-used', async () => {
        const { token } = await signUp();

        await verify(token).expect(200);

        const response = await verify(token).expect(400);

        expect(problemOf(response).type).toBe(problem('token-already-used'));
      });

      it('answers an expired link with token-expired', async () => {
        const { token } = await signUp();

        clock.advance(TWENTY_FOUR_HOURS_MS);

        const response = await verify(token).expect(400);

        expect(problemOf(response).type).toBe(problem('token-expired'));
      });

      it('still confirms with one millisecond of the window left', async () => {
        const { token } = await signUp();

        clock.advance(TWENTY_FOUR_HOURS_MS - 1);

        await verify(token).expect(200);
      });

      it('answers a link nobody minted with token-invalid', async () => {
        const response = await verify('Zm9yZ2Utbm90LWEtdG9rZW4tYXQtYWxsLWhvbmVzdA').expect(400);

        expect(problemOf(response).type).toBe(problem('token-invalid'));
      });

      it('gives all three a distinct type, which is the whole point of having three', async () => {
        const { token } = await signUp();
        const { token: expiring } = await signUp();

        await verify(token).expect(200);
        clock.advance(TWENTY_FOUR_HOURS_MS);

        const types = await Promise.all(
          [token, expiring, 'Zm9yZ2Utbm90LWEtdG9rZW4tYXQtYWxsLWhvbmVzdA'].map(async (candidate) =>
            verify(candidate)
              .expect(400)
              .then((response) => problemOf(response).type),
          ),
        );

        expect(new Set(types).size).toBe(3);
      });

      /**
       * A complete document, not just a status with a slug in it. `problemOf` is what asserts the
       * shape — `problemDetailSchema` already requires a non-empty `detail`, `title` and
       * `requestId`, so parsing throws on a half-built document — and this test names the three
       * members whose *values* the schema cannot check.
       */
      it('answers each of them with a complete RFC 9457 document', async () => {
        const response = await verify('Zm9yZ2Utbm90LWEtdG9rZW4tYXQtYWxsLWhvbmVzdA').expect(400);
        const document = problemOf(response);

        expect(document.instance).toBe(VERIFY);
        expect(document.status).toBe(400);
        expect(document.type).toBe(problem('token-invalid'));
      });
    });

    describe('an address changed after the link was sent', () => {
      it('refuses the outstanding link and leaves the account unverified', async () => {
        const { email, token } = await signUp();
        const moved = mailbox();

        await database
          .update(schema.users)
          .set({ email: moved })
          .where(eq(schema.users.email, email));

        const response = await verify(token).expect(400);

        expect(problemOf(response).type).toBe(problem('verification-address-changed'));
        expect((await userFor(moved))!.emailVerifiedAt).toBeNull();
      });
    });

    describe('resending', () => {
      it('answers 202 with the one constant body', async () => {
        const { email } = await signUp();

        const response = await resend(email).expect(202);

        expect(response.body).toEqual({ status: VERIFICATION_RESEND_ACCEPTED });
      });

      it('mails a link that works', async () => {
        const { email } = await signUp();

        mailer.clear();
        // Past the hour: the same template to the same address inside one hour is one job (spec
        // 006 §10 dedupe), so a resend on the heels of signup would be collapsed into it.
        clock.advance(HOUR_MS);
        await resend(email).expect(202);
        await verify(await linkedToken(email)).expect(200);

        expect((await userFor(email))!.emailVerifiedAt).not.toBeNull();
      });

      /**
       * Enumeration safety, over HTTP and against the bytes rather than against the shape. Signup
       * declines to say whether an address has an account (ADR 007); an endpoint that answered the
       * question here would hand it back through a second route.
       */
      it('answers identically for an address with no account', async () => {
        const { email } = await signUp();

        const known = await resend(email).expect(202);
        const unknown = await resend(mailbox()).expect(202);

        expect(unknown.body).toEqual(known.body);
        expect(unknown.status).toBe(known.status);
      });

      it('answers identically for an address already confirmed', async () => {
        const { email, token } = await signUp();

        await verify(token).expect(200);

        const response = await resend(email).expect(202);

        expect(response.body).toEqual({ status: VERIFICATION_RESEND_ACCEPTED });
      });

      it('throttles per address, with a Retry-After a client can act on', async () => {
        const { email } = await signUp();

        // The account bucket is charged by the send signup already made, so this exhausts what is
        // left of it from a different address each time — the per-IP bucket must not be what trips.
        for (let sent = 0; sent < 3; sent += 1) {
          await resend(email);
        }

        const response = await resend(email).expect(429);

        expect(problemOf(response).type).toBe(problem('rate-limited'));
        expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
      });

      /** The refusal must not depend on whether the address exists, or the 429 becomes the oracle. */
      it('throttles an address with no account the same way', async () => {
        const unknown = mailbox();

        for (let sent = 0; sent < 3; sent += 1) {
          await resend(unknown);
        }

        await resend(unknown).expect(429);
      });
    });

    /**
     * §05 and criterion 18: the raw token reaches the link in the mail and nothing else. The
     * response is the one place a token could leak that no scrubber would ever see, because it is
     * not a log line — `verifyEmailResponseSchema` is a strict object for this reason and this is
     * the assertion that the wire agrees with it.
     */
    describe('what the responses carry', () => {
      it('never echoes the token, on success or on refusal', async () => {
        const { token } = await signUp();

        const confirmed = await verify(token).expect(200);
        const replayed = await verify(token).expect(400);

        expect(JSON.stringify(confirmed.body)).not.toContain(token);
        expect(JSON.stringify(replayed.body)).not.toContain(token);
      });

      it('never carries the address a resend was asked for', async () => {
        const { email } = await signUp();

        const response = await resend(email).expect(202);

        expect(JSON.stringify(response.body)).not.toContain(email);
      });
    });
  });
});
