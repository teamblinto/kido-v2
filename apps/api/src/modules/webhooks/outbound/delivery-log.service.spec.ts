import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import {
  webhookDeliveryListSchema,
  webhookDeliverySchema,
  webhookDeliverySummarySchema,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { holdOutboxSuiteLock } from '../../../../test/support/outbox-suite-lock';

import { FakeResolver } from '../../../../test/support/fake-resolver';
import { AppModule } from '../../../app.module';
import { CLOCK } from '../../../common/clock/clock.port';
import { FakeClock } from '../../../common/clock/fake-clock';
import { NotFoundError } from '../../../common/errors/domain-error';
import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import type { Envelope } from '../../outbox/envelope';
import { OrgService } from '../../tenancy/services/org.service';
import { WebhookAttemptConsumer } from './attempt.consumer';
import { DeliveryLogService } from './delivery-log.service';
import { EndpointService } from './endpoint.service';
import { WEBHOOK_RESOLVER } from './resolver.port';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

/** The suite lock may wait out a relaying suite before the module boots. */
const LOCKED_BOOT_TIMEOUT_MS = 600_000;

const NOW = new Date('2026-09-23T12:00:00.000Z');
const DAY = 86_400_000;

type SendFields = Partial<typeof schema.webhookSends.$inferInsert>;

function refusal(reason: string) {
  return { extensions: expect.objectContaining({ reason }) as unknown };
}

/**
 * Spec 029 T070 — `DeliveryLogService` against Postgres (research R11): the log newest first,
 * filtered and paged by a `(created_at desc, id)` cursor inside the 30-day window; one delivery
 * with its attempts; and replay, refused when the body has expired or an attempt is in flight,
 * otherwise one manual attempt outside the schedule, audited.
 */
describe('DeliveryLogService', () => {
  describe.skipIf(!postgres || !redis)('against Postgres', () => {
    let moduleRef: TestingModule;
    let suiteLock: { release: () => Promise<void> } | undefined;
    let database: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    let service: DeliveryLogService;
    const clock = new FakeClock(NOW);
    const created: { orgs: string[]; users: string[] } = { orgs: [], users: [] };

    function inTenant<T>(orgId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantTransaction(orgId, fn);
    }

    /** An org with one endpoint whose host resolves to nothing (every attempt is `dns-failed`). */
    async function tenant(): Promise<{ endpointId: string; orgId: string; userId: string }> {
      const [user] = await database
        .insert(schema.users)
        .values({ email: `029l-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });
      created.users.push(user!.id);
      const orgId = (
        await moduleRef.get(OrgService).create(user!.id, {
          name: 'Webhook log fixture',
          slug: `029l-${randomUUID().slice(0, 8)}`,
        })
      ).id;
      created.orgs.push(orgId);
      const endpointId = await endpoint(orgId, user!.id);
      return { endpointId, orgId, userId: user!.id };
    }

    async function endpoint(orgId: string, userId: string): Promise<string> {
      const { endpoint: row } = await inTenant(orgId, (tx) =>
        moduleRef.get(EndpointService).create(tx, orgId, userId, {
          description: '',
          eventTypes: ['deploy.succeeded', 'deploy.failed'],
          projectIds: [],
          url: 'https://nowhere.log-fixture.test/hook',
        }),
      );
      return row.id;
    }

    /** One send per `fields`, `failed` and settled unless told otherwise. */
    async function sends(
      orgId: string,
      endpointId: string,
      ...fields: SendFields[]
    ): Promise<string[]> {
      const rows = await inTenant(orgId, (tx) =>
        tx
          .insert(schema.webhookSends)
          .values(
            fields.map((field) => ({
              attempts: 1,
              body: '{"type":"deploy.succeeded"}',
              createdAt: NOW,
              endpointId,
              eventId: randomUUID(),
              eventType: 'deploy.succeeded',
              lastFailure: 'http-error',
              nextAttemptAt: null,
              occurredAt: NOW,
              orgId,
              state: 'failed' as const,
              updatedAt: NOW,
              ...field,
            })),
          )
          .returning({ id: schema.webhookSends.id }),
      );
      return rows.map((row) => row.id);
    }

    function list(
      orgId: string,
      endpointId: string,
      query: Parameters<DeliveryLogService['list']>[3] = {},
    ) {
      return inTenant(orgId, (tx) => service.list(tx, orgId, endpointId, query));
    }

    function sendRow(orgId: string, sendId: string) {
      return inTenant(orgId, async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.webhookSends)
          .where(eq(schema.webhookSends.id, sendId));
        return row!;
      });
    }

    function attemptDue(sendId: string) {
      return database
        .select({ id: schema.outbox.id, payload: schema.outbox.payload })
        .from(schema.outbox)
        .where(
          and(eq(schema.outbox.type, 'webhook.attempt-due'), eq(schema.outbox.aggregateId, sendId)),
        );
    }

    function refused(promise: Promise<unknown>): Promise<unknown> {
      return promise.then(
        () => expect.unreachable('expected a refusal'),
        (error: unknown) => error,
      );
    }

    beforeAll(async () => {
      // This suite's sends are pending and their `webhook.attempt-due` rows unpublished: a suite
      // that relays (the webhooks e2e) would otherwise claim and settle them in its own consumer,
      // racing the assertions here and the org delete below, whose cascade then waits on an
      // endpoint that settle holds while settle waits on the org row (both foreign keys).
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
      moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(CLOCK)
        .useValue(clock)
        .overrideProvider(WEBHOOK_RESOLVER)
        .useValue(new FakeResolver())
        .compile();
      await moduleRef.init();
      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      transactions = moduleRef.get(TenantTransactionRunner);
      service = moduleRef.get(DeliveryLogService);
    }, LOCKED_BOOT_TIMEOUT_MS);

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

    describe('list', () => {
      it('returns deliveries newest first', async () => {
        const who = await tenant();
        const [older, newer, newest] = await sends(
          who.orgId,
          who.endpointId,
          { createdAt: new Date(NOW.getTime() - 2 * DAY) },
          { createdAt: new Date(NOW.getTime() - DAY) },
          { createdAt: NOW },
        );

        const page = webhookDeliveryListSchema.parse(await list(who.orgId, who.endpointId));

        expect(page.items.map((item) => item.id)).toEqual([newest, newer, older]);
        expect(page.nextCursor).toBeNull();
        expect(page.items[0]).toMatchObject({
          attempts: 1,
          eventType: 'deploy.succeeded',
          lastFailure: 'http-error',
          nextAttemptAt: null,
          state: 'failed',
        });
      });

      it('filters by state and by event type', async () => {
        const who = await tenant();
        const [failed, succeeded, otherType] = await sends(
          who.orgId,
          who.endpointId,
          {},
          { lastFailure: null, state: 'succeeded' },
          { eventType: 'deploy.failed' },
        );

        const byState = await list(who.orgId, who.endpointId, { state: 'succeeded' });
        const byType = await list(who.orgId, who.endpointId, { eventType: 'deploy.failed' });
        const both = await list(who.orgId, who.endpointId, {
          eventType: 'deploy.succeeded',
          state: 'failed',
        });

        expect(byState.items.map((item) => item.id)).toEqual([succeeded]);
        expect(byType.items.map((item) => item.id)).toEqual([otherType]);
        expect(both.items.map((item) => item.id)).toEqual([failed]);
      });

      it('pages through 50-item pages on a cursor that is stable under inserts', async () => {
        const who = await tenant();
        const ids = await sends(
          who.orgId,
          who.endpointId,
          ...Array.from({ length: 120 }, (_, index) => ({
            createdAt: new Date(NOW.getTime() - 1_000 * (index % 60)),
          })),
        );

        const first = await list(who.orgId, who.endpointId);
        expect(first.items).toHaveLength(50);
        expect(first.nextCursor).not.toBeNull();

        // Newer rows arrive between the pages; the next page is unaffected by them.
        await sends(who.orgId, who.endpointId, { createdAt: NOW }, { createdAt: NOW });

        const second = await list(who.orgId, who.endpointId, { cursor: first.nextCursor! });
        const third = await list(who.orgId, who.endpointId, { cursor: second.nextCursor! });
        expect(second.items).toHaveLength(50);
        expect(third.items).toHaveLength(20);
        expect(third.nextCursor).toBeNull();

        const seen = [...first.items, ...second.items, ...third.items].map((item) => item.id);
        expect(new Set(seen).size).toBe(120);
        expect([...seen].sort()).toEqual([...ids].sort());
      });

      it('excludes deliveries older than 30 days', async () => {
        const who = await tenant();
        const [kept] = await sends(
          who.orgId,
          who.endpointId,
          { createdAt: new Date(NOW.getTime() - 29 * DAY) },
          { createdAt: new Date(NOW.getTime() - 31 * DAY) },
        );

        const page = await list(who.orgId, who.endpointId);

        expect(page.items.map((item) => item.id)).toEqual([kept]);
      });

      it("shows only the endpoint's own deliveries, and 404s an unknown endpoint", async () => {
        const who = await tenant();
        const other = await endpoint(who.orgId, who.userId);
        const [mine] = await sends(who.orgId, who.endpointId, {});
        await sends(who.orgId, other, {});

        expect((await list(who.orgId, who.endpointId)).items.map((item) => item.id)).toEqual([
          mine,
        ]);
        await expect(list(who.orgId, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
        await expect(list(who.orgId, 'not-a-uuid')).rejects.toBeInstanceOf(NotFoundError);
      });
    });

    describe('get', () => {
      it('returns attempts newest first, with the body', async () => {
        const who = await tenant();
        const [sendId] = await sends(who.orgId, who.endpointId, { attempts: 2 });
        await inTenant(who.orgId, (tx) =>
          tx.insert(schema.webhookSendAttempts).values([
            {
              attemptedAt: new Date(NOW.getTime() - 60_000),
              durationMs: 12,
              failure: 'http-error',
              manual: false,
              orgId: who.orgId,
              responseBody: 'first',
              responseHeaders: { 'content-type': 'text/plain' },
              sendId: sendId!,
              status: 503,
            },
            {
              address: '203.0.113.9',
              attemptedAt: NOW,
              durationMs: 7,
              failure: 'http-error',
              manual: false,
              orgId: who.orgId,
              responseBody: 'second',
              responseHeaders: { 'x-request-id': 'abc' },
              sendId: sendId!,
              status: 500,
            },
          ]),
        );

        const delivery = webhookDeliverySchema.parse(
          await inTenant(who.orgId, (tx) => service.get(tx, who.orgId, who.endpointId, sendId!)),
        );

        expect(delivery.body).toBe('{"type":"deploy.succeeded"}');
        expect(delivery.attemptLog).toEqual([
          {
            address: '203.0.113.9',
            attemptedAt: NOW.toISOString(),
            durationMs: 7,
            failure: 'http-error',
            manual: false,
            responseBody: 'second',
            responseHeaders: { 'x-request-id': 'abc' },
            status: 500,
          },
          {
            address: null,
            attemptedAt: new Date(NOW.getTime() - 60_000).toISOString(),
            durationMs: 12,
            failure: 'http-error',
            manual: false,
            responseBody: 'first',
            responseHeaders: { 'content-type': 'text/plain' },
            status: 503,
          },
        ]);
      });

      it('404s a delivery read through another endpoint, an unknown id, and one past 30 days', async () => {
        const who = await tenant();
        const other = await endpoint(who.orgId, who.userId);
        const [sendId, old] = await sends(
          who.orgId,
          who.endpointId,
          {},
          { createdAt: new Date(NOW.getTime() - 31 * DAY) },
        );

        for (const [endpointId, id] of [
          [other, sendId!],
          [who.endpointId, randomUUID()],
          [who.endpointId, 'not-a-uuid'],
          [who.endpointId, old!],
        ] as const) {
          await expect(
            inTenant(who.orgId, (tx) => service.get(tx, who.orgId, endpointId, id)),
          ).rejects.toBeInstanceOf(NotFoundError);
        }
      });
    });

    describe('replay', () => {
      function replay(who: { endpointId: string; orgId: string; userId: string }, id: string) {
        return inTenant(who.orgId, (tx) =>
          service.replay(tx, who.orgId, who.userId, who.endpointId, id),
        );
      }

      it('is refused with delivery-expired when the body is null', async () => {
        const who = await tenant();
        const [sendId] = await sends(who.orgId, who.endpointId, { body: null });

        expect(await refused(replay(who, sendId!))).toMatchObject(refusal('delivery-expired'));
        expect(await attemptDue(sendId!)).toEqual([]);
      });

      it('is refused with delivery-in-flight while claimed', async () => {
        const who = await tenant();
        const [claimed, pending] = await sends(
          who.orgId,
          who.endpointId,
          {
            claimedUntil: new Date(NOW.getTime() + 20_000),
            nextAttemptAt: NOW,
            state: 'pending',
          },
          { nextAttemptAt: new Date(NOW.getTime() + 60_000), state: 'pending' },
        );

        for (const id of [claimed!, pending!]) {
          expect(await refused(replay(who, id))).toMatchObject(refusal('delivery-in-flight'));
          expect(await attemptDue(id)).toEqual([]);
        }
      });

      it('sets pending, appends webhook.attempt-due with the manual flag, leaves attempts unchanged and audits', async () => {
        const who = await tenant();
        const [sendId] = await sends(who.orgId, who.endpointId, { attempts: 3 });

        const summary = webhookDeliverySummarySchema.parse(await replay(who, sendId!));

        expect(summary).toMatchObject({ attempts: 3, id: sendId, state: 'pending' });
        const row = await sendRow(who.orgId, sendId!);
        expect(row).toMatchObject({ attempts: 3, claimedUntil: null, state: 'pending' });
        expect(await attemptDue(sendId!)).toMatchObject([
          { payload: { manual: true, orgId: who.orgId, sendId } },
        ]);
        const audits = await inTenant(who.orgId, (tx) =>
          tx
            .select({
              action: schema.auditLog.action,
              actorId: schema.auditLog.actorId,
              target: schema.auditLog.target,
            })
            .from(schema.auditLog)
            .where(eq(schema.auditLog.action, 'webhook.send-replayed')),
        );
        expect(audits).toEqual([
          { action: 'webhook.send-replayed', actorId: who.userId, target: sendId },
        ]);
      });

      it('404s a delivery replayed through another endpoint', async () => {
        const who = await tenant();
        const other = await endpoint(who.orgId, who.userId);
        const [sendId] = await sends(who.orgId, who.endpointId, {});

        await expect(
          inTenant(who.orgId, (tx) => service.replay(tx, who.orgId, who.userId, other, sendId!)),
        ).rejects.toBeInstanceOf(NotFoundError);
        expect(await attemptDue(sendId!)).toEqual([]);
      });

      it('a failed manual attempt leaves the delivery failed and schedules nothing', async () => {
        const who = await tenant();
        const [sendId] = await sends(who.orgId, who.endpointId, {
          attempts: 8,
          lastFailure: 'http-error',
        });
        await replay(who, sendId!);
        const [due] = await attemptDue(sendId!);
        const event: Envelope<'webhook.attempt-due'> = {
          aggregate: 'webhook-send',
          aggregateId: sendId!,
          eventId: due!.id,
          occurredAt: NOW.toISOString(),
          orgId: who.orgId,
          payload: due!.payload as Envelope<'webhook.attempt-due'>['payload'],
          traceId: null,
          type: 'webhook.attempt-due',
        };
        const consumer = moduleRef.get(WebhookAttemptConsumer);

        // The endpoint's host resolves to nothing: `dns-failed`, which the schedule would retry.
        const plan = await database.transaction((tx) => consumer.handle(event, tx));
        await consumer.effect(event, plan);

        expect(await sendRow(who.orgId, sendId!)).toMatchObject({
          attempts: 8,
          claimedUntil: null,
          lastFailure: 'dns-failed',
          nextAttemptAt: null,
          state: 'failed',
        });
        const attempts = await inTenant(who.orgId, (tx) =>
          tx
            .select({ manual: schema.webhookSendAttempts.manual })
            .from(schema.webhookSendAttempts)
            .where(eq(schema.webhookSendAttempts.sendId, sendId!)),
        );
        expect(attempts).toEqual([{ manual: true }]);
        expect(await attemptDue(sendId!)).toHaveLength(1);
      });
    });
  });
});
