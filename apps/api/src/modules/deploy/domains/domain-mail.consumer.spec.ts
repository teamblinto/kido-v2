import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { schema } from '@repo/db';
import { and, eq } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from 'vitest';

import { AppModule } from '../../../app.module';
import { FakeClock } from '../../../common/clock/fake-clock';
import type { Environment } from '../../../config/environment';
import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { InMemoryMailer } from '../../mail/in-memory.mailer';
import { MAIL_FAILURE_REASONS, type MailMessage, mailFailed } from '../../mail/mailer.port';
import { projectDomainsUrl } from '../../mail/templates';
import { RetryableFailure } from '../../outbox/consumer';
import type { Envelope } from '../../outbox/envelope';
import { MembershipService } from '../../tenancy/services/membership.service';
import { OrgService } from '../../tenancy/services/org.service';
import { ProjectService } from '../../tenancy/services/project.service';
import { DomainRepository } from './domain.repository';
import { DomainMailConsumer, domainMailJobId } from './domain-mail.consumer';
import { type DomainNotice, DomainNotices } from './domain-notices';
import { ownershipToken } from './ownership-token';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const APP_URL = 'https://app.forge.test';
const TARGET = 'edge.forge-domains.test';
const NOW = '2026-09-23T12:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;

/**
 * Spec 028 T059 (research R14): the four domain notices. The settle appends one `mail.domain` per
 * recipient (`DomainNotices`, recipients from tenancy's `noticeRecipients`, stubbed here); the
 * consumer renders in `handle` from the row, the project and the recipient's current address, and
 * sends in `effect`. Its `jobId` sends each notice once per domain per recipient.
 */
describe('DomainMailConsumer', () => {
  describe.skipIf(!postgres || !redis)('against Postgres', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    let memberships: MembershipService;
    let consumer: DomainMailConsumer;
    const repository = new DomainRepository();
    const clock = new FakeClock(NOW);
    const mailer = new InMemoryMailer();
    let orgId: string;
    let ownerId: string;
    let ownerEmail: string;
    let projectId: string;

    function inTenant<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantTransaction(orgId, fn);
    }

    function config(values: Record<string, unknown>) {
      return { get: (key: string) => values[key] } as unknown as ConfigService<Environment, true>;
    }

    const REGISTERED = {
      activatedAt: new Date(Date.parse(NOW) - 60 * DAY),
      certificateActiveAt: new Date(Date.parse(NOW) - 60 * DAY),
      edgeId: 'edge-1',
      ownershipVerifiedAt: new Date(Date.parse(NOW) - 60 * DAY),
    };

    /** A domain moved straight into the state a notice is about, through the CHECKs that guard it. */
    async function seeded(
      state: 'active' | 'drifted' | 'failed' | 'removed',
      extra: Partial<typeof schema.domains.$inferInsert> = {},
    ): Promise<{ hostname: string; id: string }> {
      const domain = await inTenant((tx) =>
        repository.insert(tx, {
          addedBy: ownerId,
          hostname: `app-${randomUUID().slice(0, 8)}.example.test`,
          now: clock.now(),
          orgId,
          ownershipToken: ownershipToken(),
          projectId,
        }),
      );
      const columns =
        state === 'active'
          ? REGISTERED
          : state === 'drifted'
            ? { ...REGISTERED, driftedAt: new Date(Date.parse(NOW) - 3 * DAY), failureCount: 3 }
            : state === 'failed'
              ? { failureReason: 'verification-timeout' as const }
              : {};

      await inTenant((tx) =>
        tx
          .update(schema.domains)
          .set({ ...columns, ...extra, state })
          .where(eq(schema.domains.id, domain.id)),
      );

      return { hostname: domain.hostname, id: domain.id };
    }

    function envelope(
      domainId: string,
      notice: DomainNotice,
      recipient = ownerId,
    ): Envelope<'mail.domain'> {
      return {
        aggregate: 'domain',
        aggregateId: domainId,
        eventId: randomUUID(),
        occurredAt: clock.now().toISOString(),
        orgId,
        payload: { domainId, notice, recipient },
        traceId: null,
        type: 'mail.domain',
      };
    }

    function handle(event: Envelope<'mail.domain'>): Promise<MailMessage | undefined> {
      return database.transaction((tx) => consumer.handle(event, tx));
    }

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await moduleRef.init();

      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      transactions = moduleRef.get(TenantTransactionRunner);
      memberships = moduleRef.get(MembershipService, { strict: false });
      consumer = new DomainMailConsumer(
        mailer,
        clock,
        memberships,
        moduleRef.get(ProjectService, { strict: false }),
        config({ APP_URL, CUSTOM_HOSTNAME_TARGET: TARGET }),
      );

      ownerEmail = `028m-${randomUUID()}@example.test`;
      const [user] = await database
        .insert(schema.users)
        .values({ email: ownerEmail, passwordHash: 'x' })
        .returning({ id: schema.users.id });
      ownerId = user!.id;
      orgId = (
        await moduleRef.get(OrgService).create(ownerId, {
          name: 'Domain mail fixture',
          slug: `028m-${randomUUID().slice(0, 8)}`,
        })
      ).id;
      const [workspace] = await inTenant((tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      );
      projectId = (
        await transactions.runInTenantScope({ orgId, userId: ownerId }, () =>
          moduleRef.get(ProjectService).create({
            actorId: ownerId,
            name: 'Marketing <site>',
            orgId,
            ownerId,
            workspaceId: workspace!.id,
          }),
        )
      ).id;
    }, 60_000);

    beforeEach(() => {
      clock.set(NOW);
      mailer.clear();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      if (orgId !== undefined) await database.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
      if (ownerId !== undefined)
        await database.delete(schema.users).where(eq(schema.users.id, ownerId));
      await moduleRef?.close();
    });

    describe('the settle’s appends', () => {
      /**
       * On the settle's own transaction, rolled back here so the relay never sees them: one event
       * per recipient `noticeRecipients` names, carrying ids only.
       */
      it('appends one mail.domain event per recipient, in the settling transaction', async () => {
        const domain = await seeded('drifted');
        const otherId = randomUUID();
        const recipients = vi
          .spyOn(memberships, 'noticeRecipients')
          .mockResolvedValue([ownerId, otherId]);
        const notices = moduleRef.get(DomainNotices, { strict: false });

        let events: { payload: unknown; type: string }[] = [];
        const rolledBack = new Error('roll the appends back');

        await expect(
          inTenant(async (tx) => {
            await notices.append(tx, { addedBy: ownerId, id: domain.id, orgId }, 'drifted');

            events = await tx
              .select({ payload: schema.outbox.payload, type: schema.outbox.type })
              .from(schema.outbox)
              .where(
                and(
                  eq(schema.outbox.aggregateId, domain.id),
                  eq(schema.outbox.type, 'mail.domain'),
                ),
              );

            throw rolledBack;
          }),
        ).rejects.toBe(rolledBack);

        expect(recipients).toHaveBeenCalledWith(expect.anything(), orgId, ownerId);
        expect(events).toHaveLength(2);
        expect(events.map((event) => event.payload)).toEqual(
          expect.arrayContaining([
            { domainId: domain.id, notice: 'drifted', recipient: ownerId },
            { domainId: domain.id, notice: 'drifted', recipient: otherId },
          ]),
        );
      });
    });

    it('is registered on the mail queue, events profile, five attempts', () => {
      const registered = moduleRef.get(DomainMailConsumer, { strict: false });

      expect(registered.queue).toBe('mail');
      expect(registered.profile).toBe('events');
      expect(registered.attempts).toBe(5);
      expect(registered.types).toEqual(['mail.domain']);
    });

    /** `domains` is RLS-governed: a render proves `app.org_id` was set on the base's transaction. */
    it('sets the tenant context and renders domain-drifted to the recipient’s current address', async () => {
      const domain = await seeded('drifted');

      const message = await handle(envelope(domain.id, 'drifted'));

      expect(message?.template).toBe('domain-drifted');
      expect(message?.to).toBe(ownerEmail);
      expect(message?.subject).toContain(domain.hostname);
      expect(message?.subject).toContain('Marketing <site>');
      expect(message?.text).toContain(TARGET);
      expect(message?.text).toContain(projectDomainsUrl(APP_URL, projectId));
      expect(message?.html).not.toContain('Marketing <site>');
    });

    it('renders the release warning with the days left from drifted_at', async () => {
      const domain = await seeded('drifted', { driftedAt: new Date(Date.parse(NOW) - 23 * DAY) });

      const message = await handle(envelope(domain.id, 'release-warning'));

      expect(message?.template).toBe('domain-release-warning');
      expect(message?.subject).toContain('7 days');
    });

    it('renders domain-released for a removed domain', async () => {
      const domain = await seeded('removed');

      const message = await handle(envelope(domain.id, 'released'));

      expect(message?.template).toBe('domain-released');
      expect(message?.text).toContain(domain.hostname);
    });

    it('renders domain-failed with the reason’s fix, and the blocking CAA record from last_check', async () => {
      const domain = await seeded('failed', {
        failureReason: 'caa-blocked',
        lastCheck: {
          at: NOW,
          caa: { record: '0 issue "letsencrypt.org"', verdict: 'blocked', zone: 'example.test' },
          certificateRecords: [],
          conclusive: true,
          edge: null,
          edgeMessage: null,
          records: [],
        },
      });

      const message = await handle(envelope(domain.id, 'failed'));

      expect(message?.template).toBe('domain-failed');
      expect(message?.text).toContain(
        'Add the CAA record 0 issue "letsencrypt.org" to example.test',
      );
    });

    it.each([
      ['drifted', 'active'],
      ['release-warning', 'active'],
      ['released', 'drifted'],
      ['failed', 'active'],
    ] as const)('skips a %s notice once the domain is %s', async (notice, state) => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const domain = await seeded(state);

      await expect(handle(envelope(domain.id, notice))).resolves.toBeUndefined();
    });

    it('skips a recipient who is no longer an accepted member', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const domain = await seeded('drifted');

      await expect(handle(envelope(domain.id, 'drifted', randomUUID()))).resolves.toBeUndefined();
    });

    it('skips a domain that is gone, and an envelope with no organisation', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const domain = await seeded('drifted');

      await expect(handle(envelope(randomUUID(), 'drifted'))).resolves.toBeUndefined();
      await expect(
        handle({ ...envelope(domain.id, 'drifted'), orgId: null }),
      ).resolves.toBeUndefined();
    });

    it('sends through the mailer in effect only', async () => {
      const domain = await seeded('drifted');
      const event = envelope(domain.id, 'drifted');
      const message = await handle(event);

      expect(mailer.deliveries).toHaveLength(0);

      await consumer.effect(event, message);

      expect(mailer.outbox).toEqual([message]);
    });

    it('sends nothing for a skipped notice', async () => {
      await consumer.effect(envelope(randomUUID(), 'drifted'), undefined);

      expect(mailer.deliveries).toHaveLength(0);
    });

    describe('jobId', () => {
      it('is mail.domain.{notice}.{domainId}.{sha256(recipient)}', () => {
        const domainId = randomUUID();
        const hashed = createHash('sha256').update(ownerId).digest('hex');

        expect(consumer.jobId(envelope(domainId, 'release-warning'))).toBe(
          `mail.domain.release-warning.${domainId}.${hashed}`,
        );
        expect(domainMailJobId(envelope(domainId, 'release-warning'))).not.toContain(ownerId);
      });

      /** The mail lane drops a job whose id it already holds: the same notice twice sends once. */
      it('is the same for the same notice twice, whatever the event id or the hour', () => {
        const domainId = randomUUID();
        const first = envelope(domainId, 'drifted');

        clock.set(Date.parse(NOW) + 2 * DAY);
        const second = envelope(domainId, 'drifted');

        expect(second.eventId).not.toBe(first.eventId);
        expect(consumer.jobId(second)).toBe(consumer.jobId(first));
      });

      it('differs per notice, per domain and per recipient', () => {
        const domainId = randomUUID();
        const ids = new Set([
          consumer.jobId(envelope(domainId, 'drifted')),
          consumer.jobId(envelope(domainId, 'failed')),
          consumer.jobId(envelope(randomUUID(), 'drifted')),
          consumer.jobId(envelope(domainId, 'drifted', randomUUID())),
        ]);

        expect(ids.size).toBe(4);
      });
    });

    /** SC-010: classified exactly as the identity and invitation mails are, by the same function. */
    it('classifies every MailFailureReason exactly as MailFailure.retryable does', async () => {
      const domain = await seeded('drifted');
      const event = envelope(domain.id, 'drifted');
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
  });
});
