import { ConfigModule } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { outbox, schema } from '@repo/db';
import { count, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { ClockModule } from '../../../common/clock/clock.module';
import type { DomainError } from '../../../common/errors/domain-error';
import { RatelimitModule } from '../../../common/ratelimit/ratelimit.module';
import { RedisModule } from '../../../common/redis/redis.module';
import { validateEnvironment } from '../../../config/environment';
import { APP_DATABASE } from '../../../database/database.constants';
import { DatabaseModule } from '../../../database/database.module';
import type { ForgeDatabase } from '../../../database/database.types';
import { OutboxWriter } from '../../outbox/outbox-writer';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../password/breached-password.port';
import { PasswordHasher } from '../password/hasher';
import { PasswordModule } from '../password/password.module';
import { EmailVerificationService } from './email-verification.service';
import { SignupService } from './signup.service';
import { TokenService } from './token.service';

const postgres = inject('postgresReachable');

const STRONG = 'thermos-quibble-tundra-vellum';

/**
 * A breach corpus this suite drives, in place of the real HIBP adapter.
 *
 * Overridden rather than reached: the adapter fails open on a network error (ADR 008), so a suite
 * running without egress would silently test the "not breached" branch for every case including
 * the one that is supposed to reject.
 */
class ScriptedBreachPort implements BreachedPasswordPort {
  breached = false;
  calls = 0;

  isBreached(_password: string): Promise<boolean> {
    this.calls += 1;

    return Promise.resolve(this.breached);
  }
}

describe('SignupService', () => {
  describe.skipIf(!postgres)('against Postgres', () => {
    let moduleRef: TestingModule;
    let signup: SignupService;
    let database: ForgeDatabase;
    let hasher: PasswordHasher;
    let writer: OutboxWriter;
    let breach: ScriptedBreachPort;
    const created: string[] = [];

    function mailbox(): string {
      return `t13-${randomUUID()}@example.test`;
    }

    /** The mail events appended for an address, oldest first — what the request path produces now. */
    async function eventsFor(email: string): Promise<{ type: string; userId: unknown }[]> {
      return database
        .select({ type: outbox.type, userId: sql<unknown>`${outbox.payload}->>'userId'` })
        .from(outbox)
        .where(sql`${outbox.payload}->>'recipient' = ${email}`)
        .orderBy(outbox.seq);
    }

    /** Put an account in the table directly, and remember it so the shared database is restored. */
    async function seed(email: string): Promise<string> {
      const [user] = await database
        .insert(schema.users)
        .values({ email, passwordHash: await hasher.hash(STRONG) })
        .returning({ id: schema.users.id });

      created.push(user!.id);

      return user!.id;
    }

    async function rowsFor(email: string): Promise<number> {
      const [row] = await database
        .select({ total: count() })
        .from(schema.users)
        .where(eq(schema.users.email, email));

      return row!.total;
    }

    async function userFor(email: string) {
      const [row] = await database.select().from(schema.users).where(eq(schema.users.email, email));

      return row;
    }

    /** Register, remembering whatever row it created so `afterAll` can remove it. */
    async function register(email: string, password = STRONG): Promise<void> {
      await signup.register({ email, password });

      const row = await userFor(email);

      if (row !== undefined && !created.includes(row.id)) {
        created.push(row.id);
      }
    }

    async function refusalOf(email: string, password: string): Promise<DomainError> {
      try {
        await register(email, password);
      } catch (error) {
        return error as DomainError;
      }

      return expect.unreachable('signup should have been refused');
    }

    beforeAll(async () => {
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
          PasswordModule,
          RedisModule,
          RatelimitModule,
        ],
        providers: [
          // Real rather than stubbed. T14 closed the asymmetry this suite documents — both signup
          // branches now append exactly one mail event — and a stubbed verifier would let the fresh
          // branch go back to appending none without a test noticing. The writer is real too, so
          // the rows are read back from the table the relay reads; no `MAILER` is provided, and the
          // module would fail to compile if the service still asked for one.
          EmailVerificationService,
          OutboxWriter,
          SignupService,
          TokenService,
        ],
      })
        .overrideProvider(BREACHED_PASSWORD_PORT)
        .useValue(breach)
        .compile();

      await moduleRef.init();

      signup = moduleRef.get(SignupService);
      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      hasher = moduleRef.get(PasswordHasher);
      writer = moduleRef.get(OutboxWriter);
    }, 60_000);

    beforeEach(() => {
      breach.breached = false;
      breach.calls = 0;
    });

    afterAll(async () => {
      // The outbox rows stay: the table is append-only to the application role, as it is for the
      // spec 005 suites, and every row here names a mailbox that exists nowhere.
      for (const id of created) {
        await database.delete(schema.users).where(eq(schema.users.id, id));
      }

      await moduleRef?.close();
    });

    describe('an address with no account', () => {
      it('creates exactly one user row', async () => {
        const email = mailbox();

        await register(email);

        expect(await rowsFor(email)).toBe(1);
      });

      /**
       * Criterion 1, and the half of it that is easy to lose: the account works straight away. The
       * `emailVerified` predicate is what later features consult before letting it create a
       * sandbox — it is not a reason to refuse the account itself.
       */
      it('leaves the account unverified', async () => {
        const email = mailbox();

        await register(email);

        expect((await userFor(email))!.emailVerifiedAt).toBeNull();
      });

      it('stores a verifiable argon2id hash and never the password', async () => {
        const email = mailbox();

        await register(email);

        const stored = (await userFor(email))!.passwordHash!;

        expect(stored).toMatch(/^\$argon2id\$/);
        expect(stored).not.toContain(STRONG);
        expect((await hasher.verify(stored, STRONG)).valid).toBe(true);
      });

      /**
       * The verification mail belongs to the consumer, which owns the token it carries (spec 006).
       * What matters here is that this branch appends exactly the verification event and not the
       * *other* one — an "account already exists" notice for an address that had no account would
       * be both wrong and an enumeration signal in its own right.
       */
      it('appends one verification event and no account-exists event', async () => {
        const email = mailbox();

        await register(email);

        const user = await userFor(email);

        expect(await eventsFor(email)).toEqual([
          { type: 'mail.email-verification', userId: user!.id },
        ]);
      });

      /** Both rows or neither: an event for an account that does not exist is a mail to nobody. */
      it('creates no account when the event cannot be appended', async () => {
        const email = mailbox();

        vi.spyOn(writer, 'append').mockRejectedValueOnce(new Error('scripted'));

        await expect(register(email)).rejects.toThrow('scripted');
        expect(await rowsFor(email)).toBe(0);
        expect(await eventsFor(email)).toHaveLength(0);
      });
    });

    /**
     * Spec 031 (R7): the accept page's address rides through sign-up, so a new account lands back on
     * the project invitation it came from. It goes on both events alike — the two outcomes must stay
     * indistinguishable to the caller — and anything that is not a same-origin relative path is
     * dropped rather than carried into a mail.
     */
    describe('the return address (spec 031)', () => {
      const NEXT = '/project-invitations/accept/abc?org=9c2f7b31-5d84-4a10-bb6e-1f0d2c3e4a55';

      async function nextOf(email: string): Promise<unknown[]> {
        const rows = await database
          .select({ next: sql<unknown>`${outbox.payload}->'next'` })
          .from(outbox)
          .where(sql`${outbox.payload}->>'recipient' = ${email}`)
          .orderBy(outbox.seq);

        return rows.map((row) => row.next);
      }

      async function registerWith(email: string, next: string): Promise<void> {
        await signup.register({ email, next, password: STRONG });

        const row = await userFor(email);

        if (row !== undefined && !created.includes(row.id)) {
          created.push(row.id);
        }
      }

      it('carries a same-origin relative next into the verification link', async () => {
        const email = mailbox();

        await registerWith(email, NEXT);

        expect(await nextOf(email)).toEqual([NEXT]);
      });

      it('carries it into the account-exists mail as well, so the two outcomes stay indistinguishable', async () => {
        const email = mailbox();

        await seed(email);
        await registerWith(email, NEXT);

        expect(await nextOf(email)).toEqual([NEXT]);
      });

      it.each([
        'https://evil.example/x',
        '//evil.example/x',
        'project-invitations/x',
        '/\\evil.example',
      ])(
        'drops a next that is absolute, protocol-relative or not starting with / (%s)',
        async (next) => {
          const email = mailbox();

          await registerWith(email, next);

          expect(await nextOf(email)).toEqual([null]);
        },
      );
    });

    describe('an address that already has an account', () => {
      it('creates no second row', async () => {
        const email = mailbox();

        await seed(email);
        await register(email);

        expect(await rowsFor(email)).toBe(1);
      });

      it('does not touch the existing row', async () => {
        const email = mailbox();

        await seed(email);

        const before = await userFor(email);

        await register(email, 'thermos-quibble-tundra-vellum-2');

        expect(await userFor(email)).toEqual(before);
      });

      /** The mail is the only channel that tells the truth, because the endpoint will not. */
      it('appends one account-exists event carrying the address and the existing user id', async () => {
        const email = mailbox();
        const userId = await seed(email);

        await register(email);

        expect(await eventsFor(email)).toEqual([{ type: 'mail.account-exists', userId }]);
      });

      it('resolves without throwing, so the caller cannot tell from an exception', async () => {
        const email = mailbox();

        await seed(email);

        await expect(register(email)).resolves.toBeUndefined();
      });
    });

    /**
     * The constant-time property, asserted on the work rather than on the clock.
     *
     * `login.service.spec.ts` makes the same argument: a timing assertion is the slow, noisy way to
     * catch a regression that a structural one catches instantly. Argon2id at 64 MB is the dominant
     * cost of this endpoint by an order of magnitude, so a branch that skipped it for an address it
     * had already found would be an account enumerator no wording of the response could hide.
     */
    describe('the work both branches do', () => {
      it('hashes the password even when the address is already taken', async () => {
        const email = mailbox();

        await seed(email);

        let hashed = 0;
        const real = hasher.hash.bind(hasher);

        hasher.hash = async (password: string) => {
          hashed += 1;

          return real(password);
        };

        try {
          await register(email);
        } finally {
          hasher.hash = real;
        }

        expect(hashed).toBe(1);
      });

      it('consults the breach corpus on both branches', async () => {
        await register(mailbox());

        const fresh = breach.calls;
        const taken = mailbox();

        await seed(taken);
        await register(taken);

        expect(breach.calls).toBe(fresh + 1);
      });
    });

    describe('password policy', () => {
      it.each([
        ['too weak', 'qwerty123456', 'password-too-weak'],
        ['built from the address', 'ada.lovelace!', 'password-uses-personal-information'],
      ])('rejects a password %s under its own slug', async (_name, password, slug) => {
        const email = password === 'ada.lovelace!' ? 'ada.lovelace@example.test' : mailbox();

        expect((await refusalOf(email, password)).type).toBe(slug);
      });

      it('rejects a breached password under the third slug', async () => {
        breach.breached = true;

        expect((await refusalOf(mailbox(), STRONG)).type).toBe('password-breached');
      });

      it('creates nothing when the password is refused', async () => {
        const email = mailbox();

        await refusalOf(email, 'qwerty123456');

        expect(await rowsFor(email)).toBe(0);
      });

      /**
       * The rejection must not depend on whether the address exists, or the *error* becomes the
       * oracle the response body was carefully written not to be.
       */
      it('rejects the same way for an address that already has an account', async () => {
        const taken = mailbox();

        await seed(taken);

        const onTaken = await refusalOf(taken, 'qwerty123456');
        const onFresh = await refusalOf(mailbox(), 'qwerty123456');

        expect(onTaken.type).toBe(onFresh.type);
        expect(onTaken.detail).toBe(onFresh.detail);
      });

      it('appends no event when the password is refused, whoever the address belongs to', async () => {
        const taken = mailbox();

        await seed(taken);
        await refusalOf(taken, 'qwerty123456');

        expect(await eventsFor(taken)).toHaveLength(0);
      });
    });

    /**
     * Two requests for the same new address, overlapping.
     *
     * A `select` followed by an `insert` passes every test above and loses this one: both callers
     * see no row, both insert, and the second gets a 23505 the endpoint has no branch for — a 500,
     * which is a perfectly good enumeration oracle for anyone willing to send two requests at once.
     */
    it('creates one account when two signups for the same address race', async () => {
      const email = mailbox();

      const outcomes = await Promise.allSettled([
        signup.register({ email, password: STRONG }),
        signup.register({ email, password: STRONG }),
      ]);

      const row = await userFor(email);

      if (row !== undefined) {
        created.push(row.id);
      }

      expect(outcomes.map(({ status }) => status)).toEqual(['fulfilled', 'fulfilled']);
      expect(await rowsFor(email)).toBe(1);
    });

    /**
     * ADR 007. `audit_log.org_id` is `not null` and signup creates no organisation, so there is no
     * tenant this event could be filed under — and the nullable column that would allow one was
     * rejected by T05 as "a silent hole rather than a design". The signup event goes to the
     * structured application log instead, exactly as `schema/audit.ts` prescribes for an
     * account-scope event.
     */
    it('writes no audit row, having no organisation to file one under', async () => {
      const email = mailbox();
      const [before] = await database.select({ total: count() }).from(schema.auditLog);

      await register(email);

      const [after] = await database.select({ total: count() }).from(schema.auditLog);

      expect(after!.total).toBe(before!.total);
    });
  });
});
