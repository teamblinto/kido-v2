import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SIGNUP_ACCEPTED } from '@repo/contracts';
import { schema } from '@repo/db';
import { eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import { InMemoryMailer } from '../src/modules/mail/in-memory.mailer';
import { MAILER } from '../src/modules/mail/mailer.port';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../src/modules/identity/password/breached-password.port';
import { PasswordHasher } from '../src/modules/identity/password/hasher';
import { unsafe } from './support/csrf-client';
import { awaitMail } from './support/mail';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  // Off by default under test — one outbox table, one queue Redis, many parallel workers. This
  // suite reads mail, so it relays and drains under the outbox suite lock (spec 006).
  process.env.RUN_PROFILES = 'api,agent,events,cron';
});

/**
 * The wait for the outbox suite lock is inside `beforeAll`, and it is a wait behind every other
 * suite that relays — `password.e2e-spec.ts`'s measurement among them — so the hook's budget is
 * the serialised suites', not this one's boot.
 */
const LOCKED_BOOT_TIMEOUT_MS = 600_000;

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const SIGNUP = '/api/v1/auth/signup';
const PASSWORD = 'thermos-quibble-tundra-vellum';

/**
 * The timing harness, deliberately identical to `login.e2e-spec.ts`.
 *
 * Fifteen samples a side compared by median, because the distribution has a long right tail — a
 * collection, a pool acquisition, the scheduler — and one outlier moves a mean further than the
 * missing Argon2id hash this is here to catch.
 */
const SAMPLES = 15;
const WARM_UP = 3;

/**
 * How far the two medians may sit apart, as a fraction of the larger.
 *
 * Loose enough not to fail on a noisy laptop, nowhere near loose enough to pass the bug: a branch
 * that answered a taken address without hashing would come back in about a millisecond against
 * about seventy. The regression is not subtle.
 */
const TOLERANCE = 0.25;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/**
 * A breach corpus the suite drives.
 *
 * Overridden rather than reached: the real adapter fails open on a network error (ADR 008), so a
 * machine without egress would quietly test the "not breached" branch for the case that is meant
 * to reject — and would add an unpredictable network timeout to every timing sample.
 */
class ScriptedBreachPort implements BreachedPasswordPort {
  breached = false;

  isBreached(_password: string): Promise<boolean> {
    return Promise.resolve(this.breached);
  }
}

describe('Signup (e2e)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and Redis', () => {
    let app: INestApplication;
    let database: ForgeDatabase;
    let hasher: PasswordHasher;
    let mailer: InMemoryMailer;
    let suiteLock: { release: () => Promise<void> } | undefined;
    let breach: ScriptedBreachPort;
    const minted = new Set<string>();

    function http(): request.Agent {
      return request(app.getHttpServer() as Server);
    }

    function mailbox(): string {
      const address = `t13-${randomUUID()}@example.test`;

      minted.add(address);

      return address;
    }

    function attempt(email: string, password: string = PASSWORD): request.Test {
      return unsafe(http().post(SIGNUP))
        .set('User-Agent', 'forge-e2e/1.0')
        .send({ email, password });
    }

    /** An address that already has an account, put there directly rather than through the route. */
    async function seed(email: string): Promise<void> {
      await database
        .insert(schema.users)
        .values({ email, passwordHash: await hasher.hash(PASSWORD) });
    }

    function setCookies(response: request.Response): string[] {
      const headers = response.headers as unknown as Record<string, string[] | undefined>;

      return headers['set-cookie'] ?? [];
    }

    beforeAll(async () => {
      breach = new ScriptedBreachPort();
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
      mailer = new InMemoryMailer();

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(MAILER)
        .useValue(mailer)
        .overrideProvider(BREACHED_PASSWORD_PORT)
        .useValue(breach)
        .compile();

      app = moduleRef.createNestApplication();
      configureApplication(app);
      await app.init();

      database = app.get<ForgeDatabase>(APP_DATABASE);
      hasher = app.get(PasswordHasher);
    }, LOCKED_BOOT_TIMEOUT_MS);

    beforeEach(() => {
      mailer.clear();
      breach.breached = false;
    });

    afterAll(async () => {
      if (minted.size > 0) {
        await database.delete(schema.users).where(inArray(schema.users.email, [...minted]));
      }

      await app?.close();
      await suiteLock?.release();
    });

    describe('an address with no account', () => {
      it('answers 202 with the one constant body', async () => {
        const response = await attempt(mailbox()).expect(202);

        expect(response.body).toEqual({ status: SIGNUP_ACCEPTED });
      });

      it('creates the account, unverified', async () => {
        const email = mailbox();

        await attempt(email).expect(202);

        const [user] = await database
          .select()
          .from(schema.users)
          .where(eq(schema.users.email, email));

        expect(user).toBeDefined();
        expect(user!.emailVerifiedAt).toBeNull();
      });

      /** Criterion 3's rule applies here too: signup establishes no session. */
      it('sets no cookie', async () => {
        expect(setCookies(await attempt(mailbox()).expect(202))).toEqual([]);
      });
    });

    describe('an address that already has an account', () => {
      it('answers 202 with the same body, never a 409', async () => {
        const email = mailbox();

        await seed(email);

        const response = await attempt(email).expect(202);

        expect(response.body).toEqual({ status: SIGNUP_ACCEPTED });
      });

      it('sends the account-exists mail instead', async () => {
        const email = mailbox();

        await seed(email);
        await attempt(email).expect(202);

        expect((await awaitMail(mailer, (message) => message.to === email)).template) //
          .toBe('account-exists');
      });

      it('sets no cookie either', async () => {
        const email = mailbox();

        await seed(email);

        expect(setCookies(await attempt(email).expect(202))).toEqual([]);
      });
    });

    /**
     * The property the attacker story demands, in the two halves an attacker can actually measure:
     * what the endpoint says, and how long it takes to say it. A constant body with a fast miss is
     * still an account enumerator — the body is what a reviewer reads and the timing is what an
     * attacker reads.
     */
    describe('a known address and an unknown one', () => {
      it('answers both with byte-identical bodies', async () => {
        const known = mailbox();

        await seed(known);

        const taken = await attempt(known).expect(202);
        const fresh = await attempt(mailbox()).expect(202);

        expect(taken.body).toEqual(fresh.body);
        expect(taken.status).toBe(fresh.status);
        expect(taken.text).toBe(fresh.text);
      });

      /**
       * Everything a client can read, not only the body it parses. A `Content-Length` that differed
       * would be an oracle available without even decoding the response.
       */
      it('answers both with the same headers a client could branch on', async () => {
        const known = mailbox();

        await seed(known);

        const taken = await attempt(known).expect(202);
        const fresh = await attempt(mailbox()).expect(202);

        expect(taken.headers['content-length']).toBe(fresh.headers['content-length']);
        expect(taken.headers['content-type']).toBe(fresh.headers['content-type']);
        expect(setCookies(taken)).toEqual(setCookies(fresh));
      });

      /**
       * The timing half, measured rather than asserted.
       *
       * Samples are interleaved so anything drifting over the run — a warming pool, a busy machine,
       * thermal throttling — lands on both series equally, and compared by median so one outlier
       * cannot carry the result.
       *
       * Two assertions, and the second is the one that matters. Close medians only mean something
       * if both are *slow*: two paths that each answer in a millisecond are also indistinguishable,
       * and would mean the hashing had gone away entirely. So the floor is measured from the hasher
       * this application is configured with, on this machine, in this run.
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
          // Timed inside the same loop as the requests, not once before it: a reference measured in
          // a quiet moment against samples taken in a busy one compares two different machines.
          const hashStarted = process.hrtime.bigint();

          await hasher.verify(reference, PASSWORD);

          const hashElapsed = Number(process.hrtime.bigint() - hashStarted) / 1e6;

          for (const [series, email] of [
            [known, seeded[sample]!],
            [unknown, mailbox()],
          ] as const) {
            const started = process.hrtime.bigint();

            await attempt(email).expect(202);

            const elapsed = Number(process.hrtime.bigint() - started) / 1e6;

            // The first few are thrown away: they measure a cold pool, not the branch under test.
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
          `\n[T13] argon2id hash ${median(hashCost).toFixed(1)} ms · ` +
            `signup known ${knownMedian.toFixed(1)} ms · unknown ${unknownMedian.toFixed(1)} ms · ` +
            `difference ${(difference * 100).toFixed(1)}% of the larger (n=${SAMPLES} each)\n`,
        );

        expect(knownMedian).toBeGreaterThan(floor);
        expect(unknownMedian).toBeGreaterThan(floor);
        expect(difference).toBeLessThan(TOLERANCE);
      }, 180_000);
    });

    /**
     * §11's three rejections, over HTTP, with the slugs a client branches on. All three are 422
     * refinements of `validation-failed`, and all three are the *same* for a taken address as for a
     * fresh one — an error that varied would undo the response body's careful sameness.
     */
    describe('the password policy', () => {
      it.each([
        ['too weak', 'qwerty123456', 'password-too-weak'],
        ['built from the address', 'ada.lovelace!', 'password-uses-personal-information'],
      ])('rejects one %s with its own slug', async (_name, password, slug) => {
        const email = password === 'ada.lovelace!' ? 'ada.lovelace@example.test' : mailbox();

        minted.add(email);

        const response = await attempt(email, password).expect(422);

        expect(response.body).toMatchObject({ type: `https://forge.dev/problems/${slug}` });
      });

      it('rejects a breached password with the third slug', async () => {
        breach.breached = true;

        const response = await attempt(mailbox()).expect(422);

        expect(response.body).toMatchObject({
          type: 'https://forge.dev/problems/password-breached',
        });
      });

      it('answers a taken address exactly as it answers a fresh one', async () => {
        const taken = mailbox();

        await seed(taken);

        const onTaken = await attempt(taken, 'qwerty123456').expect(422);
        const onFresh = await attempt(mailbox(), 'qwerty123456').expect(422);

        const comparable = (response: request.Response): Record<string, unknown> =>
          Object.fromEntries(
            Object.entries(response.body as Record<string, unknown>).filter(
              ([member]) => member !== 'requestId' && member !== 'instance',
            ),
          );

        expect(comparable(onTaken)).toEqual(comparable(onFresh));
      });

      it('creates nothing and sends nothing when the password is refused', async () => {
        const email = mailbox();

        await attempt(email, 'qwerty123456').expect(422);

        const rows = await database
          .select()
          .from(schema.users)
          .where(eq(schema.users.email, email));

        expect(rows).toHaveLength(0);
        // For *this* address: mail now arrives off the request path, so an earlier test's message
        // may land in the fake during this one, and a count of everything would race it.
        expect(mailer.to(email)).toHaveLength(0);
      });
    });

    /** `strictObject`: a field the endpoint does not read is a 422, not something quietly dropped. */
    it('refuses a body carrying an organisation name, which signup does not create', async () => {
      const response = await unsafe(http().post(SIGNUP)).send({
        email: mailbox(),
        organisationName: 'Analytical Engines',
        password: PASSWORD,
      });

      expect(response.status).toBe(422);
    });
  });
});
