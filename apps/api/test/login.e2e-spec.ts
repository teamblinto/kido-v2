import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import type { Environment } from '../src/config/environment';
import { CLOCK } from '../src/common/clock/clock.port';
import { FakeClock } from '../src/common/clock/fake-clock';
import { throttleKey } from '../src/common/ratelimit/redis-throttler.storage';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import { PasswordHasher } from '../src/modules/identity/password/hasher';
import { sessionKey } from '../src/modules/identity/services/session.service';
import { unsafe } from './support/csrf-client';
import { openClient } from './support/integration-redis';

/**
 * The throttle this suite drives, set through the environment because that is how the service is
 * configured. Hoisted above the imports: `ConfigModule.forRoot` validates while the module graph is
 * built, which happens before any `beforeAll` runs.
 *
 * The per-address burst is deliberately loose. Every test in this file arrives from the same test
 * runner, and a tight address bucket would refuse the *account* assertions for the wrong reason —
 * there is a test of its own below for the address bucket, from an address of its own.
 */
const THROTTLE = {
  accountBurst: 3,
  decaySeconds: 60,
  firstDelaySeconds: 2,
  maxDelaySeconds: 8,
};

vi.hoisted(() => {
  process.env.LOGIN_THROTTLE_ACCOUNT_BURST = '3';
  process.env.LOGIN_THROTTLE_DECAY_SECONDS = '60';
  process.env.LOGIN_THROTTLE_DELAY_SECONDS = '2';
  process.env.LOGIN_THROTTLE_IP_BURST = '400';
  process.env.LOGIN_THROTTLE_MAX_DELAY_SECONDS = '8';
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const START = '2026-08-16T10:00:00.000Z';
const PASSWORD = 'correct horse battery staple';
const LOGIN = '/api/v1/auth/login';
const LOGOUT = '/api/v1/auth/logout';
const ME = '/api/v1/auth/me';

/**
 * How many samples each side of the timing comparison gets, and how many are thrown away first.
 *
 * Fifteen, compared by median rather than mean: the distribution has a long right tail — a garbage
 * collection, a pool acquisition, the operating system scheduling something else — and one outlier
 * moves a mean by more than a missing Argon2id hash would.
 */
const SAMPLES = 15;
const WARM_UP = 3;

/**
 * How far the two medians may sit apart, as a fraction of the larger.
 *
 * Not tight enough to fail on a noisy machine, and nowhere near loose enough to pass the bug it is
 * here for: a miss that returns before hashing answers in about a millisecond against about
 * seventy, which is a 98% difference. Anything in the same order of magnitude as the tolerance is
 * scheduler noise; the regression is not subtle.
 */
const TOLERANCE = 0.25;

/** Everything the suite invents, so `afterAll` can name the throttle records it left behind. */
const minted = { addresses: new Set<string>(), mailboxes: new Set<string>() };
const RUN = randomInt(0, 256);

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

interface ParsedCookie {
  readonly attributes: ReadonlyMap<string, string | true>;
  readonly name: string;
  readonly raw: string;
  readonly value: string;
}

function parseSetCookie(header: string): ParsedCookie {
  const [pair, ...rest] = header.split(';').map((part) => part.trim());
  const separator = pair!.indexOf('=');

  return {
    attributes: new Map<string, string | true>(
      rest.map((attribute) => {
        const at = attribute.indexOf('=');

        return at === -1
          ? [attribute.toLowerCase(), true as const]
          : [attribute.slice(0, at).toLowerCase(), attribute.slice(at + 1)];
      }),
    ),
    name: pair!.slice(0, separator),
    raw: header,
    value: pair!.slice(separator + 1),
  };
}

function setCookies(response: request.Response): ParsedCookie[] {
  const headers = response.headers as unknown as Record<string, string[] | undefined>;

  return (headers['set-cookie'] ?? []).map(parseSetCookie);
}

/**
 * Everything about a problem document except the two members that are *supposed* to differ between
 * two requests. `requestId` is a fresh correlation id per request and `instance` is the path, which
 * is the same path here — comparing the rest is comparing what a caller could learn.
 */
function comparableBody(response: request.Response): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(response.body as Record<string, unknown>).filter(
      ([member]) => member !== 'requestId',
    ),
  );
}

describe('Login (e2e)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and the session Redis role', () => {
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
     * A client address per caller, so one test's per-IP bucket is not another's — out of a
     * different range from the one `login.service.spec.ts` mints from, because Vitest runs the two
     * files in parallel workers against the same Redis, and with a random third octet per run,
     * because this suite drives a fake clock: a record it abandons never decays, and a fixed
     * sequence would walk the next run straight back into it.
     */
    function nextClientAddress(): string {
      addressCounter += 1;

      const client = `198.19.${RUN}.${addressCounter % 256}`;

      minted.addresses.add(client);

      return client;
    }

    function mailbox(): string {
      const address = `t16-${randomUUID()}@example.test`;

      minted.mailboxes.add(address);

      return address;
    }

    async function seed(email: string, password: string | null = PASSWORD): Promise<string> {
      const [user] = await database
        .insert(schema.users)
        .values({ email, passwordHash: password === null ? null : await hasher.hash(password) })
        .returning({ id: schema.users.id });

      created.push(user!.id);

      return user!.id;
    }

    function attempt(
      email: string,
      password: string,
      ip: string = nextClientAddress(),
    ): request.Test {
      return unsafe(http().post(LOGIN))
        .set('X-Forwarded-For', ip)
        .set('User-Agent', 'forge-e2e/1.0')
        .send({ email, password });
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
    }, 60_000);

    afterAll(async () => {
      for (const id of created) {
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
    }, 60_000);

    describe('a sign-in that succeeds', () => {
      it('answers 200 with the account and nothing else', async () => {
        const email = mailbox();
        const id = await seed(email);

        const response = await attempt(email, PASSWORD).expect(200);

        expect(response.body).toEqual({
          user: { email, emailVerified: false, id, mfaEnabled: false },
        });
      });

      /** Criterion 3, over the wire: the token is in the cookie and in nothing else. */
      it('sets __Host-forge_session and keeps the token out of the body', async () => {
        const email = mailbox();

        await seed(email);

        const response = await attempt(email, PASSWORD).expect(200);
        const [cookie] = setCookies(response);

        expect(cookieName).toBe('__Host-forge_session');
        expect(cookie!.name).toBe(cookieName);
        expect(cookie!.attributes.has('domain')).toBe(false);
        expect(cookie!.attributes.get('httponly')).toBe(true);
        expect(cookie!.attributes.get('samesite')).toBe('Lax');
        expect(cookie!.attributes.get('secure')).toBe(true);
        expect(response.text).not.toContain(cookie!.value);
      });

      it('leaves a session in Redis under the hash of that token', async () => {
        const email = mailbox();

        await seed(email);

        const [cookie] = setCookies(await attempt(email, PASSWORD).expect(200));

        await expect(probe.exists(sessionKey(sha256(cookie!.value)))).resolves.toBe(1);
      });

      /** §11: a device fingerprint recorded for the session list T18 renders. */
      it('records the device the session was established from', async () => {
        const email = mailbox();

        await seed(email);

        const [cookie] = setCookies(await attempt(email, PASSWORD, '203.0.113.7').expect(200));

        await expect(probe.hgetall(sessionKey(sha256(cookie!.value)))).resolves.toMatchObject({
          fingerprint: expect.stringMatching(/^[0-9a-f]{32}$/) as unknown as string,
          ip: '203.0.113.7',
          userAgent: 'forge-e2e/1.0',
        });
      });
    });

    /**
     * The property this task exists to hold down, in the two halves an attacker can measure: what
     * the endpoint says, and how long it takes to say it. A generic message with a fast miss is
     * still an account enumerator — the message is what a reviewer reads and the timing is what an
     * attacker reads.
     */
    describe('an address that exists and one that does not', () => {
      it('answers both with byte-identical bodies', async () => {
        const known = mailbox();

        await seed(known);

        const wrongPassword = await attempt(known, 'not the password').expect(401);
        const noSuchAccount = await attempt(mailbox(), 'not the password').expect(401);

        expect(comparableBody(noSuchAccount)).toEqual(comparableBody(wrongPassword));
        expect(comparableBody(noSuchAccount)).toMatchObject({
          detail: 'Those credentials are not valid.',
          type: 'https://forge.dev/problems/unauthorized',
        });
      });

      /** An OAuth-only account has no password to be wrong. It must not be a third answer. */
      it('answers an account with no password the same way again', async () => {
        const known = mailbox();
        const oauthOnly = mailbox();

        await seed(known);
        await seed(oauthOnly, null);

        const wrongPassword = await attempt(known, 'not the password').expect(401);
        const noPassword = await attempt(oauthOnly, PASSWORD).expect(401);

        expect(comparableBody(noPassword)).toEqual(comparableBody(wrongPassword));
      });

      it('sets no cookie on the way out of either', async () => {
        const known = mailbox();

        await seed(known);

        expect(setCookies(await attempt(known, 'not the password').expect(401))).toEqual([]);
        expect(setCookies(await attempt(mailbox(), 'not the password').expect(401))).toEqual([]);
      });

      /**
       * The timing half, measured rather than asserted.
       *
       * Samples are interleaved so that anything drifting over the run — a warming pool, a busy
       * machine, thermal throttling — lands on both series equally, and compared by median so that
       * one outlier cannot carry the result. Every attempt uses a fresh mailbox and a fresh client
       * address, so no throttle record accumulates and every sample measures the same work.
       *
       * Two assertions, and the second is the one that matters. That the medians are close is only
       * meaningful if they are both *slow* — two paths that each answer in a millisecond are also
       * indistinguishable, and would mean the hashing had gone away entirely. So the floor is
       * measured from the hasher this application is configured with, on this machine, in this run.
       */
      it('takes indistinguishable time over both', async () => {
        const reference = await hasher.hash(PASSWORD);
        const hashCost: number[] = [];
        const known: number[] = [];
        const unknown: number[] = [];
        const seeded: string[] = [];

        for (let sample = 0; sample < SAMPLES + WARM_UP; sample += 1) {
          const email = mailbox();

          await seed(email);
          seeded.push(email);
        }

        for (let sample = 0; sample < SAMPLES + WARM_UP; sample += 1) {
          // The bare hash is timed inside the same loop as the two requests, not once before it.
          // The whole suite may be running beside this one, and a reference measured in a quiet
          // moment against samples taken in a busy one compares two different machines.
          const hashStarted = process.hrtime.bigint();

          await hasher.verify(reference, 'not the password');

          const hashElapsed = Number(process.hrtime.bigint() - hashStarted) / 1e6;

          for (const [series, email] of [
            [known, seeded[sample]!],
            [unknown, mailbox()],
          ] as const) {
            const started = process.hrtime.bigint();

            await attempt(email, 'not the password').expect(401);

            const elapsed = Number(process.hrtime.bigint() - started) / 1e6;

            // The first few are thrown away: they measure a cold pool and an unoptimised path,
            // not the branch under test.
            if (sample >= WARM_UP) {
              series.push(elapsed);
            }
          }

          if (sample >= WARM_UP) {
            hashCost.push(hashElapsed);
          }
        }

        const knownMedian = median(known);
        const unknownMedian = median(unknown);
        const floor = median(hashCost) / 2;
        const difference =
          Math.abs(knownMedian - unknownMedian) / Math.max(knownMedian, unknownMedian);

        // To stderr rather than through `console`, so the measurement is legible beside the
        // application's own log lines on stdout rather than buried in them.
        process.stderr.write(
          `\n[T16] argon2id verify ${median(hashCost).toFixed(1)} ms · ` +
            `login known ${knownMedian.toFixed(1)} ms · unknown ${unknownMedian.toFixed(1)} ms · ` +
            `difference ${(difference * 100).toFixed(1)}% of the larger (n=${SAMPLES} each)\n`,
        );

        expect(knownMedian).toBeGreaterThan(floor);
        expect(unknownMedian).toBeGreaterThan(floor);
        expect(difference).toBeLessThan(TOLERANCE);
      }, 180_000);
    });

    /**
     * §14: every limit answers with 429, `Retry-After` and a `type` the client can branch on.
     * Criterion 16: and it is a delay, not a lock.
     */
    describe('the throttle', () => {
      /** Spend the account's burst, from one client address, and leave it refused. */
      async function exhaust(email: string, ip: string): Promise<void> {
        for (let failure = 0; failure <= THROTTLE.accountBurst; failure += 1) {
          await attempt(email, 'not the password', ip).expect(401);
        }
      }

      it('answers 429 with Retry-After and a stable type once the burst is spent', async () => {
        const email = mailbox();
        const ip = nextClientAddress();

        await seed(email);
        await exhaust(email, ip);

        const response = await attempt(email, PASSWORD, ip).expect(429);

        expect(response.headers['retry-after']).toBe(String(THROTTLE.firstDelaySeconds));
        expect(response.body).toMatchObject({
          retryAfter: THROTTLE.firstDelaySeconds,
          status: 429,
          type: 'https://forge.dev/problems/rate-limited',
        });
        expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
      }, 60_000);

      /**
       * The enumeration oracle a per-account throttle creates when it is keyed on the account that
       * was *found* rather than the address that was *typed*: an address that never throttles is
       * an address with no account behind it. The 429 has to arrive for both.
       */
      it('throttles an address with no account exactly as it throttles a real one', async () => {
        const ip = nextClientAddress();
        const nobody = mailbox();

        await exhaust(nobody, ip);

        const response = await attempt(nobody, PASSWORD, ip).expect(429);

        expect(response.headers['retry-after']).toBe(String(THROTTLE.firstDelaySeconds));
      }, 60_000);

      /**
       * Criterion 16, proved rather than asserted. Nothing is cleared, nobody is asked, and no
       * second endpoint is called: the only thing that changes between the 429 and the 200 is that
       * the clock moved past the delay the account had earned.
       */
      it('lets the account back in once the delay has passed', async () => {
        const email = mailbox();
        const ip = nextClientAddress();

        await seed(email);
        await exhaust(email, ip);
        await attempt(email, PASSWORD, ip).expect(429);

        clock.advance(THROTTLE.firstDelaySeconds * 1_000);

        await attempt(email, PASSWORD, ip).expect(200);
      }, 60_000);

      /**
       * And recovers from the worst state anybody can drive it into. An attacker who knows the
       * address attempts once per ceiling delay for as long as they like — the count they build is
       * bounded, so the wait they impose is bounded, and the owner is back in after one of them.
       */
      it('recovers from a sustained attack rather than staying locked', async () => {
        const email = mailbox();
        const ip = nextClientAddress();

        await seed(email);

        for (let round = 0; round < 20; round += 1) {
          clock.advance(THROTTLE.maxDelaySeconds * 1_000);
          await attempt(email, 'not the password', ip).expect(401);
        }

        await attempt(email, PASSWORD, ip).expect(429);

        clock.advance(THROTTLE.maxDelaySeconds * 1_000);

        await attempt(email, PASSWORD, ip).expect(200);
      }, 120_000);
    });

    /**
     * `GET /auth/me` — the third way to arrive at the same fact, and the one a single-page app uses
     * on first paint. It is tested beside sign-in rather than in a suite of its own because every
     * property worth asserting is a relationship to sign-in: the same body, from a cookie rather
     * than a credential, and gone the moment the cookie is.
     */
    describe('resuming a session', () => {
      it('answers with exactly what the sign-in that established it answered', async () => {
        const email = mailbox();

        await seed(email);

        const signIn = await attempt(email, PASSWORD).expect(200);
        const [cookie] = setCookies(signIn);

        const resumed = await http()
          .get(ME)
          .set('Cookie', `${cookie!.name}=${cookie!.value}`)
          .expect(200);

        expect(resumed.body).toEqual(signIn.body);
      });

      /**
       * Criterion 3 again, on the route a client polls: the token is in the cookie and nowhere
       * else, and reading who you are neither rotates the session nor re-issues it. The response
       * does carry a `Set-Cookie` — the CSRF middleware mints one for a client that arrived without
       * it — so the assertion names the session cookie rather than counting headers.
       */
      it('carries nothing of the session itself, and does not rewrite its cookie', async () => {
        const email = mailbox();

        await seed(email);

        const [cookie] = setCookies(await attempt(email, PASSWORD).expect(200));

        const resumed = await http()
          .get(ME)
          .set('Cookie', `${cookie!.name}=${cookie!.value}`)
          .expect(200);

        expect(resumed.text).not.toContain(cookie!.value);
        expect(setCookies(resumed).map((written) => written.name)).not.toContain(cookieName);
      });

      /**
       * The refusal *is* the answer. A client calls this to find out whether the cookie the browser
       * kept is still live, and a `200` carrying an empty user would make "signed out" and "signed
       * in" the same status code for every proxy and error handler in between.
       */
      it('refuses a caller with no cookie, rather than describing nobody', async () => {
        const response = await http()
          .get(ME)
          .expect(401)
          .expect('Content-Type', /application\/problem\+json/);

        expect(response.body).toMatchObject({
          type: 'https://forge.dev/problems/unauthorized',
        });
      });

      it('refuses a cookie that is not a session', async () => {
        await http()
          .get(ME)
          .set('Cookie', `${cookieName}=Gg8kQ2mZ0tWx4pLnRc7bVs1yEhAuJiOoQrTvWxYzAbC`)
          .expect(401);
      });

      /** And signing out is what makes it a 401, which is the whole of the client's session check. */
      it('refuses the cookie a sign-out has revoked', async () => {
        const email = mailbox();

        await seed(email);

        const [cookie] = setCookies(await attempt(email, PASSWORD).expect(200));
        const header = `${cookie!.name}=${cookie!.value}`;

        await http().get(ME).set('Cookie', header).expect(200);
        await unsafe(http().post(LOGOUT), [header]).expect(204);
        await http().get(ME).set('Cookie', header).expect(401);
      });
    });

    describe('signing out', () => {
      async function signIn(): Promise<ParsedCookie> {
        const email = mailbox();

        await seed(email);

        const [cookie] = setCookies(await attempt(email, PASSWORD).expect(200));

        return cookie!;
      }

      it('answers 204 and revokes the session it was called with', async () => {
        const cookie = await signIn();

        await unsafe(http().post(LOGOUT), [`${cookie.name}=${cookie.value}`]).expect(204);

        await expect(probe.exists(sessionKey(sha256(cookie.value)))).resolves.toBe(0);
      });

      it('clears the cookie with the attributes it was written with', async () => {
        const cookie = await signIn();

        const response = await unsafe(http().post(LOGOUT), [
          `${cookie.name}=${cookie.value}`,
        ]).expect(204);
        const [cleared] = setCookies(response);

        expect(cleared!.name).toBe(cookie.name);
        expect(cleared!.value).toBe('');
        expect(cleared!.attributes.has('domain')).toBe(false);
        expect(cleared!.attributes.get('path')).toBe('/');
      });

      /** Logging out twice, or with a cookie that expired in an open tab, is not an error. */
      it('answers 204 for a caller with no session at all', async () => {
        await unsafe(http().post(LOGOUT)).expect(204);
      });
    });
  });
});
