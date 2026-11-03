import { Logger } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../../../app.module';
import { CLOCK } from '../../../common/clock/clock.port';
import { FakeClock } from '../../../common/clock/fake-clock';
import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { TokenService } from '../../identity/services/token.service';
import { InMemoryMailer } from '../../mail/in-memory.mailer';
import { MAIL_FAILURE_REASONS, MAILER, type MailMessage, mailFailed } from '../../mail/mailer.port';
import { RetryableFailure } from '../../outbox/consumer';
import type { Envelope } from '../../outbox/envelope';
import { InvitationMailConsumer } from './invitation-mail.consumer';
import { OrgService } from './org.service';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const START = '2026-09-14T10:00:00.000Z';
const DAY = 24 * 60 * 60 * 1_000;

describe('InvitationMailConsumer', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and both Redis roles', () => {
    let moduleRef: TestingModule;
    let consumer: InvitationMailConsumer;
    let database: ForgeDatabase;
    let orgs: OrgService;
    let tokens: TokenService;
    let transactions: TenantTransactionRunner;
    let clock: FakeClock;
    let mailer: InMemoryMailer;
    const userIds: string[] = [];
    const orgIds: string[] = [];

    async function seedOrg(): Promise<string> {
      const [owner] = await database
        .insert(schema.users)
        .values({
          email: `006i-${randomUUID()}@example.test`,
          emailVerifiedAt: clock.now(),
          passwordHash: 'x',
        })
        .returning({ id: schema.users.id });

      userIds.push(owner!.id);

      const org = await orgs.create(owner!.id, {
        name: 'Mail consumer fixture',
        slug: `006i-${randomUUID().slice(0, 8)}`,
      });

      orgIds.push(org.id);

      return org.id;
    }

    /** An open invitation unless `state` says otherwise; the hash is one nobody holds. */
    async function seedInvitation(
      orgId: string,
      state: { acceptedAt?: Date; expiresAt?: Date; revokedAt?: Date } = {},
    ): Promise<{ email: string; id: string; tokenHash: string }> {
      const email = `006i-${randomUUID()}@example.test`;
      const tokenHash = tokens.issue(60).tokenHash;
      const [row] = await transactions.runInTenantTransaction(orgId, (tx) =>
        tx
          .insert(schema.invitations)
          .values({
            acceptedAt: state.acceptedAt ?? null,
            email,
            expiresAt: state.expiresAt ?? new Date(Date.parse(START) + 7 * DAY),
            orgId,
            revokedAt: state.revokedAt ?? null,
            role: 'admin',
            tokenHash,
          })
          .returning({ id: schema.invitations.id }),
      );

      return { email, id: row!.id, tokenHash };
    }

    function envelope(orgId: string, invitationId: string, recipient: string) {
      return {
        aggregate: 'invitation',
        aggregateId: invitationId,
        eventId: randomUUID(),
        occurredAt: clock.now().toISOString(),
        orgId,
        payload: { invitationId, recipient },
        traceId: null,
        type: 'mail.invitation',
      } satisfies Envelope<'mail.invitation'>;
    }

    async function handle(event: Envelope<'mail.invitation'>): Promise<MailMessage | undefined> {
      return database.transaction((tx) => consumer.handle(event, tx));
    }

    async function rowFor(orgId: string, id: string) {
      const [row] = await transactions.runInTenantTransaction(orgId, (tx) =>
        tx.select().from(schema.invitations).where(eq(schema.invitations.id, id)),
      );

      return row;
    }

    function tokenIn(message: MailMessage | undefined): string {
      const found = /[?&]token=([A-Za-z0-9_-]+)/.exec(message?.text ?? '');

      return found?.[1] ?? expect.unreachable('the rendered message carries no token');
    }

    beforeAll(async () => {
      clock = new FakeClock(START);
      mailer = new InMemoryMailer();

      moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(CLOCK)
        .useValue(clock)
        .overrideProvider(MAILER)
        .useValue(mailer)
        .compile();
      await moduleRef.init();

      consumer = moduleRef.get(InvitationMailConsumer, { strict: false });
      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      orgs = moduleRef.get(OrgService);
      tokens = moduleRef.get(TokenService, { strict: false });
      transactions = moduleRef.get(TenantTransactionRunner);
    }, 60_000);

    beforeEach(() => {
      clock.set(START);
      mailer.clear();
    });

    afterAll(async () => {
      if (orgIds.length > 0) {
        await database.delete(schema.orgs).where(inArray(schema.orgs.id, orgIds));
      }

      if (userIds.length > 0) {
        await database.delete(schema.users).where(inArray(schema.users.id, userIds));
      }

      await moduleRef?.close();
    });

    /**
     * `invitations` and `orgs` are RLS-governed: a transaction with no `app.org_id` reads nothing,
     * so a rotation that lands proves the context was set before the re-check ran. The setting is
     * asserted on the same transaction, so it is the transaction-scoped form and not a session one.
     */
    it('sets the tenant context on the transaction first', async () => {
      const orgId = await seedOrg();
      const invitation = await seedInvitation(orgId);

      const setting = await database.transaction(async (tx) => {
        await consumer.handle(envelope(orgId, invitation.id, invitation.email), tx);

        const { rows } = await tx.execute<{ org: string }>(
          sql`select current_setting('app.org_id', true) as org`,
        );

        return rows[0]?.org;
      });

      expect(setting).toBe(orgId);
      expect((await rowFor(orgId, invitation.id))!.tokenHash).not.toBe(invitation.tokenHash);
    });

    it('rotates token_hash on an open invitation and returns the rendered mail with the org name and role', async () => {
      const orgId = await seedOrg();
      const invitation = await seedInvitation(orgId);

      const message = await handle(envelope(orgId, invitation.id, invitation.email));

      expect(message?.template).toBe('invitation');
      expect(message?.to).toBe(invitation.email);
      expect(message?.text).toContain('Mail consumer fixture');
      expect(message?.text).toContain('admin');
      expect((await rowFor(orgId, invitation.id))!.tokenHash).toBe(
        tokens.fingerprint(tokenIn(message)),
      );
    });

    it.each([
      ['accepted', { acceptedAt: new Date(START) }],
      ['revoked', { revokedAt: new Date(START) }],
      ['expired', { expiresAt: new Date(Date.parse(START) - 1) }],
    ])('skips an %s invitation', async (_state, state) => {
      const orgId = await seedOrg();
      const invitation = await seedInvitation(orgId, state);

      const message = await handle(envelope(orgId, invitation.id, invitation.email));

      expect(message).toBeUndefined();
      expect((await rowFor(orgId, invitation.id))!.tokenHash).toBe(invitation.tokenHash);
    });

    it('skips an invitation that is gone', async () => {
      const orgId = await seedOrg();

      const message = await handle(envelope(orgId, randomUUID(), 'nobody@example.test'));

      expect(message).toBeUndefined();
    });

    it('sends through MAILER in effect only', async () => {
      const orgId = await seedOrg();
      const invitation = await seedInvitation(orgId);
      const event = envelope(orgId, invitation.id, invitation.email);
      const message = await handle(event);

      expect(mailer.deliveries).toHaveLength(0);

      await consumer.effect(event, message);

      expect(mailer.outbox).toEqual([message]);
    });

    /** SC-010: the same classification as `identity-mail`, from the same function. */
    it('classifies every MailFailureReason exactly as MailFailure.retryable does', async () => {
      const orgId = await seedOrg();
      const invitation = await seedInvitation(orgId);
      const event = envelope(orgId, invitation.id, invitation.email);
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
      const orgId = await seedOrg();
      const invitation = await seedInvitation(orgId);
      const event = envelope(orgId, invitation.id, invitation.email);
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
    });
  });
});
