import { Test, type TestingModule } from '@nestjs/testing';
import { schema } from '@repo/db';
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { AppModule } from '../../../app.module';
import { CLOCK } from '../../../common/clock/clock.port';
import { FakeClock } from '../../../common/clock/fake-clock';
import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import type { Envelope } from '../../outbox/envelope';
import { OrgService } from '../../tenancy/services/org.service';
import { WEBHOOK_NOTICE_QUEUE } from '../webhooks.constants';
import { EndpointService } from './endpoint.service';
import { WebhookNoticeConsumer } from './notice.consumer';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const NOW = new Date('2026-09-23T12:00:00.000Z');

/**
 * Spec 029 T058 — `WebhookNoticeConsumer`: a `webhook.endpoint-paused` becomes one `mail.webhook`
 * per recipient of `MembershipService.noticeRecipients(tx, orgId, null)` (the accepted owners), in
 * the consumer's own transaction; an endpoint no longer paused sends nothing.
 */
describe('WebhookNoticeConsumer', () => {
  describe.skipIf(!postgres || !redis)('against Postgres', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    let consumer: WebhookNoticeConsumer;
    const clock = new FakeClock(NOW);
    const created: { orgs: string[]; users: string[] } = { orgs: [], users: [] };

    function inTenant<T>(orgId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantTransaction(orgId, fn);
    }

    async function user(): Promise<string> {
      const [row] = await database
        .insert(schema.users)
        .values({ email: `029n-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });
      created.users.push(row!.id);
      return row!.id;
    }

    /** An org with an owner, a second owner, an admin and a pending owner, and one endpoint. */
    async function fixture(state: 'enabled' | 'paused') {
      const [owner, coOwner, admin, invited] = await Promise.all([user(), user(), user(), user()]);
      const orgId = (
        await moduleRef.get(OrgService).create(owner, {
          name: 'Webhook notice fixture',
          slug: `029n-${randomUUID().slice(0, 8)}`,
        })
      ).id;
      created.orgs.push(orgId);
      await inTenant(orgId, (tx) =>
        tx.insert(schema.memberships).values([
          { acceptedAt: NOW, orgId, role: 'owner', userId: coOwner },
          { acceptedAt: NOW, orgId, role: 'admin', userId: admin },
          { acceptedAt: null, orgId, role: 'owner', userId: invited },
        ]),
      );
      const { endpoint } = await inTenant(orgId, (tx) =>
        moduleRef.get(EndpointService).create(tx, orgId, admin, {
          description: '',
          eventTypes: ['deploy.succeeded'],
          projectIds: [],
          url: 'https://receiver.example.com/hook',
        }),
      );
      if (state === 'paused') {
        await inTenant(orgId, (tx) =>
          tx
            .update(schema.webhookEndpoints)
            .set({ pausedAt: NOW, state: 'paused' })
            .where(eq(schema.webhookEndpoints.id, endpoint.id)),
        );
      }
      const event: Envelope<'webhook.endpoint-paused'> = {
        aggregate: 'webhook-endpoint',
        aggregateId: endpoint.id,
        eventId: randomUUID(),
        occurredAt: NOW.toISOString(),
        orgId,
        payload: { endpointId: endpoint.id, orgId },
        traceId: null,
        type: 'webhook.endpoint-paused',
      };
      return { coOwner, endpointId: endpoint.id, event, orgId, owner };
    }

    function mails(endpointId: string) {
      return database
        .select({ payload: schema.outbox.payload })
        .from(schema.outbox)
        .where(
          and(eq(schema.outbox.type, 'mail.webhook'), eq(schema.outbox.aggregateId, endpointId)),
        );
    }

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(CLOCK)
        .useValue(clock)
        .compile();
      await moduleRef.init();
      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      transactions = moduleRef.get(TenantTransactionRunner);
      consumer = moduleRef.get(WebhookNoticeConsumer);
    }, 60_000);

    afterAll(async () => {
      if (created.orgs.length > 0) {
        await database.delete(schema.orgs).where(inArray(schema.orgs.id, created.orgs));
      }
      if (created.users.length > 0) {
        await database.delete(schema.users).where(inArray(schema.users.id, created.users));
      }
      await moduleRef?.close();
    });

    it('drains webhook.notice on the events profile, concurrency 4, 5 attempts', () => {
      expect(consumer).toMatchObject({
        attempts: 5,
        concurrency: 4,
        profile: 'events',
        queue: WEBHOOK_NOTICE_QUEUE,
        types: ['webhook.endpoint-paused'],
      });
    });

    it('appends one mail.webhook per accepted owner, naming the pause', async () => {
      const paused = await fixture('paused');

      await database.transaction((tx) => consumer.handle(paused.event, tx));

      const payloads = (await mails(paused.endpointId)).map((row) => row.payload);
      expect(
        payloads.sort((a, b) => String(a.recipientUserId).localeCompare(String(b.recipientUserId))),
      ).toEqual(
        [paused.owner, paused.coOwner].sort().map((recipientUserId) => ({
          endpointId: paused.endpointId,
          notice: 'paused',
          orgId: paused.orgId,
          pausedAt: NOW.toISOString(),
          recipientUserId,
        })),
      );
    });

    it('appends nothing when the endpoint is no longer paused', async () => {
      const enabled = await fixture('enabled');

      await database.transaction((tx) => consumer.handle(enabled.event, tx));

      expect(await mails(enabled.endpointId)).toEqual([]);
    });
  });
});
