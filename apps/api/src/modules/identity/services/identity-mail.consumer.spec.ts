import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { ClockModule } from '../../../common/clock/clock.module';
import { CLOCK } from '../../../common/clock/clock.port';
import { FakeClock } from '../../../common/clock/fake-clock';
import { validateEnvironment } from '../../../config/environment';
import { APP_DATABASE } from '../../../database/database.constants';
import { DatabaseModule } from '../../../database/database.module';
import type { ForgeDatabase } from '../../../database/database.types';
import { InMemoryMailer } from '../../mail/in-memory.mailer';
import { MAIL_FAILURE_REASONS, MAILER, type MailMessage, mailFailed } from '../../mail/mailer.port';
import { RetryableFailure } from '../../outbox/consumer';
import type { Envelope } from '../../outbox/envelope';
import { IdentityMailConsumer, type IdentityMailType, mailJobId } from './identity-mail.consumer';
import { TokenService } from './token.service';

const postgres = inject('postgresReachable');

const START = '2026-09-14T10:00:00.000Z';

/** Restated rather than read from the schema: a test that reads the constant asserts code = code. */
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1_000;
const THIRTY_MINUTES_MS = 30 * 60 * 1_000;

describe('IdentityMailConsumer', () => {
  /** SC-005 (research R3): the job id is the dedupe key, so its shape is the rule. */
  it('derives the job id from type, hashed recipient and UTC hour', () => {
    const recipient = 'Dedupe.Me@example.test';

    function at(occurredAt: string): Envelope<'mail.email-verification'> {
      return {
        aggregate: 'user',
        aggregateId: randomUUID(),
        eventId: randomUUID(),
        occurredAt,
        orgId: null,
        payload: { recipient, userId: randomUUID() },
        traceId: null,
        type: 'mail.email-verification',
      };
    }

    const first = mailJobId(at('2026-09-14T10:00:00.000Z'));

    expect(mailJobId(at('2026-09-14T10:59:00.000Z'))).toBe(first);
    expect(mailJobId(at('2026-09-14T11:00:00.000Z'))).not.toBe(first);
    expect(mailJobId({ ...at('2026-09-14T10:00:00.000Z'), type: 'mail.password-reset' })).not.toBe(
      first,
    );
    expect(first).toMatch(/^mail\.email-verification\.[0-9a-f]{64}\.2026-09-14T10$/);
    expect(first.toLowerCase()).not.toContain(recipient.toLowerCase());
    expect(first).not.toContain(':');
  });

  describe.skipIf(!postgres)('against Postgres', () => {
    let moduleRef: TestingModule;
    let consumer: IdentityMailConsumer;
    let tokens: TokenService;
    let database: ForgeDatabase;
    let mailer: InMemoryMailer;
    let clock: FakeClock;
    const created: string[] = [];

    function mailbox(): string {
      return `006c-${randomUUID()}@example.test`;
    }

    async function seed(email: string, emailVerifiedAt: Date | null = null): Promise<string> {
      const [user] = await database
        .insert(schema.users)
        .values({ email, emailVerifiedAt, passwordHash: null })
        .returning({ id: schema.users.id });

      created.push(user!.id);

      return user!.id;
    }

    function envelope<T extends IdentityMailType>(
      type: T,
      payload: { next?: string; recipient: string; userId: string },
    ): Envelope<T> {
      // The three identity payloads share one schema; TypeScript cannot see that through `T`.
      return {
        aggregate: 'user',
        aggregateId: payload.userId,
        eventId: randomUUID(),
        occurredAt: clock.now().toISOString(),
        orgId: null,
        payload,
        traceId: null,
        type,
      } as Envelope<T>;
    }

    /** `handle` as the base runs it: on a transaction, committed when it returns. */
    async function handle<T extends IdentityMailType>(
      event: Envelope<T>,
    ): Promise<MailMessage | undefined> {
      return database.transaction((tx) => consumer.handle(event, tx));
    }

    function tokenIn(message: MailMessage | undefined): string {
      const found = /[?&]token=([A-Za-z0-9_-]+)/.exec(message?.text ?? '');

      return found?.[1] ?? expect.unreachable('the rendered message carries no token');
    }

    async function verificationRows(userId: string) {
      return database
        .select()
        .from(schema.emailVerificationTokens)
        .where(eq(schema.emailVerificationTokens.userId, userId));
    }

    async function resetRows(userId: string) {
      return database
        .select()
        .from(schema.passwordResetTokens)
        .where(eq(schema.passwordResetTokens.userId, userId));
    }

    beforeAll(async () => {
      clock = new FakeClock(START);
      mailer = new InMemoryMailer();

      moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            ignoreEnvFile: true,
            isGlobal: true,
            validate: validateEnvironment,
          }),
          ClockModule,
          DatabaseModule,
        ],
        providers: [IdentityMailConsumer, TokenService, { provide: MAILER, useValue: mailer }],
      })
        .overrideProvider(CLOCK)
        .useValue(clock)
        .compile();

      await moduleRef.init();

      consumer = moduleRef.get(IdentityMailConsumer);
      tokens = moduleRef.get(TokenService);
      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
    }, 60_000);

    beforeEach(() => {
      clock.set(START);
      mailer.clear();
    });

    afterAll(async () => {
      for (const id of created) {
        await database.delete(schema.users).where(eq(schema.users.id, id));
      }

      await moduleRef?.close();
    });

    describe('handle', () => {
      it('issues a token and writes its hash row for a verification request', async () => {
        const email = mailbox();
        const userId = await seed(email);

        const message = await handle(
          envelope('mail.email-verification', { recipient: email, userId }),
        );

        const [row] = await verificationRows(userId);

        expect(row).toBeDefined();
        expect(row!.email).toBe(email);
        expect(row!.tokenHash).toBe(tokens.fingerprint(tokenIn(message)));
        expect(row!.expiresAt.getTime()).toBe(new Date(START).getTime() + TWENTY_FOUR_HOURS_MS);
        expect(row!.consumedAt).toBeNull();
      });

      it('carries a same-origin relative next into the verification link', async () => {
        const email = mailbox();
        const userId = await seed(email);
        const next = '/project-invitations/accept/abc?org=x';

        const message = await handle(
          envelope('mail.email-verification', { next, recipient: email, userId }),
        );

        expect(message?.text).toContain(`next=${encodeURIComponent(next)}`);
      });

      it('carries it into the account-exists mail as well, so the two outcomes stay indistinguishable', async () => {
        const email = mailbox();
        const userId = await seed(email);
        const next = '/project-invitations/accept/abc?org=x';

        const message = await handle(
          envelope('mail.account-exists', { next, recipient: email, userId }),
        );

        expect(message?.text).toContain(`next=${encodeURIComponent(next)}`);
      });

      it('drops a next that is absolute, protocol-relative or not starting with /', async () => {
        const email = mailbox();
        const userId = await seed(email);

        for (const next of ['https://evil.example', '//evil.example', 'evil']) {
          const message = await handle(
            envelope('mail.account-exists', { next, recipient: email, userId }),
          );

          expect(message?.text).not.toContain('next=');
        }
      });

      it('writes a reset row with the reset lifetime', async () => {
        const email = mailbox();
        const userId = await seed(email);

        const message = await handle(envelope('mail.password-reset', { recipient: email, userId }));

        const [row] = await resetRows(userId);

        expect(row!.tokenHash).toBe(tokens.fingerprint(tokenIn(message)));
        expect(row!.expiresAt.getTime()).toBe(new Date(START).getTime() + THIRTY_MINUTES_MS);
        expect(message?.template).toBe('password-reset');
      });

      it('writes nothing for account-exists', async () => {
        const email = mailbox();
        const userId = await seed(email);

        const message = await handle(envelope('mail.account-exists', { recipient: email, userId }));

        expect(message?.template).toBe('account-exists');
        expect(message?.to).toBe(email);
        expect(await verificationRows(userId)).toHaveLength(0);
        expect(await resetRows(userId)).toHaveLength(0);
      });

      it('returns the rendered message and never calls the mailer inside handle', async () => {
        const email = mailbox();
        const userId = await seed(email);

        const message = await handle(
          envelope('mail.email-verification', { recipient: email, userId }),
        );

        expect(message?.template).toBe('email-verification');
        expect(message?.to).toBe(email);
        expect(mailer.deliveries).toHaveLength(0);
      });

      it('skips a verified user', async () => {
        const email = mailbox();
        const userId = await seed(email, new Date(START));

        const message = await handle(
          envelope('mail.email-verification', { recipient: email, userId }),
        );

        expect(message).toBeUndefined();
        expect(await verificationRows(userId)).toHaveLength(0);
      });

      it('skips when the address has changed', async () => {
        const userId = await seed(mailbox());

        const message = await handle(
          envelope('mail.password-reset', { recipient: mailbox(), userId }),
        );

        expect(message).toBeUndefined();
        expect(await resetRows(userId)).toHaveLength(0);
      });

      it('skips a missing user', async () => {
        const message = await handle(
          envelope('mail.account-exists', { recipient: mailbox(), userId: randomUUID() }),
        );

        expect(message).toBeUndefined();
      });
    });

    describe('effect', () => {
      it('sends the prepared message through MAILER', async () => {
        const email = mailbox();
        const userId = await seed(email);
        const event = envelope('mail.account-exists', { recipient: email, userId });
        const message = await handle(event);

        await consumer.effect(event, message);

        expect(mailer.outbox).toEqual([message]);
      });

      it('sends nothing when handle prepared nothing', async () => {
        const event = envelope('mail.account-exists', {
          recipient: mailbox(),
          userId: randomUUID(),
        });

        await consumer.effect(event, undefined);

        expect(mailer.deliveries).toHaveLength(0);
      });

      it('logs template and reason only, never the address, on failure', async () => {
        const email = mailbox();
        const userId = await seed(email);
        const event = envelope('mail.email-verification', { recipient: email, userId });
        const message = await handle(event);
        const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

        mailer.failNext(mailFailed('rejected', 'scripted'));

        await expect(consumer.effect(event, message)).rejects.toThrow();

        const lines = warn.mock.calls.map((call) => String(call[0]));

        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('email-verification');
        expect(lines[0]).toContain('rejected');
        expect(lines[0]).not.toContain(email);
        expect(lines[0]).not.toContain(tokenIn(message));
      });

      /**
       * SC-010: the consumer holds no table of reasons. `MailFailure.retryable` decides whether the
       * base retries; a reason added to the port tomorrow is classified without touching this file.
       */
      it('classifies every MailFailureReason exactly as MailFailure.retryable does', async () => {
        const email = mailbox();
        const userId = await seed(email);
        const event = envelope('mail.account-exists', { recipient: email, userId });
        const message = await handle(event);

        vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

        for (const reason of MAIL_FAILURE_REASONS) {
          const failed = mailFailed(reason, 'scripted');

          mailer.failNext(failed);

          const thrown = await consumer.effect(event, message).then(
            () => expect.unreachable(`${reason} did not throw`),
            (error: unknown) => error,
          );

          expect(thrown, reason).toBeInstanceOf(Error);
          expect(thrown instanceof RetryableFailure, reason).toBe(failed.failure.retryable);
        }
      });

      it('maps unavailable without a status to timeout and with one to upstream-5xx', async () => {
        const email = mailbox();
        const userId = await seed(email);
        const event = envelope('mail.account-exists', { recipient: email, userId });
        const message = await handle(event);

        vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

        mailer.failNext(mailFailed('unavailable', 'nothing answered'));
        await expect(consumer.effect(event, message)).rejects.toMatchObject({
          name: 'RetryableFailure',
          reason: 'timeout',
        });

        mailer.failNext(mailFailed('unavailable', 'answered 503', 503));
        await expect(consumer.effect(event, message)).rejects.toMatchObject({
          name: 'RetryableFailure',
          reason: 'upstream-5xx',
        });

        mailer.failNext(mailFailed('throttled', 'answered 429', 429));
        await expect(consumer.effect(event, message)).rejects.toMatchObject({
          name: 'RetryableFailure',
          reason: 'throttled',
        });
      });
    });
  });
});
