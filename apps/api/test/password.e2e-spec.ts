import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  PASSWORD_CHANGED,
  PASSWORD_RESET,
  PASSWORD_RESET_REQUESTED,
  type ProblemDetail,
  problemDetailSchema,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { eq, inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { CLOCK } from '../src/common/clock/clock.port';
import { FakeClock } from '../src/common/clock/fake-clock';
import { throttleKey } from '../src/common/ratelimit/redis-throttler.storage';
import { SESSION_REDIS } from '../src/common/redis/redis.constants';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../src/modules/identity/password/breached-password.port';
import { InMemoryMailer } from '../src/modules/mail/in-memory.mailer';
import { MAILER, type MailDelivery, type MailMessage } from '../src/modules/mail/mailer.port';
import { unsafe } from './support/csrf-client';
import { awaitMail } from './support/mail';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  // Off by default under test — one outbox table, one queue Redis, many parallel workers. This
  // suite reads mail, so it relays and drains under the outbox suite lock (spec 006).
  process.env.RUN_PROFILES = 'api,agent,events,cron';
  // Argon2id at the local floor. The timing comparison below measures the *endpoint*, and a reset
  // request does not hash anything — the cost that matters here is the mailer's, which this suite
  // supplies.
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  // Two free requests per address, so the bucket trips inside a test through the real route. The
  // per-IP bucket is loose: every request in this file arrives from the same runner, and the
  // address bucket is what the enumeration tests are about.
  process.env.PASSWORD_RESET_ACCOUNT_BURST = '2';
  process.env.PASSWORD_RESET_DECAY_SECONDS = '60';
  process.env.PASSWORD_RESET_DELAY_SECONDS = '4';
  process.env.PASSWORD_RESET_IP_BURST = '4000';
  process.env.PASSWORD_RESET_MAX_DELAY_SECONDS = '16';
  process.env.LOGIN_THROTTLE_ACCOUNT_BURST = '10';
  process.env.LOGIN_THROTTLE_IP_BURST = '4000';
});

/**
 * The wait for the outbox suite lock is inside `beforeAll`, and it is a wait behind every other
 * suite that relays — `password.e2e-spec.ts`'s measurement among them — so the hook's budget is
 * the serialised suites', not this one's boot.
 */
const LOCKED_BOOT_TIMEOUT_MS = 600_000;

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const CHANGE = '/api/v1/auth/password/change';
const CONFIRM = '/api/v1/auth/password/reset/confirm';
const LOGIN = '/api/v1/auth/login';
const REQUEST = '/api/v1/auth/password/reset';
const SIGNUP = '/api/v1/auth/signup';

const START = '2026-08-16T10:00:00.000Z';
const THIRTY_MINUTES_MS = 30 * 60 * 1_000;
const PASSWORD = 'thermos-quibble-tundra-vellum';
const CHOSEN = 'kestrel-oxbow-parapet-sundial';
const AGAIN = 'lantern-brisket-dovetail-marrow';

/**
 * How long the fake transport takes to accept a message, and the whole point of this file's mailer.
 *
 * A reset request for a known address sends a mail and one for an unknown address does not. If the
 * response waited for delivery, that difference would be a stopwatch an attacker reads to enumerate
 * accounts — a real provider is a network round trip, not the microsecond an in-memory fake costs,
 * so a test using a fast fake would report timing parity the deployment does not have.
 *
 * Eighty milliseconds is comfortably above the scheduler noise the medians sit in, so a response
 * that waits for this cannot land inside {@link TOLERANCE}.
 */
const MAIL_LATENCY_MS = 80;

/**
 * How many samples each side of the timing comparison gets, and how many are thrown away first.
 * Compared by median rather than mean, as in `login.e2e-spec.ts`: the distribution has a long right
 * tail and one outlier moves a mean further than the bug would.
 */
const SAMPLES = 15;
const WARM_UP = 3;

/**
 * The two bounds the medians have to sit inside, and why they are stated in milliseconds rather
 * than only as a ratio.
 *
 * A reset request costs single-digit milliseconds on a quiet machine — there is no Argon2id in it,
 * unlike the login comparison this is modelled on, where a ~70 ms base made a 25% ratio a
 * meaningful bound. Against a 6 ms base a ratio is mostly a report on the machine's mood, so the
 * assertion that carries the property is absolute.
 *
 * Absolute, but **relative to a noise floor measured in the same run** rather than fixed. The base
 * is only single-digit while nothing else is running: under `pnpm check` the same request measured
 * 84–126 ms with tails to match, and a bound calibrated against 6 ms fails there for reasons that
 * have nothing to do with the handler. `MAX_DIFFERENCE_MS` is therefore the difference this test
 * allows *on top of* what the machine demonstrably cannot resolve — see `noiseFloor` at the call
 * site, and the guard that fails the test outright rather than let the budget grow big enough to
 * hide a send.
 *
 * **What is measured and what is left.** With the mail dispatched off the request path, the two
 * branches differ by one thing: the branch with an account writes a `password_reset_tokens` row and
 * its two index entries, and the other writes nothing. That is about **1.2 ms** on this hardware,
 * measured directly — with the mail dispatch removed entirely the gap does not move. It is the
 * floor for any design that stores a token only for addresses that have an account, and closing it
 * would mean writing junk rows for strangers, which is an unbounded write amplifier aimed at our
 * own table. What the bounds below rule out is the difference that *is* fixable and that dwarfs it:
 * a response that waits for the transport, which is {@link MAIL_LATENCY_MS} and would be sixty
 * times larger. Since spec 006 no render happens on either branch: the request appends an outbox
 * row and the consumer mints and renders off the request path.
 */
const MAX_DIFFERENCE_MS = MAIL_LATENCY_MS / 4;

/** A generous ratio bound as a second net, calibrated to a residual measured at ~20% of a 6 ms base. */
const TOLERANCE = 0.4;

const problem = (slug: string): string => `https://forge.dev/problems/${slug}`;

function problemOf(response: request.Response): ProblemDetail {
  return problemDetailSchema.parse(response.body);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/**
 * The in-memory mailer with a transport that costs something.
 *
 * The message is recorded synchronously — a test that reads the link right after the request still
 * finds it — and only the *resolution* is delayed. So the delay is exactly what a caller who awaits
 * `send` would pay, and nothing else about the fake changes.
 */
class SlowMailer extends InMemoryMailer {
  private completed = 0;

  /**
   * How many sends have run to *completion* — the transport's promise resolved, not merely started.
   *
   * `deliveries` already counts the sends that began, because the record is written synchronously.
   * The difference between the two is the whole property: a handler that awaits delivery cannot
   * answer while this number is still behind, whatever the machine's speed.
   */
  get settledSends(): number {
    return this.completed;
  }

  override async send(message: MailMessage): Promise<MailDelivery> {
    const delivery = await super.send(message);

    await new Promise((resolve) => setTimeout(resolve, MAIL_LATENCY_MS));
    this.completed += 1;

    return delivery;
  }
}

/** The adapter fails open on a network error (ADR 008), so it is driven rather than reached. */
class ScriptedBreachPort implements BreachedPasswordPort {
  isBreached(_password: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/** `198.23/16`, distinct from the ranges the other e2e suites claim against the same Redis. */
const RUN = randomInt(0, 256);
let issuedAddresses = 0;

function nextClientAddress(): string {
  issuedAddresses += 1;

  // A random starting slot inside the /16 rather than a fixed sequence: this file runs in parallel
  // with the other e2e suites against one Redis, and a run that fails part way through leaves
  // throttle records a fixed sequence would walk straight back into. The suite issues more than 256
  // addresses, so the counter carries into the third octet.
  const slot = (RUN * 256 + issuedAddresses) % 65_536;

  return `198.23.${Math.floor(slot / 256)}.${slot % 256}`;
}

describe('Password change and reset (e2e)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and Redis', () => {
    let app: INestApplication;
    let database: ForgeDatabase;
    let mailer: SlowMailer;
    let suiteLock: { release: () => Promise<void> } | undefined;
    let clock: FakeClock;
    const minted = new Set<string>();

    function http(): request.Agent {
      return request(app.getHttpServer() as Server);
    }

    function mailbox(): string {
      const address = `t19e2e-${randomUUID()}@example.test`;

      minted.add(address);

      return address;
    }

    /** Register through the route, exactly as a user would. */
    async function signUp(email = mailbox()): Promise<string> {
      await unsafe(http().post(SIGNUP))
        .set('User-Agent', 'forge-e2e/1.0')
        .send({ email, password: PASSWORD })
        .expect(202);

      return email;
    }

    /**
     * A client: a session cookie of its own, established through the real login route.
     *
     * Two of these is what the "every session dead" assertion needs. The proof has to come from a
     * *second* client that was holding a session before the reset — not from a look at Redis, which
     * would only tell us what our own code just wrote.
     */
    async function signIn(email: string, password = PASSWORD): Promise<string> {
      const response = await unsafe(http().post(LOGIN))
        .set('User-Agent', 'forge-e2e/1.0')
        .set('X-Forwarded-For', nextClientAddress())
        .send({ email, password })
        .expect(200);

      const header = (response.headers['set-cookie'] ?? [])[0];

      return header!.split(';')[0]!;
    }

    function requestReset(email: string, ip = nextClientAddress()): request.Test {
      return unsafe(http().post(REQUEST))
        .set('User-Agent', 'forge-e2e/1.0')
        .set('X-Forwarded-For', ip)
        .send({ email });
    }

    /**
     * The raw token as it reaches a user: out of the link in the mail, as a browser hands it back.
     * Waited for, since the mail arrives through the queue (spec 006).
     */
    async function linkedToken(email: string): Promise<string> {
      const message = await awaitMail(
        mailer,
        (candidate) => candidate.template === 'password-reset' && candidate.to === email,
      );
      const found = /[?&]token=([A-Za-z0-9_-]+)/.exec(message.text);

      return found?.[1] ?? expect.unreachable('no password reset mail carrying a token was sent');
    }

    async function linkFor(email: string): Promise<string> {
      mailer.clear();
      await requestReset(email).expect(202);

      return linkedToken(email);
    }

    function confirm(token: string, password = CHOSEN): request.Test {
      return unsafe(http().post(CONFIRM))
        .set('User-Agent', 'forge-e2e/1.0')
        .send({ password, token });
    }

    function change(cookie: string, currentPassword: string, newPassword: string): request.Test {
      // The session cookie travels with the CSRF pair rather than in a second `.set('Cookie')`,
      // which would replace it (T17).
      return unsafe(http().post(CHANGE), [cookie])
        .set('User-Agent', 'forge-e2e/1.0')
        .send({ currentPassword, newPassword });
    }

    /**
     * A bounded pause for the cases that assert *nothing* arrives — the one outcome there is no
     * mail to wait on. Reading a mail that should arrive is `awaitMail`'s job.
     */
    async function settleMail(): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, MAIL_LATENCY_MS * 2));
    }

    async function userFor(email: string) {
      const [row] = await database.select().from(schema.users).where(eq(schema.users.email, email));

      return row;
    }

    beforeAll(async () => {
      clock = new FakeClock(START);
      mailer = new SlowMailer();
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');

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

      // The suite drives a fake clock, so a throttle record it abandons never decays: it would sit
      // in the shared instance for its whole TTL and greet the next run as history.
      const store = app.get<Redis>(SESSION_REDIS);
      const keys = [...minted].map((box) => throttleKey('password-reset-account', sha256(box)));

      if (keys.length > 0) {
        await store.del(...keys);
      }

      await app?.close();
      await suiteLock?.release();
    });

    /**
     * Criterion 7's first half, in the two halves an attacker can measure: what the endpoint says,
     * and how long it takes to say it. A constant body with a slower known branch is still an
     * account enumerator — the body is what a reviewer reads and the timing is what an attacker
     * reads.
     */
    describe('an address that has an account and one that does not', () => {
      it('answers both with byte-identical bodies', async () => {
        const known = await signUp();

        const withAccount = await requestReset(known).expect(202);
        const without = await requestReset(mailbox()).expect(202);

        expect(without.body).toEqual(withAccount.body);
        expect(without.status).toBe(withAccount.status);
        expect(withAccount.body).toEqual({ status: PASSWORD_RESET_REQUESTED });
      });

      it('answers an address that never registered with the same bytes again', async () => {
        const response = await requestReset(mailbox()).expect(202);

        expect(response.body).toEqual({ status: PASSWORD_RESET_REQUESTED });
      });

      it('never carries the address back', async () => {
        const email = await signUp();

        const response = await requestReset(email).expect(202);

        expect(JSON.stringify(response.body)).not.toContain(email);
      });

      /**
       * The timing half, measured rather than asserted.
       *
       * Samples are interleaved so that anything drifting over the run — a warming pool, a busy
       * machine — lands on both series equally, and compared by median so one outlier cannot carry
       * the result. Every sample uses a fresh mailbox and a fresh client address, so no throttle
       * record accumulates and every sample measures the same work.
       *
       * What gives this teeth is {@link SlowMailer}. The known branch sends a mail and the unknown
       * branch does not, and this suite's transport takes {@link MAIL_LATENCY_MS} to accept one. If
       * the endpoint ever waits for delivery — an `await` added to `dispatch`, a queue swapped in
       * synchronously — the known median moves by more than that, and no tolerance this side of
       * useless would hide it. The floor assertion is the other direction: both series have to be
       * *faster* than a send, or the endpoint is waiting for one.
       */
      it('takes indistinguishable time over both', async () => {
        const known: number[] = [];
        const unknown: number[] = [];
        const seeded: string[] = [];

        for (let sample = 0; sample < SAMPLES + WARM_UP; sample += 1) {
          seeded.push(await signUp());
        }

        // Each iteration's two timings, subtracted in place. See `paired` below for why the
        // difference is taken here rather than between the two medians at the end.
        const paired: number[] = [];

        for (let sample = 0; sample < SAMPLES + WARM_UP; sample += 1) {
          const elapsedFor: number[] = [];

          for (const [series, email] of [
            [known, seeded[sample]!],
            [unknown, mailbox()],
          ] as const) {
            const started = process.hrtime.bigint();

            await requestReset(email).expect(202);

            const elapsed = Number(process.hrtime.bigint() - started) / 1e6;

            elapsedFor.push(elapsed);

            // The first few are thrown away: they measure a cold pool and an unoptimised path, not
            // the branch under test.
            if (sample >= WARM_UP) {
              series.push(elapsed);
            }
          }

          if (sample >= WARM_UP) {
            paired.push(elapsedFor[0]! - elapsedFor[1]!);
          }
        }

        const knownMedian = median(known);
        const unknownMedian = median(unknown);
        const difference =
          Math.abs(knownMedian - unknownMedian) / Math.max(knownMedian, unknownMedian);

        /**
         * What this machine's noise is worth, measured in the same run rather than assumed.
         *
         * The odd and even samples of the *unknown* series are the same branch doing the same work,
         * so any difference between their medians is measurement noise by construction — the
         * resolution of this comparison, on this hardware, under whatever load is on it right now.
         * It is the exact analogue of the known-vs-unknown comparison, which also interleaves.
         *
         * This replaced a fixed 20 ms bound, and then a paired-difference version of one, both of
         * which failed under `pnpm check` while the handler was behaving perfectly. Neither was
         * measuring the handler. A quiet machine puts the reset at ~8 ms and resolves a 1.2 ms
         * difference easily; the same box with the web suite on its other cores puts it at ~100 ms
         * with tails to match, and no fixed millisecond bound is both meaningful there and
         * meaningful here. Pairing does not rescue it either: the two requests in an iteration are
         * sequential, so their delays are not the shared spike that pairing cancels — one run had
         * the *unknown* branch come out 25 ms slower than the known one, which is noise with a sign.
         *
         * So the bound is the noise floor plus the real difference §17 allows. It stays tight
         * exactly when the machine is quiet enough for tightness to mean something, and it never
         * silently becomes a no-op: the guard below fails the test outright if the floor has risen
         * far enough that a synchronous mail send could hide beneath it.
         */
        const evens = unknown.filter((_, index) => index % 2 === 0);
        const odds = unknown.filter((_, index) => index % 2 === 1);
        const noiseFloor = Math.abs(median(evens) - median(odds));
        const budget = noiseFloor + MAX_DIFFERENCE_MS;

        const pairedMedian = median(paired);

        // To stderr rather than through `console`, so the measurement is legible beside the
        // application's own log lines on stdout rather than buried in them.
        process.stderr.write(
          `\n[T19] mail transport ${MAIL_LATENCY_MS} ms · ` +
            `reset known ${knownMedian.toFixed(1)} ms · unknown ${unknownMedian.toFixed(1)} ms · ` +
            `paired ${pairedMedian.toFixed(1)} ms · noise floor ${noiseFloor.toFixed(1)} ms · ` +
            `budget ${budget.toFixed(1)} ms · ` +
            `difference ${(difference * 100).toFixed(1)}% of the larger (n=${SAMPLES} each)\n`,
        );

        // The measurement has to be able to see what it is looking for. If this machine's own noise
        // has grown to where a synchronous send would fit inside the budget, the comparison proves
        // nothing and says so, rather than passing because everything is equally slow.
        expect(
          budget,
          `noise floor ${noiseFloor.toFixed(1)} ms leaves no room to detect a ${MAIL_LATENCY_MS} ms ` +
            'send — the machine is too contended for this measurement to mean anything',
        ).toBeLessThan(MAIL_LATENCY_MS);

        // The assertion that carries the property: whatever separates the two branches, it is not
        // the mail. A response that awaited delivery would put MAIL_LATENCY_MS between them, which
        // is outside the budget on any machine this test agrees to run the comparison on.
        expect(Math.abs(knownMedian - unknownMedian)).toBeLessThan(budget);
        expect(difference).toBeLessThan(TOLERANCE);
        // That neither branch waited for the transport *at all* is asserted directly, and without a
        // stopwatch, by 'answers before the transport has accepted the message' below.

        await settleMail();
      }, 180_000);

      /**
       * The other half of the timing property, asserted directly rather than measured.
       *
       * The stopwatch above answers "are the two branches distinguishable"; this answers "does the
       * handler wait for the transport at all", which the two together are what §17 needs. Both
       * branches blocking on delivery would be indistinguishable from each other while advertising
       * the provider's latency to anyone timing the endpoint, so the second question is not implied
       * by the first.
       *
       * It used to be a third bound on the same medians — `knownMedian < MAIL_LATENCY_MS` — and
       * that was the wrong instrument. It reads as "the response was faster than a send", which is
       * only the same claim while the machine is quiet: under `pnpm check` the reset itself reached
       * 107 ms against an 80 ms transport and the assertion failed with the handler behaving
       * perfectly. {@link SlowMailer.settledSends} asks the question directly instead. The send has
       * started and has not finished, and no amount of load makes that true of a handler that
       * awaited it — nor does a fast machine make it true of one that did.
       */
      it('answers before the transport has accepted the message', async () => {
        const email = await signUp();

        // Let the verification mail signup just sent arrive, so the count below moves only for
        // the reset.
        await awaitMail(mailer, (message) => message.to === email);

        const startedBefore = mailer.to(email).length;

        await requestReset(email).expect(202);

        // Nothing has started: with spec 006 the request appends a row and renders nothing, so the
        // stronger form of "the response did not wait for the send" is "no send has begun".
        expect(mailer.to(email)).toHaveLength(startedBefore);

        // And it does arrive — accepted, not dropped.
        await awaitMail(
          mailer,
          (message) => message.template === 'password-reset' && message.to === email,
        );
      });

      it('mails a link only to the address that has an account', async () => {
        const known = await signUp();
        const orphan = mailbox();

        mailer.clear();
        await requestReset(orphan).expect(202);
        await settleMail();

        expect(mailer.to(orphan)).toHaveLength(0);

        await requestReset(known).expect(202);
        await awaitMail(mailer, (message) => message.to === known);

        expect(mailer.to(known)).toHaveLength(1);
      });

      /** The 429 must not become the oracle the 202 declines to be. */
      it('throttles an address with no account exactly as it throttles one with', async () => {
        const known = await signUp();
        const orphan = mailbox();

        for (let spent = 0; spent < 3; spent += 1) {
          await requestReset(known);
          await requestReset(orphan);
        }

        const refusedKnown = await requestReset(known).expect(429);
        const refusedOrphan = await requestReset(orphan).expect(429);

        expect(problemOf(refusedOrphan).type).toBe(problem('rate-limited'));
        expect(problemOf(refusedOrphan).type).toBe(problemOf(refusedKnown).type);
        expect(Number(refusedOrphan.headers['retry-after'])).toBeGreaterThan(0);
      });
    });

    describe('the reset link', () => {
      it('is stored as a hash, never as the token it mailed', async () => {
        const email = await signUp();
        const token = await linkFor(email);
        const user = await userFor(email);

        const [row] = await database
          .select()
          .from(schema.passwordResetTokens)
          .where(eq(schema.passwordResetTokens.userId, user!.id));

        expect(row!.tokenHash).toBe(sha256(token));
        expect(row!.tokenHash).not.toBe(token);
      });

      it('sets the new password', async () => {
        const email = await signUp();
        const token = await linkFor(email);

        const response = await confirm(token).expect(200);

        expect(response.body).toEqual({ status: PASSWORD_RESET });
        await signIn(email, CHOSEN);
      });

      it('leaves the old password unable to sign in', async () => {
        const email = await signUp();

        await confirm(await linkFor(email)).expect(200);

        await unsafe(http().post(LOGIN))
          .set('User-Agent', 'forge-e2e/1.0')
          .set('X-Forwarded-For', nextClientAddress())
          .send({ email, password: PASSWORD })
          .expect(401);
      });

      it('works exactly once', async () => {
        const email = await signUp();
        const token = await linkFor(email);

        await confirm(token).expect(200);

        const replayed = await confirm(token, AGAIN).expect(400);

        expect(problemOf(replayed).type).toBe(problem('token-already-used'));
      });

      it('expires thirty minutes after it was asked for', async () => {
        const email = await signUp();
        const token = await linkFor(email);

        clock.advance(THIRTY_MINUTES_MS);

        const response = await confirm(token).expect(400);

        expect(problemOf(response).type).toBe(problem('token-expired'));
      });

      it('still works with one millisecond of the window left', async () => {
        const email = await signUp();
        const token = await linkFor(email);

        clock.advance(THIRTY_MINUTES_MS - 1);

        await confirm(token).expect(200);
      });

      it('answers a token nobody minted with token-invalid', async () => {
        const response = await confirm('Zm9yZ2Utbm90LWEtdG9rZW4tYXQtYWxsLWhvbmVzdA').expect(400);

        expect(problemOf(response).type).toBe(problem('token-invalid'));
      });

      it('never echoes the token, on success or on refusal', async () => {
        const email = await signUp();
        const token = await linkFor(email);

        const spent = await confirm(token).expect(200);
        const replayed = await confirm(token).expect(400);

        expect(JSON.stringify(spent.body)).not.toContain(token);
        expect(JSON.stringify(replayed.body)).not.toContain(token);
      });

      /** A refused password must not burn the link; the user can fix it by typing a better one. */
      it('survives a password the policy refuses', async () => {
        const email = await signUp();
        const token = await linkFor(email);

        const refused = await confirm(token, 'password123456').expect(422);

        expect(problemOf(refused).type).toBe(problem('password-too-weak'));
        await confirm(token, CHOSEN).expect(200);
      });
    });

    /**
     * §11 and criterion 7's second half. The assertion comes from a **second client** holding a
     * session established before the reset, driven through the real HTTP surface — not from a look
     * at Redis, which would only confirm what our own code had just written.
     *
     * `POST /auth/password/change` is the guarded route it asks with, and the two refusals are what
     * make the proof exact: a live session with the wrong password is a `403`
     * (`current-password-incorrect`), and a session that no longer exists is a `401`. So the test
     * can show the session was alive before the reset and gone after it, from outside.
     */
    describe('completing a reset, seen from a second client', () => {
      it('kills a session the second client established before the reset', async () => {
        const email = await signUp();
        const second = await signIn(email);

        // The second client is signed in *now*: the guard let it through, and the 403 is the
        // password check refusing it — not the session.
        const before = await change(second, 'not the password', CHOSEN).expect(403);

        expect(problemOf(before).type).toBe(problem('current-password-incorrect'));

        await confirm(await linkFor(email)).expect(200);

        const after = await change(second, 'not the password', CHOSEN).expect(401);

        expect(problemOf(after).type).toBe(problem('unauthorized'));
      });

      it('kills every one of the second client’s sessions, not just the newest', async () => {
        const email = await signUp();
        const earlier = await signIn(email);
        const later = await signIn(email);

        await confirm(await linkFor(email)).expect(200);

        await change(earlier, PASSWORD, CHOSEN).expect(401);
        await change(later, PASSWORD, CHOSEN).expect(401);
      });

      /**
       * Including the session of whoever asked. "Every session" has no exception for the requester,
       * and a reset that spared theirs would spare the attacker's in exactly the case — a stolen
       * session used to request a reset — the wholesale revocation exists for.
       */
      it('kills the session the reset was requested from', async () => {
        const email = await signUp();
        const requester = await signIn(email);

        await requestReset(email).expect(202);
        await confirm(await linkedToken(email)).expect(200);

        await change(requester, PASSWORD, CHOSEN).expect(401);
      });

      it('leaves another account’s session alone', async () => {
        const mine = await signUp();
        const theirs = await signUp();
        const bystander = await signIn(theirs);

        await confirm(await linkFor(mine)).expect(200);

        // Still authenticated: the refusal is the password check, which only a live session reaches.
        await change(bystander, 'not the password', CHOSEN).expect(403);
      });

      it('hands the caller no session of its own', async () => {
        const email = await signUp();

        const response = await confirm(await linkFor(email)).expect(200);

        expect(response.headers['set-cookie']).toBeUndefined();
        expect(Object.keys(response.body as object)).toEqual(['status']);
      });
    });

    describe('changing a password', () => {
      it('requires the current one', async () => {
        const email = await signUp();
        const cookie = await signIn(email);

        const response = await change(cookie, 'not the password', CHOSEN).expect(403);

        expect(problemOf(response).type).toBe(problem('current-password-incorrect'));
      });

      it('leaves the password alone when the current one is wrong', async () => {
        const email = await signUp();
        const cookie = await signIn(email);

        await change(cookie, 'not the password', CHOSEN).expect(403);

        await signIn(email, PASSWORD);
      });

      it('replaces it when the current one is right', async () => {
        const email = await signUp();
        const cookie = await signIn(email);

        const response = await change(cookie, PASSWORD, CHOSEN).expect(200);

        expect(response.body).toEqual({ status: PASSWORD_CHANGED });
        await signIn(email, CHOSEN);
      });

      /** Criterion 7: every **other** session. The device doing the changing stays signed in. */
      it('keeps the session it was made on alive', async () => {
        const email = await signUp();
        const cookie = await signIn(email);

        await change(cookie, PASSWORD, CHOSEN).expect(200);

        // A 403 rather than a 401: the guard still resolves this session, and it is the password
        // check that refuses.
        await change(cookie, 'not the password', AGAIN).expect(403);
      });

      it('signs every other client out, asserted from the other client', async () => {
        const email = await signUp();
        const first = await signIn(email);
        const second = await signIn(email);

        // The second client is live before the change.
        await change(second, 'not the password', CHOSEN).expect(403);

        await change(first, PASSWORD, CHOSEN).expect(200);

        await change(second, 'not the password', AGAIN).expect(401);
      });

      /**
       * The CSRF pair is presented so that the refusal under test is the guard's. Without it the
       * request is refused a step earlier, with a 403, and this would be asserting T17 rather than
       * that a password change needs a session.
       */
      it('refuses an unauthenticated caller', async () => {
        const response = await unsafe(http().post(CHANGE))
          .set('User-Agent', 'forge-e2e/1.0')
          .send({ currentPassword: PASSWORD, newPassword: CHOSEN })
          .expect(401);

        expect(problemOf(response).type).toBe(problem('unauthorized'));
      });

      it('holds the new password to the same policy signup holds it to', async () => {
        const email = await signUp();
        const cookie = await signIn(email);

        const response = await change(cookie, PASSWORD, 'password123456').expect(422);

        expect(problemOf(response).type).toBe(problem('password-too-weak'));
      });

      it('never echoes either password', async () => {
        const email = await signUp();
        const cookie = await signIn(email);

        const response = await change(cookie, PASSWORD, CHOSEN).expect(200);

        expect(JSON.stringify(response.body)).not.toContain(PASSWORD);
        expect(JSON.stringify(response.body)).not.toContain(CHOSEN);
      });
    });

    /** §14 and criterion 17: every refusal these routes make is a complete RFC 9457 document. */
    describe('what the refusals look like', () => {
      it('answers a dead link with a complete document', async () => {
        const response = await confirm('Zm9yZ2Utbm90LWEtdG9rZW4tYXQtYWxsLWhvbmVzdA').expect(400);
        const document = problemOf(response);

        expect(document.instance).toBe(CONFIRM);
        expect(document.status).toBe(400);
        expect(document.type).toBe(problem('token-invalid'));
      });

      it('answers a wrong current password with a complete document', async () => {
        const email = await signUp();
        const cookie = await signIn(email);

        const document = problemOf(await change(cookie, 'not the password', CHOSEN).expect(403));

        expect(document.instance).toBe(CHANGE);
        expect(document.status).toBe(403);
        expect(document.type).toBe(problem('current-password-incorrect'));
      });
    });
  });
});
