import type { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { schema } from '@repo/db';
import { eq, inArray } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import { holdOutboxSuiteLock } from '../../../../test/support/outbox-suite-lock';

import { AppModule } from '../../../app.module';
import type { Environment } from '../../../config/environment';
import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { InMemoryMailer } from '../../mail/in-memory.mailer';
import { MAIL_FAILURE_REASONS, mailFailed } from '../../mail/mailer.port';
import { webhooksSettingsUrl } from '../../mail/templates';
import { RetryableFailure } from '../../outbox/consumer';
import type { Envelope } from '../../outbox/envelope';
import { MembershipService } from '../../tenancy/services/membership.service';
import { OrgService } from '../../tenancy/services/org.service';
import { EndpointRepository } from './endpoint.repository';
import { EndpointService } from './endpoint.service';
import { SendRepository } from './send.repository';
import { WebhookMailConsumer, webhookMailJobId } from './webhook-mail.consumer';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

/** The suite lock may wait out a relaying suite before the module boots. */
const LOCKED_BOOT_TIMEOUT_MS = 600_000;

const APP_URL = 'https://app.forge.test';
const NOW = new Date('2026-09-23T12:00:00.000Z');

/**
 * Spec 029 T058 — `WebhookMailConsumer`, following `DomainMailConsumer`: queue `mail`, 5 attempts,
 * concurrency 16. `handle` renders `webhook-paused` from the endpoint (its URL's host only), the
 * last failure and the recipient's current address; `effect` sends; a failed send is classified by
 * `classifyMailFailure`. The job id dedupes on `(endpointId, pausedAt, sha256(recipient))`.
 */
describe('WebhookMailConsumer', () => {
  describe.skipIf(!postgres || !redis)('against Postgres', () => {
    let moduleRef: TestingModule;
    let suiteLock: { release: () => Promise<void> } | undefined;
    let database: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    let consumer: WebhookMailConsumer;
    const mailer = new InMemoryMailer();
    const created: { orgs: string[]; users: string[] } = { orgs: [], users: [] };

    function inTenant<T>(orgId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantTransaction(orgId, fn);
    }

    async function fixture(failure: 'timeout' | null = 'timeout') {
      const email = `029w-${randomUUID()}@example.test`;
      const [owner] = await database
        .insert(schema.users)
        .values({ email, passwordHash: 'x' })
        .returning({ id: schema.users.id });
      created.users.push(owner!.id);
      const orgId = (
        await moduleRef.get(OrgService).create(owner!.id, {
          name: 'Webhook mail fixture',
          slug: `029w-${randomUUID().slice(0, 8)}`,
        })
      ).id;
      created.orgs.push(orgId);
      const endpoints = moduleRef.get(EndpointService);
      const { endpoint } = await inTenant(orgId, (tx) =>
        endpoints.create(tx, orgId, owner!.id, {
          description: '',
          eventTypes: ['deploy.succeeded'],
          projectIds: [],
          url: 'https://hooks.acme.example/secret/path?token=q',
        }),
      );
      if (failure !== null) {
        const send = await inTenant(orgId, (tx) =>
          endpoints.test(tx, orgId, owner!.id, endpoint.id),
        );
        await inTenant(orgId, (tx) =>
          moduleRef.get(SendRepository).insertAttempt(tx, {
            address: '203.0.113.10',
            attemptedAt: NOW,
            durationMs: 10_000,
            failure,
            manual: false,
            orgId,
            responseBody: null,
            responseHeaders: null,
            sendId: send.id,
            status: null,
          }),
        );
      }
      await inTenant(orgId, (tx) =>
        tx
          .update(schema.webhookEndpoints)
          .set({ pausedAt: NOW, state: 'paused' })
          .where(eq(schema.webhookEndpoints.id, endpoint.id)),
      );
      const event: Envelope<'mail.webhook'> = {
        aggregate: 'webhook-endpoint',
        aggregateId: endpoint.id,
        eventId: randomUUID(),
        occurredAt: NOW.toISOString(),
        orgId,
        payload: {
          endpointId: endpoint.id,
          notice: 'paused',
          orgId,
          pausedAt: NOW.toISOString(),
          recipientUserId: owner!.id,
        },
        traceId: null,
        type: 'mail.webhook',
      };
      return { email, endpointId: endpoint.id, event, orgId };
    }

    async function run(event: Envelope<'mail.webhook'>): Promise<void> {
      const message = await database.transaction((tx) => consumer.handle(event, tx));
      await consumer.effect(event, message);
    }

    beforeAll(async () => {
      // This suite's sends are pending and their `webhook.attempt-due` rows unpublished: a suite
      // that relays (the webhooks e2e) would otherwise claim and settle them in its own consumer,
      // racing the assertions here and the org delete below, whose cascade then waits on an
      // endpoint that settle holds while settle waits on the org row (both foreign keys).
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
      moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await moduleRef.init();
      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      transactions = moduleRef.get(TenantTransactionRunner);
      consumer = new WebhookMailConsumer(
        mailer,
        moduleRef.get(MembershipService),
        moduleRef.get(EndpointRepository),
        moduleRef.get(SendRepository),
        {
          get: (key: string) => ({ APP_URL: APP_URL })[key],
        } as unknown as ConfigService<Environment, true>,
      );
    }, LOCKED_BOOT_TIMEOUT_MS);

    afterEach(() => {
      mailer.clear();
    });

    afterAll(async () => {
      if (created.orgs.length > 0) {
        await database.delete(schema.orgs).where(inArray(schema.orgs.id, created.orgs));
      }
      if (created.users.length > 0) {
        await database.delete(schema.users).where(inArray(schema.users.id, created.users));
      }
      await moduleRef?.close();
      await suiteLock?.release();
    });

    it('drains mail on the events profile, concurrency 16, 5 attempts', () => {
      expect(moduleRef.get(WebhookMailConsumer)).toMatchObject({
        attempts: 5,
        concurrency: 16,
        profile: 'events',
        queue: 'mail',
        types: ['mail.webhook'],
      });
    });

    it("sends webhook-paused to the recipient with the host, the last failure's copy and the settings link", async () => {
      const paused = await fixture();

      await run(paused.event);

      const [mail] = mailer.outbox;
      expect(mailer.outbox).toHaveLength(1);
      expect(mail).toMatchObject({ template: 'webhook-paused', to: paused.email });
      expect(mail!.text).toContain('hooks.acme.example');
      expect(`${mail!.subject}${mail!.html}${mail!.text}`).not.toContain('/secret/path');
      expect(mail!.text).toContain('did not answer within 10 seconds');
      expect(mail!.text).toContain(webhooksSettingsUrl(APP_URL));
    });

    it('sends nothing once the endpoint is no longer paused, or was paused again later', async () => {
      const paused = await fixture(null);
      await run({
        ...paused.event,
        payload: { ...paused.event.payload, pausedAt: new Date(NOW.getTime() - 1).toISOString() },
      });
      await inTenant(paused.orgId, (tx) =>
        tx
          .update(schema.webhookEndpoints)
          .set({ pausedAt: null, state: 'enabled' })
          .where(eq(schema.webhookEndpoints.id, paused.endpointId)),
      );
      await run(paused.event);

      expect(mailer.outbox).toEqual([]);
    });

    it('classifies a failed send with classifyMailFailure', async () => {
      const paused = await fixture();
      const message = await database.transaction((tx) => consumer.handle(paused.event, tx));

      for (const reason of MAIL_FAILURE_REASONS) {
        const failed = mailFailed(reason, 'scripted');
        mailer.failNext(failed);

        const thrown = await consumer.effect(paused.event, message).then(
          () => expect.unreachable(`${reason} did not throw`),
          (error: unknown) => error,
        );

        expect(thrown, reason).toBeInstanceOf(Error);
        expect(thrown instanceof RetryableFailure, reason).toBe(failed.failure.retryable);
      }
    });

    it('dedupes the job on (endpointId, pausedAt, sha256(recipient))', () => {
      const endpointId = randomUUID();
      const recipientUserId = randomUUID();
      const event = {
        payload: {
          endpointId,
          notice: 'paused' as const,
          orgId: randomUUID(),
          pausedAt: NOW.toISOString(),
          recipientUserId,
        },
      } as Envelope<'mail.webhook'>;
      const hashed = createHash('sha256').update(recipientUserId).digest('hex');

      expect(webhookMailJobId(event)).toBe(
        `mail.webhook.paused.${endpointId}.${String(NOW.getTime())}.${hashed}`,
      );
      expect(webhookMailJobId({ ...event, eventId: randomUUID() })).toBe(webhookMailJobId(event));
    });
  });
});
