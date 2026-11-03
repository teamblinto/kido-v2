import { type INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { type Job, Queue } from 'bullmq';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { CLOCK } from '../src/common/clock/clock.port';
import { FakeClock } from '../src/common/clock/fake-clock';
import { QUEUE_REDIS } from '../src/common/redis/redis.constants';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import type { Environment } from '../src/config/environment';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../src/modules/identity/password/breached-password.port';
import { mailJobId } from '../src/modules/identity/services/identity-mail.consumer';
import { TokenService } from '../src/modules/identity/services/token.service';
import { InMemoryMailer } from '../src/modules/mail/in-memory.mailer';
import {
  MAILER,
  type MailDelivery,
  type MailMessage,
  mailFailed,
} from '../src/modules/mail/mailer.port';
import type { AttemptRecord } from '../src/modules/outbox/consumer-base';
import type { DeadLetter, DeadLetterQueue } from '../src/modules/outbox/dead-letter';
import type { Envelope } from '../src/modules/outbox/envelope';
import { QueueRegistry } from '../src/modules/outbox/queue-registry';
import { InvitationService } from '../src/modules/tenancy/services/invitation.service';
import { OrgService } from '../src/modules/tenancy/services/org.service';
import { unsafe } from './support/csrf-client';
import { awaitMail } from './support/mail';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  // This suite is about the queue: it relays and drains, under the outbox suite lock.
  process.env.RUN_PROFILES = 'api,agent,events,cron';
  // Argon2id at the local floor: fifty signups are the measurement's fixture, not its subject.
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  // Every request here comes from one runner; the per-IP buckets must not be what ends the suite.
  process.env.THROTTLE_LIMIT = '100000';
  process.env.PASSWORD_RESET_IP_BURST = '4000';
  process.env.VERIFICATION_RESEND_IP_BURST = '4000';
  // US3 asks one address for a hundred resends in one hour; the per-account bucket is not the subject.
  process.env.PASSWORD_RESET_ACCOUNT_BURST = '4000';
  process.env.VERIFICATION_RESEND_ACCOUNT_BURST = '4000';
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
const VERIFY = '/api/v1/auth/verify';
const RESEND = '/api/v1/auth/verify/resend';
const RESET = '/api/v1/auth/password/reset';
const CONFIRM = '/api/v1/auth/password/reset/confirm';

const START = '2026-09-14T10:00:00.000Z';
/**
 * `198.24/16`, one address per run: the throttle records carry the fake clock, and a record a
 * previous run left at START + 1 h refuses every request a fresh run makes at START.
 */
const CLIENT_IP = `198.24.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
const HOUR_MS = 60 * 60 * 1_000;
const PASSWORD = 'thermos-quibble-tundra-vellum';
const CHOSEN = 'kestrel-oxbow-parapet-sundial';

/** SC-001: response to fake transport, p95 over this many, under this bound. */
const SAMPLES = 50;
const DELIVERY_BOUND_MS = 5_000;

/**
 * The fake with a clock on it: each send records when the transport accepted it, which is the
 * far end of the response-to-delivery interval SC-001 measures. Outcomes are scripted per
 * recipient rather than through the base's global `failNext` queue: the worker drains sixteen jobs
 * at once, so "the next send fails" would land on whichever job the scheduler picked, and a case
 * that wants every one of a hundred jobs to fail exactly twice needs the script keyed by address.
 */
class TimedMailer extends InMemoryMailer {
  readonly acceptedAt = new Map<string, number>();
  private readonly scripts = new Map<string, MailDelivery[]>();

  /** The next outcomes for sends to `to`, in order; once spent, sends succeed as usual. */
  script(to: string, ...outcomes: MailDelivery[]): void {
    this.scripts.set(to, outcomes);
  }

  override async send(message: MailMessage): Promise<MailDelivery> {
    const scripted = this.scripts.get(message.to)?.shift();

    if (scripted !== undefined) {
      this.failNext(scripted);
    }

    const delivery = await super.send(message);

    if (delivery.outcome === 'sent') {
      this.acceptedAt.set(`${message.template}:${message.to}`, performance.now());
    }

    return delivery;
  }
}

/** The adapter fails open on a network error (ADR 008), so it is driven rather than reached. */
class ScriptedBreachPort implements BreachedPasswordPort {
  isBreached(_password: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}

function tokenIn(message: MailMessage): string {
  const found = /[?&]token=([A-Za-z0-9_-]+)/.exec(message.text);

  return found?.[1] ?? expect.unreachable(`the ${message.template} mail carries no token`);
}

/** Polls `predicate` until it holds or `ms` elapse — the queue has no other clock to wait on. */
async function until(predicate: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }

    await sleep(50);
  }

  return predicate();
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((left, right) => left - right);

  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

describe('Mail lane (e2e)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and both Redis roles', () => {
    let app: INestApplication;
    let database: ForgeDatabase;
    let mailer: TimedMailer;
    let clock: FakeClock;
    let transactions: TenantTransactionRunner;
    let invitations: InvitationService;
    let orgs: OrgService;
    let registry: QueueRegistry;
    let tokens: TokenService;
    let suiteLock: { release: () => Promise<void> } | undefined;
    const minted = new Set<string>();
    const orgIds: string[] = [];

    function http(): request.Agent {
      return request(app.getHttpServer() as Server);
    }

    function mailbox(): string {
      const address = `006e-${randomUUID()}@example.test`;

      minted.add(address);

      return address;
    }

    function signUp(email: string): request.Test {
      return unsafe(http().post(SIGNUP))
        .set('User-Agent', 'forge-e2e/1.0')
        .send({ email, password: PASSWORD });
    }

    function post(path: string, body: object): request.Test {
      return unsafe(http().post(path))
        .set('User-Agent', 'forge-e2e/1.0')
        .set('X-Forwarded-For', CLIENT_IP)
        .send(body);
    }

    async function mailTo(email: string, template: MailMessage['template']): Promise<MailMessage> {
      return awaitMail(mailer, (message) => message.template === template && message.to === email, {
        timeoutMs: DELIVERY_BOUND_MS,
      });
    }

    async function userFor(email: string) {
      const [row] = await database.select().from(schema.users).where(eq(schema.users.email, email));

      return row;
    }

    function mailQueue(): Queue<Envelope> {
      return registry.queues.get('mail') as Queue<Envelope>;
    }

    /** The job id the consumer derives for a verification mail appended under the fake clock now. */
    function verificationJobId(email: string, userId: string): string {
      return mailJobId({
        aggregate: 'user',
        aggregateId: userId,
        eventId: randomUUID(),
        occurredAt: clock.now().toISOString(),
        orgId: null,
        payload: { recipient: email, userId },
        traceId: null,
        type: 'mail.email-verification',
      });
    }

    async function attemptRecords(jobId: string): Promise<AttemptRecord[]> {
      const { logs } = await mailQueue().getJobLogs(jobId);

      return logs.map((row) => JSON.parse(row) as AttemptRecord);
    }

    /** The letter on `mail.dlq` for `jobId`, or a failed assertion once `ms` have passed. */
    async function deadLettered(jobId: string, ms: number): Promise<DeadLetter> {
      const dlq = registry.queues.get('mail.dlq') as DeadLetterQueue;
      let letter: Job<DeadLetter> | undefined;

      expect(await until(async () => (letter = await dlq.getJob(jobId)) !== undefined, ms)).toBe(
        true,
      );

      return letter!.data;
    }

    async function verificationRows(userId: string) {
      return database
        .select()
        .from(schema.emailVerificationTokens)
        .where(eq(schema.emailVerificationTokens.userId, userId));
    }

    /** An organisation with an owner, through the product's own path, for the invitation flow. */
    async function seedOrg(): Promise<{ orgId: string; ownerId: string }> {
      const email = mailbox();

      await signUp(email).expect(202);

      const owner = (await userFor(email))!;
      const org = await orgs.create(owner.id, {
        name: 'Mail lane fixture',
        slug: `006e-${randomUUID().slice(0, 8)}`,
      });

      orgIds.push(org.id);

      return { orgId: org.id, ownerId: owner.id };
    }

    beforeAll(async () => {
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
      mailer = new TimedMailer();
      clock = new FakeClock(START);

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(MAILER)
        .useValue(mailer)
        .overrideProvider(CLOCK)
        .useValue(clock)
        .overrideProvider(BREACHED_PASSWORD_PORT)
        .useValue(new ScriptedBreachPort())
        .compile();

      app = moduleRef.createNestApplication();
      configureApplication(app);
      await app.init();

      database = app.get<ForgeDatabase>(APP_DATABASE);
      transactions = app.get(TenantTransactionRunner);
      invitations = app.get(InvitationService);
      orgs = app.get(OrgService);
      registry = app.get(QueueRegistry);
      tokens = app.get(TokenService, { strict: false });
    }, LOCKED_BOOT_TIMEOUT_MS);

    afterAll(async () => {
      if (orgIds.length > 0) {
        await database.delete(schema.orgs).where(inArray(schema.orgs.id, orgIds));
      }

      if (minted.size > 0) {
        await database.delete(schema.users).where(inArray(schema.users.email, [...minted]));
      }

      await app?.close();
      await suiteLock?.release();
    });

    /**
     * SC-001. The interval is from the response leaving to the fake transport accepting the
     * message: the relay's tick (50 ms here, 1 s in production), the worker's pickup, the
     * consumer's transaction and the send. Fifty fresh signups for the distribution; then one of
     * each of the other four mails, each bounded by the same five seconds through `awaitMail`.
     */
    it('delivers each of the five mails within 5 s of the response, p95 over 50', async () => {
      const respondedAt = new Map<string, number>();

      for (let sample = 0; sample < SAMPLES; sample += 1) {
        const email = mailbox();

        await signUp(email).expect(202);
        respondedAt.set(email, performance.now());
      }

      const latencies: number[] = [];

      for (const [email, responded] of respondedAt) {
        await mailTo(email, 'email-verification');
        latencies.push(mailer.acceptedAt.get(`email-verification:${email}`)! - responded);
      }

      const p95 = percentile(latencies, 95);

      process.stderr.write(
        `[SC-001] response → fake transport over ${SAMPLES} verification mails: ` +
          `p50 ${percentile(latencies, 50).toFixed(0)} ms · p95 ${p95.toFixed(0)} ms · ` +
          `max ${Math.max(...latencies).toFixed(0)} ms (bound ${DELIVERY_BOUND_MS} ms)\n`,
      );

      expect(p95).toBeLessThan(DELIVERY_BOUND_MS);

      // The other four, one each. The taken address is one of the fifty; the resend and the
      // reset go to it too, an hour on, since one template to one address is one job per hour.
      const [taken] = respondedAt.keys();

      await signUp(taken!).expect(202);
      await mailTo(taken!, 'account-exists');

      clock.advance(HOUR_MS);
      mailer.clear();
      await post(RESEND, { email: taken }).expect(202);
      await mailTo(taken!, 'email-verification');

      await post(RESET, { email: taken }).expect(202);
      await mailTo(taken!, 'password-reset');

      const { orgId, ownerId } = await seedOrg();
      const invitee = mailbox();

      await transactions.runInTenantScope({ orgId, userId: ownerId }, () =>
        invitations.invite({ actorId: ownerId, email: invitee, orgId, role: 'member' }),
      );
      await mailTo(invitee, 'invitation');
    }, 180_000);

    /**
     * The token in the mail is the consumer's, minted after the request answered (spec 006 US1);
     * the flow that spends it must recognise it. One round trip per credential.
     */
    describe('spends the link the consumer issued', () => {
      it('for verification', async () => {
        const email = mailbox();

        await signUp(email).expect(202);

        const token = tokenIn(await mailTo(email, 'email-verification'));

        await post(VERIFY, { token }).expect(200);
        expect((await userFor(email))!.emailVerifiedAt).not.toBeNull();
      });

      it('for a password reset', async () => {
        const email = mailbox();

        await signUp(email).expect(202);
        await post(RESET, { email }).expect(202);

        const token = tokenIn(await mailTo(email, 'password-reset'));

        await post(CONFIRM, { password: CHOSEN, token }).expect(200);
      });

      it('for an invitation', async () => {
        const { orgId, ownerId } = await seedOrg();
        const invitee = mailbox();

        await signUp(invitee).expect(202);

        const inviteeId = (await userFor(invitee))!.id;

        await transactions.runInTenantScope({ orgId, userId: ownerId }, () =>
          invitations.invite({ actorId: ownerId, email: invitee, orgId, role: 'member' }),
        );

        const token = tokenIn(await mailTo(invitee, 'invitation'));
        const accepted = await transactions.runInTenantScope({ orgId, userId: inviteeId }, () =>
          invitations.accept({ actorId: inviteeId, orgId, token }),
        );

        expect(accepted.role).toBe('member');
      });
    });

    /**
     * US2 (SC-003/004): the provider's answer decides the job's fate, and nothing else does. A
     * throttle is retried inside spec 005's envelope and delivered; a rejection is final on the
     * first attempt; an outage exhausts the budget. A hundred of each where the spec counts, so a
     * scheduler-order accident cannot pass as the rule.
     */
    describe('retry and dead-letter', () => {
      /**
       * Two throttles then a send: three attempts, two `retryable` records. Each attempt runs
       * `handle` again — the row from a failed attempt is an orphan that expires (contract § No
       * connection across a send) — so three rows exist and the token in the mail is the last one.
       * The attempt records carry the fake clock, so the delay is read off the wall: retry 1 in
       * [0, 2 s), retry 2 in [0, 4 s), plus the relay's tick and the delayed-set promotion.
       */
      it('retries a throttled send and delivers on the third attempt, 100 of 100', async () => {
        const users = new Map<string, string>();

        for (let sample = 0; sample < 100; sample += 1) {
          const email = mailbox();

          mailer.script(
            email,
            mailFailed('throttled', 'scripted', 429),
            mailFailed('throttled', 'scripted', 429),
          );
          await signUp(email).expect(202);
          users.set(email, (await userFor(email))!.id);
        }

        // The clock starts after the last signup: the bound is on the retry envelope, and a
        // hundred argon2 hashes under a loaded CI worker are the fixture, not the subject.
        const startedAt = performance.now();
        let slowest = 0;

        for (const [email, userId] of users) {
          const message = await awaitMail(
            mailer,
            (candidate) => candidate.template === 'email-verification' && candidate.to === email,
            { timeoutMs: 20_000 },
          );
          slowest = Math.max(slowest, mailer.acceptedAt.get(`email-verification:${email}`)!);

          const records = await attemptRecords(verificationJobId(email, userId));

          expect(records.map((record) => record.classification)).toEqual([
            'retryable',
            'retryable',
          ]);
          expect(records.map((record) => record.reason)).toEqual(['throttled', 'throttled']);

          const rows = await verificationRows(userId);
          const spent = tokens.fingerprint(tokenIn(message));

          expect(rows).toHaveLength(3);
          expect(rows.filter((row) => row.tokenHash === spent)).toHaveLength(1);
        }

        const elapsed = slowest - startedAt;

        process.stderr.write(
          `[SC-003] 100 throttled twice then sent: all delivered ${elapsed.toFixed(0)} ms after ` +
            'the last signup (envelope 6 000 ms + tolerance)\n',
        );

        expect(elapsed).toBeLessThan(6_000 + 5_000);
      }, 120_000);

      /**
       * A rejection is terminal (contract § One classification): one attempt, one letter carrying
       * the envelope and its trace id, and the source job removed so the hour's dedupe
       * key is free again (research R3).
       */
      it('dead-letters a send the provider rejects after one attempt, 100 of 100', async () => {
        const users = new Map<string, string>();

        for (let sample = 0; sample < 100; sample += 1) {
          const email = mailbox();

          mailer.script(email, mailFailed('rejected', 'scripted', 422));
          await signUp(email).expect(202);
          users.set(email, (await userFor(email))!.id);
        }

        let afterOneAttempt = 0;

        for (const [email, userId] of users) {
          const jobId = verificationJobId(email, userId);
          const letter = await deadLettered(jobId, 15_000);

          afterOneAttempt += letter.attempts.length === 1 ? 1 : 0;

          expect(letter.attempts[0]).toMatchObject({
            attempt: 1,
            classification: 'terminal',
            reason: 'MailNotDeliveredError',
          });
          expect(letter.payload).toMatchObject({
            payload: { recipient: email, userId },
            type: 'mail.email-verification',
          });
          // The letter's trace id is the envelope's; the four producers append none today, so
          // what is asserted is that the letter carries what the envelope carried.
          expect(letter.traceId).toBe(letter.payload.traceId);
          expect(letter.sourceQueue).toBe('mail');
          expect(
            await until(async () => (await mailQueue().getJob(jobId)) === undefined, 5_000),
          ).toBe(true);
          expect(mailer.outbox.filter((message) => message.to === email)).toHaveLength(0);
        }

        process.stderr.write(
          `[SC-004] ${afterOneAttempt} of ${users.size} rejected sends dead-lettered after one attempt\n`,
        );

        expect(afterOneAttempt).toBe(users.size);
      }, 120_000);

      /** The budget is five including the first try (spec 005 FR-019): four retries, then the letter. */
      it('dead-letters an unavailable provider after five attempts', async () => {
        const email = mailbox();

        mailer.script(
          email,
          ...Array.from({ length: 5 }, () => mailFailed('unavailable', 'scripted')),
        );
        await signUp(email).expect(202);

        const userId = (await userFor(email))!.id;
        // Four full-jitter delays: up to 2 + 4 + 8 + 16 s.
        const letter = await deadLettered(verificationJobId(email, userId), 45_000);

        expect(letter.attempts).toHaveLength(5);
        expect(letter.attempts.map((record) => record.classification)).toEqual(
          Array.from({ length: 5 }, () => 'retryable'),
        );
        expect(letter.attempts.map((record) => record.reason)).toEqual(
          Array.from({ length: 5 }, () => 'timeout'),
        );
        expect(mailer.outbox.filter((message) => message.to === email)).toHaveLength(0);
      }, 60_000);
    });

    /**
     * US3 (SC-005): the job id is the dedupe key — template, hashed recipient, UTC hour — and the
     * store ignores an add whose id it already holds. Every repeat is still appended and relayed
     * (the request path does not know the hour); the collapse is the store's, so each case waits
     * for the outbox to drain before counting what the fake received.
     */
    describe('dedupes by template, recipient and hour', () => {
      /** Every row the four producers appended for `userId` has been handed to the store. */
      async function relayed(userId: string): Promise<void> {
        expect(
          await until(async () => {
            const pending = await database
              .select({ id: schema.outbox.id })
              .from(schema.outbox)
              .where(and(eq(schema.outbox.aggregateId, userId), isNull(schema.outbox.publishedAt)));

            return pending.length === 0;
          }, 10_000),
        ).toBe(true);
      }

      function verificationMailsTo(email: string): MailMessage[] {
        return mailer.outbox.filter(
          (message) => message.template === 'email-verification' && message.to === email,
        );
      }

      it('delivers once for 100 same-hour resends and again after the hour', async () => {
        const email = mailbox();

        await signUp(email).expect(202);
        await mailTo(email, 'email-verification');

        const userId = (await userFor(email))!.id;

        for (let repeat = 0; repeat < 100; repeat += 1) {
          await post(RESEND, { email }).expect(202);
        }

        await relayed(userId);
        // Nothing to await: a second delivery would be the failure. Give the worker a few ticks.
        await sleep(1_000);

        const sameHour = verificationMailsTo(email).length;

        expect(sameHour).toBe(1);

        clock.advance(HOUR_MS);
        await post(RESEND, { email }).expect(202);
        await relayed(userId);
        expect(await until(() => verificationMailsTo(email).length === 2, DELIVERY_BOUND_MS)).toBe(
          true,
        );

        process.stderr.write(
          `[SC-005] 1 signup + 100 same-hour resends → ${verificationMailsTo(email).length - 1} ` +
            'verification mail; 1 resend after the hour → 1 more\n',
        );
      }, 120_000);

      it('delivers two templates for one address in one hour', async () => {
        const email = mailbox();

        await signUp(email).expect(202);
        await post(RESET, { email }).expect(202);

        await mailTo(email, 'email-verification');
        await mailTo(email, 'password-reset');
      });

      /**
       * A retrying job keeps its id in the delayed set, so a same-hour repeat is absorbed by the
       * attempt already under way (research R3): one delivery, whose attempt log shows the
       * retries and nothing from the repeats.
       */
      it('collapses a repeat into a retry in progress', async () => {
        const email = mailbox();

        mailer.script(
          email,
          mailFailed('throttled', 'scripted', 429),
          mailFailed('throttled', 'scripted', 429),
        );
        await signUp(email).expect(202);

        const userId = (await userFor(email))!.id;

        for (let repeat = 0; repeat < 10; repeat += 1) {
          await post(RESEND, { email }).expect(202);
        }

        await awaitMail(
          mailer,
          (message) => message.template === 'email-verification' && message.to === email,
          { timeoutMs: 20_000 },
        );
        await relayed(userId);
        await sleep(1_000);

        expect(verificationMailsTo(email)).toHaveLength(1);
        expect(
          (await attemptRecords(verificationJobId(email, userId))).map((r) => r.classification),
        ).toEqual(['retryable', 'retryable']);
      }, 60_000);

      /** The dead-letter listener removed the source job, so the hour's id is free (research R3). */
      it('accepts a same-hour re-request after a dead letter', async () => {
        const email = mailbox();

        mailer.script(email, mailFailed('rejected', 'scripted', 422));
        await signUp(email).expect(202);

        const userId = (await userFor(email))!.id;
        const jobId = verificationJobId(email, userId);

        await deadLettered(jobId, 15_000);
        expect(
          await until(async () => (await mailQueue().getJob(jobId)) === undefined, 5_000),
        ).toBe(true);

        await post(RESEND, { email }).expect(202);
        await mailTo(email, 'email-verification');
      }, 60_000);
    });

    /**
     * US2 scenario 5 (SC-007): the queue store is not on the request path. With every `Queue.add`
     * refused, a signup costs what a signup costs — argon2 and a commit — and the rows wait in
     * the outbox for the store to come back. `Queue.prototype.add` is stubbed, as
     * `outbox.e2e-spec.ts` does, because the relay's queues are the module's own. The baseline is
     * measured first in the same process and printed beside the figure; the bound is on the p95,
     * since a hundred argon2 hashes on a shared runner produce an outlier or two either way.
     */
    it('answers signups the same with the queue store refusing adds', async () => {
      const signups = async (): Promise<{ emails: string[]; ms: number[] }> => {
        const emails: string[] = [];
        const ms: number[] = [];

        for (let sample = 0; sample < 100; sample += 1) {
          const email = mailbox();
          const startedAt = performance.now();

          await signUp(email).expect(202);
          ms.push(performance.now() - startedAt);
          emails.push(email);
        }

        return { emails, ms };
      };

      const baseline = await signups();
      const add = vi.spyOn(Queue.prototype, 'add').mockRejectedValue(new Error('queue store down'));
      const down = await signups();

      expect(add).toHaveBeenCalled();
      expect(mailer.outbox.filter((message) => down.emails.includes(message.to))).toHaveLength(0);

      add.mockRestore();

      for (const email of down.emails) {
        await mailTo(email, 'email-verification');
      }

      const upP95 = percentile(baseline.ms, 95);
      const downP95 = percentile(down.ms, 95);

      process.stderr.write(
        `[SC-007] 100 signups with the queue store down: p95 ${downP95.toFixed(1)} ms · ` +
          `store up: p95 ${upP95.toFixed(1)} ms (bound +20 %)\n`,
      );

      expect(downP95).toBeLessThan(upP95 * 1.2);
    }, 180_000);

    /**
     * US5 / §10's queue table: one `mail` worker at concurrency 16 (the lowest of the mail
     * consumers' declarations — identity's, spec 028's domain notices and spec 029's webhook
     * notices — all 16) and no worker on `mail.dlq` — the letter is the record,
     * and replay is Phase 3's admin operation, not a worker.
     */
    it('drains mail at concurrency 16 and runs no worker on the DLQ', () => {
      // `agent.line` is spec 031's (the run line's release and access-loss consumers), `agent.run` is spec 008's lane, `sandbox.ops` and `maintenance` spec 014's, `repo.mirror` spec
      // 016's, `connector.health` and `connector.sync` spec 018's, `connector.webhook` spec 026's, `connector.ops` spec 030's, `byok.health`
      // spec 020's, `build.deploy`, `deploy.lifecycle` and `deploy.sweep` spec 027's, `domain.check`
      // and `domain.sweep` spec 028's, `integration.out`, `webhook.fanout`, `webhook.notice` and `webhook.sweep` spec 029's, built by
      // the same registry; every profile is on, so every queue
      // has its worker and no DLQ has one.
      expect([...registry.queues.keys()].sort()).toEqual([
        'agent.line',
        'agent.line.dlq',
        'agent.run',
        'agent.run.dlq',
        'build.deploy',
        'build.deploy.dlq',
        'byok.health',
        'byok.health.dlq',
        'byos.health',
        'byos.health.dlq',
        'connector.health',
        'connector.health.dlq',
        'connector.ops',
        'connector.ops.dlq',
        'connector.sync',
        'connector.sync.dlq',
        'connector.webhook',
        'connector.webhook.dlq',
        'deploy.lifecycle',
        'deploy.lifecycle.dlq',
        'deploy.sweep',
        'deploy.sweep.dlq',
        'domain.check',
        'domain.check.dlq',
        'domain.sweep',
        'domain.sweep.dlq',
        'integration.out',
        'integration.out.dlq',
        'mail',
        'mail.dlq',
        'maintenance',
        'maintenance.dlq',
        'repo.mirror',
        'repo.mirror.dlq',
        'sandbox.ops',
        'sandbox.ops.dlq',
        'webhook.fanout',
        'webhook.fanout.dlq',
        'webhook.notice',
        'webhook.notice.dlq',
        'webhook.sweep',
        'webhook.sweep.dlq',
      ]);
      expect(
        registry.workers.map((worker) => [worker.name, worker.opts.concurrency]).sort(),
      ).toEqual([
        ['agent.line', 1],
        ['agent.run', 4],
        ['build.deploy', 4],
        ['byok.health', 1],
        ['byos.health', 1],
        ['connector.health', 1],
        ['connector.ops', 8],
        ['connector.sync', 2],
        ['connector.webhook', 1],
        ['deploy.lifecycle', 1],
        ['deploy.sweep', 1],
        ['domain.check', 1],
        ['domain.sweep', 1],
        ['integration.out', 32],
        ['mail', 16],
        ['maintenance', 2],
        ['repo.mirror', 4],
        ['sandbox.ops', 16],
        ['webhook.fanout', 8],
        ['webhook.notice', 4],
        ['webhook.sweep', 1],
      ]);
    });

    /**
     * US4 (SC-006): the store holds ids, the consumer renders. Everything under `bull:mail*` —
     * job data, options, attempt logs, the dead letters, whatever completed/failed retention still
     * keeps — is read raw off the queue Redis and searched for what a rendered mail would have
     * left: the tokens the fake saw, the link's query key, markup, each template's subject line.
     * It runs after the suites above so the store has held every kind of job this lane produces.
     */
    describe('holds ids only', () => {
      /** Every value under `bull:mail*`, whatever its Redis type, as one searchable string. */
      async function storeContents(): Promise<string> {
        const connection = app.get<Redis>(QUEUE_REDIS);
        const values: string[] = [];
        let cursor = '0';

        do {
          const [next, keys] = await connection.scan(cursor, 'MATCH', 'bull:mail*', 'COUNT', '500');

          cursor = next;

          for (const key of keys) {
            switch (await connection.type(key)) {
              case 'hash':
                values.push(JSON.stringify(await connection.hgetall(key)));
                break;
              case 'list':
                values.push(...(await connection.lrange(key, 0, -1)));
                break;
              case 'zset':
                values.push(...(await connection.zrange(key, '0', '-1')));
                break;
              case 'set':
                values.push(...(await connection.smembers(key)));
                break;
              case 'string':
                values.push((await connection.get(key)) ?? '');
                break;
              case 'stream':
                values.push(JSON.stringify(await connection.xrange(key, '-', '+')));
                break;
              default:
                break;
            }
          }
        } while (cursor !== '0');

        expect(values.length).toBeGreaterThan(0);

        return values.join('\n');
      }

      it('carries no token, link, body or subject on the queue', async () => {
        // SC-001 cleared the fake after its account-exists mail; one more puts that subject and
        // one such job back on record.
        const [taken] = minted;

        await signUp(taken!).expect(202);
        await mailTo(taken!, 'account-exists');

        const seen = mailer.deliveries.map(({ message }) => message);
        const tokens = seen.filter((message) => message.template !== 'account-exists').map(tokenIn);
        const subjects = [...new Set(seen.map((message) => message.subject))];

        // The search is only as good as its needles: every template must have been rendered.
        expect(new Set(seen.map((message) => message.template)).size).toBe(4);

        const contents = await storeContents();
        const needles = [...tokens, 'token=', '<html', ...subjects];
        const matches = needles.filter((needle) => contents.includes(needle));

        process.stderr.write(
          `[SC-006] ${needles.length} needles (${tokens.length} tokens, ${subjects.length} ` +
            `subjects, token=, <html) over bull:mail*: ${matches.length} matches
`,
        );

        expect(matches).toEqual([]);
      }, 60_000);

      /**
       * The re-check is the consumer's, at the tick, not the producer's at the request: a user
       * who verified in between gets no link. The queue store is refused until the user is
       * verified so the outbox holds the event past the change, deterministically.
       */
      it('sends nothing when the subject no longer qualifies', async () => {
        const email = mailbox();
        const add = vi
          .spyOn(Queue.prototype, 'add')
          .mockRejectedValue(new Error('queue store down'));
        const warn = vi.spyOn(Logger.prototype, 'warn');

        try {
          await signUp(email).expect(202);

          const userId = (await userFor(email))!.id;
          const jobId = verificationJobId(email, userId);

          await database
            .update(schema.users)
            .set({ emailVerifiedAt: clock.now() })
            .where(eq(schema.users.id, userId));
          add.mockRestore();

          expect(
            await until(
              async () => (await (await mailQueue().getJob(jobId))?.getState()) === 'completed',
              DELIVERY_BOUND_MS,
            ),
          ).toBe(true);

          expect(mailer.deliveries.filter(({ message }) => message.to === email)).toHaveLength(0);
          expect(await verificationRows(userId)).toHaveLength(0);

          const lines = warn.mock.calls.map((call) => String(call[0]));

          expect(lines).toContain('mail.email-verification skipped: reason=already-verified');
          expect(lines.some((line) => line.includes(email))).toBe(false);
        } finally {
          add.mockRestore();
          warn.mockRestore();
        }
      }, 60_000);

      /**
       * A failed attempt's `handle` committed before `effect` refused (contract § No connection
       * across a send): its row stays, unconsumed, and expires at the lifetime; the retry issues a
       * second token, and the mail carries that one.
       */
      it('leaves only an expiring orphan row behind a failed attempt', async () => {
        const email = mailbox();
        const ttlSeconds = app
          .get(ConfigService<Environment, true>)
          .get('EMAIL_VERIFICATION_TTL_SECONDS', { infer: true });

        mailer.script(email, mailFailed('throttled', 'scripted', 429));
        await signUp(email).expect(202);

        const message = await awaitMail(
          mailer,
          (candidate) => candidate.template === 'email-verification' && candidate.to === email,
          { timeoutMs: 20_000 },
        );
        const userId = (await userFor(email))!.id;
        const rows = await verificationRows(userId);
        const mailed = tokens.fingerprint(tokenIn(message));

        expect(rows).toHaveLength(2);
        expect(rows.filter((row) => row.tokenHash === mailed)).toHaveLength(1);

        for (const row of rows) {
          expect(row.consumedAt).toBeNull();
          expect(row.expiresAt.getTime()).toBe(clock.now().getTime() + ttlSeconds * 1_000);
        }
      }, 60_000);
    });
  });
});
