import { ConfigModule } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { outbox, schema } from '@repo/db';
import { eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { ClockModule } from '../../../common/clock/clock.module';
import { CLOCK } from '../../../common/clock/clock.port';
import { FakeClock } from '../../../common/clock/fake-clock';
import { type DomainError, RateLimitedError } from '../../../common/errors/domain-error';
import { RatelimitModule } from '../../../common/ratelimit/ratelimit.module';
import { throttleKey } from '../../../common/ratelimit/redis-throttler.storage';
import { SESSION_REDIS } from '../../../common/redis/redis.constants';
import { RedisModule } from '../../../common/redis/redis.module';
import { validateEnvironment } from '../../../config/environment';
import { holdOutboxSuiteLock } from '../../../../test/support/outbox-suite-lock';
import { APP_DATABASE } from '../../../database/database.constants';
import { DatabaseModule } from '../../../database/database.module';
import type { ForgeDatabase } from '../../../database/database.types';
import { OutboxWriter } from '../../outbox/outbox-writer';
import { EmailVerificationService } from './email-verification.service';
import { TokenService } from './token.service';

/**
 * Small enough to trip inside a test and still shaped like the real bucket, set through the
 * environment so the wiring is under test rather than bypassed — the argument `login.service.spec.ts`
 * makes. Hoisted, because `ConfigModule.forRoot` validates while the module graph is built.
 */
const RESEND = { accountBurst: 2, ipBurst: 5 };

vi.hoisted(() => {
  process.env.VERIFICATION_RESEND_ACCOUNT_BURST = '2';
  process.env.VERIFICATION_RESEND_DECAY_SECONDS = '60';
  process.env.VERIFICATION_RESEND_DELAY_SECONDS = '4';
  process.env.VERIFICATION_RESEND_IP_BURST = '5';
  process.env.VERIFICATION_RESEND_MAX_DELAY_SECONDS = '16';
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const START = '2026-08-16T10:00:00.000Z';

/** The window criterion 2 names. Restated here rather than imported: a test that reads the constant
 * it is checking asserts that the code equals itself. */
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1_000;

/**
 * `198.20/16`, distinct from the two ranges `login.service.spec.ts` and `login.e2e-spec.ts` claim,
 * with a random third octet per run: these files run in parallel workers against one Redis, and the
 * suite drives a fake clock, so a record it abandons never decays on its own.
 */
const RUN = randomInt(0, 256);
const minted = { addresses: new Set<string>(), mailboxes: new Set<string>() };
let issuedAddresses = 0;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function nextClientAddress(): string {
  issuedAddresses += 1;

  const client = `198.20.${RUN}.${issuedAddresses % 256}`;

  minted.addresses.add(client);

  return client;
}

describe('EmailVerificationService', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and the session Redis role', () => {
    let moduleRef: TestingModule;
    let verification: EmailVerificationService;
    let tokens: TokenService;
    let database: ForgeDatabase;
    let sessionRedis: Redis;
    let clock: FakeClock;
    let clientAddress: string;
    const created: string[] = [];

    function mailbox(): string {
      const address = `t14-${randomUUID()}@example.test`;

      minted.mailboxes.add(address);

      return address;
    }

    /** An account, put in the table directly. Signup's own wiring is `signup.service.spec.ts`. */
    async function seed(email: string, emailVerifiedAt: Date | null = null): Promise<string> {
      const [user] = await database
        .insert(schema.users)
        .values({ email, emailVerifiedAt, passwordHash: null })
        .returning({ id: schema.users.id });

      created.push(user!.id);

      return user!.id;
    }

    /**
     * Mint one for a fresh account the way the consumer does (spec 006): the row is written here
     * because issuing is `IdentityMailConsumer`'s and this suite is about spending. Its lifetime is
     * the schema's 24 h, restated.
     */
    async function issueFor(
      email = mailbox(),
    ): Promise<{ email: string; token: string; userId: string }> {
      const userId = await seed(email);
      const issued = tokens.issue(TWENTY_FOUR_HOURS_MS / 1_000);

      await database.insert(schema.emailVerificationTokens).values({
        email,
        expiresAt: issued.expiresAt,
        tokenHash: issued.tokenHash,
        userId,
      });

      return { email, token: issued.token, userId };
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
        .from(schema.emailVerificationTokens)
        .where(eq(schema.emailVerificationTokens.userId, userId));
    }

    async function userFor(id: string) {
      const [row] = await database.select().from(schema.users).where(eq(schema.users.id, id));

      return row;
    }

    async function rowFor(token: string) {
      const [row] = await database
        .select()
        .from(schema.emailVerificationTokens)
        .where(eq(schema.emailVerificationTokens.tokenHash, tokens.fingerprint(token)));

      return row;
    }

    /** The error a confirmation was refused with; failing loudly when it was not refused. */
    async function refusalOf(token: string): Promise<DomainError> {
      try {
        await verification.confirm(token);
      } catch (error: unknown) {
        return error as DomainError;
      }

      return expect.unreachable('expected the token to be refused, but it verified the address');
    }

    async function resendRefusalOf(email: string, ip = clientAddress): Promise<DomainError> {
      try {
        await verification.resend({ email, ip });
      } catch (error: unknown) {
        return error as DomainError;
      }

      return expect.unreachable('expected the resend to be refused, but it was accepted');
    }

    let suiteLock: { release: () => Promise<void> } | undefined;

    beforeAll(async () => {
      // The resend cases assert that no consumer has minted a token yet; a relay and the
      // identity-mail consumer in a concurrent suite would. Held for the suite, like every suite
      // that writes the outbox and asserts on what happens to its rows.
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
      clock = new FakeClock(START);

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
        ],
        // No `MAILER`: the service no longer asks for one, and the module would not compile if it did.
        providers: [EmailVerificationService, OutboxWriter, TokenService],
      })
        .overrideProvider(CLOCK)
        .useValue(clock)
        .compile();

      await moduleRef.init();

      verification = moduleRef.get(EmailVerificationService);
      tokens = moduleRef.get(TokenService);
      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      sessionRedis = moduleRef.get<Redis>(SESSION_REDIS);
    }, 600_000);

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
        ...[...minted.mailboxes].map((box) =>
          throttleKey('verification-resend-account', sha256(box)),
        ),
        ...[...minted.addresses].map((client) => throttleKey('verification-resend-ip', client)),
      );

      await moduleRef?.close();
      await suiteLock?.release();
    });

    /**
     * Asking for a link is one outbox row on the caller's transaction (spec 006 FR-002). The
     * token, its row and the mail are the consumer's — `identity-mail.consumer.spec.ts` — so the
     * request path is asserted to produce exactly the event and nothing else.
     */
    describe('requesting a link', () => {
      it('appends one verification event on the given transaction', async () => {
        const email = mailbox();
        const userId = await seed(email);

        await database.transaction((tx) => verification.request(tx, userId, email));

        expect(await eventsFor(email)).toEqual([{ type: 'mail.email-verification', userId }]);
      });

      it('writes no token row', async () => {
        const email = mailbox();
        const userId = await seed(email);

        await database.transaction((tx) => verification.request(tx, userId, email));

        expect(await tokenRowsFor(userId)).toHaveLength(0);
      });

      /** Rolled back with the transaction it rode on: no row means no mail (spec 005 FR-004). */
      it('leaves no event behind a transaction that rolled back', async () => {
        const email = mailbox();
        const userId = await seed(email);

        await expect(
          database.transaction(async (tx) => {
            await verification.request(tx, userId, email);
            throw new Error('scripted rollback');
          }),
        ).rejects.toThrow('scripted rollback');

        expect(await eventsFor(email)).toHaveLength(0);
      });
    });

    /**
     * Criterion 2's 24 h, asserted on both sides of the instant against a clock the test moves.
     *
     * A suite that slept past this would be a day long; one that asserted a tolerance is how an
     * off-by-an-hour survives review. These three tests are the reason `ClockPort` exists.
     */
    describe('the 24 hour boundary', () => {
      it('verifies the address with one millisecond of the window left', async () => {
        const { token, userId } = await issueFor();

        clock.advance(TWENTY_FOUR_HOURS_MS - 1);
        await verification.confirm(token);

        expect((await userFor(userId))!.emailVerifiedAt).not.toBeNull();
      });

      it('refuses at exactly 24 hours, under the expiry slug', async () => {
        const { token } = await issueFor();

        clock.advance(TWENTY_FOUR_HOURS_MS);

        expect((await refusalOf(token)).type).toBe('token-expired');
      });

      it('refuses one millisecond past 24 hours, under the expiry slug', async () => {
        const { token } = await issueFor();

        clock.advance(TWENTY_FOUR_HOURS_MS + 1);

        expect((await refusalOf(token)).type).toBe('token-expired');
      });

      it('leaves the account unverified when the window has closed', async () => {
        const { token, userId } = await issueFor();

        clock.advance(TWENTY_FOUR_HOURS_MS);
        await refusalOf(token);

        expect((await userFor(userId))!.emailVerifiedAt).toBeNull();
      });

      /** An expired token is not silently spent: it stays refusable, and keeps its own slug. */
      it('does not consume the row it refused', async () => {
        const { token } = await issueFor();

        clock.advance(TWENTY_FOUR_HOURS_MS);
        await refusalOf(token);

        expect((await rowFor(token))!.consumedAt).toBeNull();
      });
    });

    describe('single use', () => {
      it('verifies the address the first time', async () => {
        const { token, userId } = await issueFor();

        await verification.confirm(token);

        expect((await userFor(userId))!.emailVerifiedAt).toEqual(new Date(START));
      });

      it('marks the token consumed rather than deleting it', async () => {
        const { token } = await issueFor();

        await verification.confirm(token);

        expect((await rowFor(token))!.consumedAt).toEqual(new Date(START));
      });

      it('refuses the second use under a slug of its own', async () => {
        const { token } = await issueFor();

        await verification.confirm(token);

        expect((await refusalOf(token)).type).toBe('token-already-used');
      });

      /**
       * The timestamp records when the address was *first* confirmed. A replay that moved it would
       * quietly rewrite the account's history, and it is the field an audit reads.
       */
      it('does not move the verification timestamp on a replay', async () => {
        const { token, userId } = await issueFor();

        await verification.confirm(token);
        clock.advance(60_000);
        await refusalOf(token);

        expect((await userFor(userId))!.emailVerifiedAt).toEqual(new Date(START));
      });

      /**
       * A double-clicked mail link, which is the ordinary way this happens rather than an attack.
       * A read-then-write would let both through, and the window is exactly as wide as the gap
       * between the two clicks.
       */
      it('lets exactly one of two simultaneous confirmations through', async () => {
        const { token } = await issueFor();

        const outcomes = await Promise.allSettled([
          verification.confirm(token),
          verification.confirm(token),
        ]);

        expect(outcomes.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
      });
    });

    describe('a token nobody minted', () => {
      it('is refused under the third slug, distinct from expired and consumed', async () => {
        expect((await refusalOf('Zm9yZ2Utbm90LWEtdG9rZW4tYXQtYWxsLWhvbmVzdA')).type) //
          .toBe('token-invalid');
      });

      it('reports the same slug for a truncated link as for a random string', async () => {
        const { token } = await issueFor();

        expect((await refusalOf(token.slice(0, 20))).type).toBe('token-invalid');
      });
    });

    /**
     * Criterion 2's other half. The schema keeps the address the token was minted for, and this is
     * what that column is for: an unchanged token surviving an email change would let its holder
     * confirm an address the account no longer owns.
     */
    describe('an address that changed after the link was sent', () => {
      async function changeAddress(userId: string): Promise<void> {
        await database
          .update(schema.users)
          .set({ email: mailbox() })
          .where(eq(schema.users.id, userId));
      }

      it('refuses the outstanding token', async () => {
        const { token, userId } = await issueFor();

        await changeAddress(userId);

        expect((await refusalOf(token)).type).toBe('verification-address-changed');
      });

      it('leaves the new address unverified', async () => {
        const { token, userId } = await issueFor();

        await changeAddress(userId);
        await refusalOf(token);

        expect((await userFor(userId))!.emailVerifiedAt).toBeNull();
      });

      /**
       * The token is spent on the way out, so changing the address back does not revive a link that
       * has already been presented once. The refusal is not a reason to leave a live credential in
       * the table.
       */
      it('spends the token, so changing back does not revive it', async () => {
        const { email, token, userId } = await issueFor();

        await changeAddress(userId);
        await refusalOf(token);
        await database.update(schema.users).set({ email }).where(eq(schema.users.id, userId));

        expect((await refusalOf(token)).type).toBe('token-already-used');
      });
    });

    describe('resending', () => {
      it('appends one verification event for an address still awaiting one', async () => {
        const email = mailbox();
        const userId = await seed(email);

        await verification.resend({ email, ip: clientAddress });

        expect(await eventsFor(email)).toEqual([{ type: 'mail.email-verification', userId }]);
        expect(await tokenRowsFor(userId)).toHaveLength(0);
      });

      /**
       * Enumeration safety, the same property signup holds (ADR 007). An address with no account
       * resolves exactly as one with an account does — and appends nothing, because the
       * alternative is mailing strangers on the say-so of anyone who can type.
       */
      it('resolves for an address with no account, and appends nothing', async () => {
        const email = mailbox();

        await expect(verification.resend({ email, ip: clientAddress })) //
          .resolves.toBeUndefined();
        expect(await eventsFor(email)).toHaveLength(0);
      });

      it('resolves for an address already verified, and appends nothing', async () => {
        const email = mailbox();

        await seed(email, new Date(START));

        await expect(verification.resend({ email, ip: clientAddress })).resolves.toBeUndefined();
        expect(await eventsFor(email)).toHaveLength(0);
      });

      it('refuses past the per-address burst', async () => {
        const email = mailbox();

        await seed(email);

        for (let sent = 0; sent <= RESEND.accountBurst; sent += 1) {
          await verification.resend({ email, ip: nextClientAddress() });
        }

        expect(await resendRefusalOf(email, nextClientAddress())) //
          .toBeInstanceOf(RateLimitedError);
      });

      /**
       * The second bucket, and the one a per-address limit alone would miss entirely: one caller
       * walking a list of addresses charges a fresh account bucket every time.
       */
      it('refuses past the per-IP burst even across different addresses', async () => {
        for (let sent = 0; sent <= RESEND.ipBurst; sent += 1) {
          const email = mailbox();

          await seed(email);
          await verification.resend({ email, ip: clientAddress });
        }

        expect(await resendRefusalOf(mailbox())).toBeInstanceOf(RateLimitedError);
      });

      /**
       * The throttle must charge the branch that sends nothing exactly as it charges the branch that
       * sends. A bucket that only filled for real accounts would make "this address never throttles"
       * a working enumeration oracle — and one no amount of care over the response body would cover.
       */
      it('charges an address with no account exactly as it charges one with', async () => {
        const unknown = mailbox();

        for (let sent = 0; sent <= RESEND.accountBurst; sent += 1) {
          await verification.resend({ email: unknown, ip: nextClientAddress() });
        }

        expect(await resendRefusalOf(unknown, nextClientAddress())) //
          .toBeInstanceOf(RateLimitedError);
      });

      /** The throttle runs before the lookup: a refused request must not be an amplifier. */
      it('appends nothing at all once the bucket is empty', async () => {
        const email = mailbox();

        await seed(email);

        for (let sent = 0; sent <= RESEND.accountBurst; sent += 1) {
          await verification.resend({ email, ip: nextClientAddress() });
        }

        const before = (await eventsFor(email)).length;

        await resendRefusalOf(email, nextClientAddress());

        expect(await eventsFor(email)).toHaveLength(before);
      });
    });
  });
});
