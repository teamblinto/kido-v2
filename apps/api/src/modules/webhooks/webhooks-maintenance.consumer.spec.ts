import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { holdOutboxSuiteLock } from '../../../test/support/outbox-suite-lock';

import { AppModule } from '../../app.module';
import { CLOCK } from '../../common/clock/clock.port';
import { FakeClock } from '../../common/clock/fake-clock';
import { APP_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import type { Envelope } from '../outbox/envelope';
import { OrgService } from '../tenancy/services/org.service';
import { EndpointService } from './outbound/endpoint.service';
import { WEBHOOK_SWEEP_QUEUE } from './webhooks.constants';
import { WebhooksMaintenanceConsumer } from './webhooks-maintenance.consumer';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

/** The suite lock may wait out a relaying suite before the module boots. */
const LOCKED_BOOT_TIMEOUT_MS = 600_000;

/**
 * Years before any other suite's clock: the bypass probe runs across every org, and at this `now`
 * only this suite's rows are due. (A later clock would claim, and so disturb, other suites' sends.)
 */
const NOW = new Date('2020-03-01T00:00:00.000Z');

function tick(job: 'webhook.redeliver' | 'webhook.retention'): Envelope<'maintenance.due'> {
  return {
    aggregate: 'maintenance',
    aggregateId: job,
    eventId: randomUUID(),
    occurredAt: NOW.toISOString(),
    orgId: null,
    payload: { job, periodStart: NOW.toISOString() },
    traceId: null,
    type: 'maintenance.due',
  };
}

/**
 * Spec 029 T057 — the `webhook.redeliver` arm of `maintenance.due` (research R6): a `forge_bypass`
 * probe of due, unclaimed `pending` sends (at most 500, at most 50 per org), each claimed and given
 * a `webhook.attempt-due` in its own org's tenant transaction.
 *
 * T071 — the outbound half of `webhook.retention` (research R12, ADR 051): per org, bodies and
 * response bodies nulled at 7 days, sends deleted at 30 with their attempts. T089 — and the inbound
 * half, moved here from `connectors`: `webhook_deliveries` bodies at 7 days, rows at 30. T082 —
 * and expired rotation overlaps: `previous_*` cleared and the previous `secrets` row deleted.
 */
describe('WebhooksMaintenanceConsumer', () => {
  describe.skipIf(!postgres || !redis)('against Postgres', () => {
    let moduleRef: TestingModule;
    let suiteLock: { release: () => Promise<void> } | undefined;
    let database: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    let consumer: WebhooksMaintenanceConsumer;
    const clock = new FakeClock(NOW);
    const created: { orgs: string[]; users: string[] } = { orgs: [], users: [] };

    function inTenant<T>(orgId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantTransaction(orgId, fn);
    }

    /** An org with one endpoint and `count` sends in `state`, due at `dueAt` when pending. */
    async function orgWithSends(
      count: number,
      fields: Partial<typeof schema.webhookSends.$inferInsert> = {},
    ): Promise<{ orgId: string; sendIds: string[] }> {
      const [user] = await database
        .insert(schema.users)
        .values({ email: `029m-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });
      created.users.push(user!.id);
      const orgId = (
        await moduleRef.get(OrgService).create(user!.id, {
          name: 'Webhook sweep fixture',
          slug: `029m-${randomUUID().slice(0, 8)}`,
        })
      ).id;
      created.orgs.push(orgId);
      const { endpoint } = await inTenant(orgId, (tx) =>
        moduleRef.get(EndpointService).create(tx, orgId, user!.id, {
          description: '',
          eventTypes: ['deploy.succeeded'],
          projectIds: [],
          url: 'https://receiver.example.com/hook',
        }),
      );
      const rows = await inTenant(orgId, (tx) =>
        tx
          .insert(schema.webhookSends)
          .values(
            Array.from({ length: count }, (_, index) => ({
              body: '{}',
              createdAt: NOW,
              endpointId: endpoint.id,
              eventId: randomUUID(),
              eventType: 'deploy.succeeded',
              nextAttemptAt: new Date(NOW.getTime() - 60_000 - index),
              occurredAt: NOW,
              orgId,
              state: 'pending' as const,
              updatedAt: NOW,
              ...fields,
            })),
          )
          .returning({ id: schema.webhookSends.id }),
      );
      return { orgId, sendIds: rows.map((row) => row.id) };
    }

    function attemptDue(sendIds: readonly string[]) {
      return database
        .select({ aggregateId: schema.outbox.aggregateId, payload: schema.outbox.payload })
        .from(schema.outbox)
        .where(
          and(
            eq(schema.outbox.type, 'webhook.attempt-due'),
            inArray(schema.outbox.aggregateId, [...sendIds]),
          ),
        );
    }

    function sends(orgId: string, sendIds: readonly string[]) {
      return inTenant(orgId, (tx) =>
        tx
          .select()
          .from(schema.webhookSends)
          .where(inArray(schema.webhookSends.id, [...sendIds])),
      );
    }

    function sendsOfOrg(orgId: string) {
      return inTenant(orgId, (tx) =>
        tx
          .select({ body: schema.webhookSends.body, id: schema.webhookSends.id })
          .from(schema.webhookSends)
          .where(eq(schema.webhookSends.orgId, orgId)),
      );
    }

    function attemptsOfOrg(orgId: string) {
      return inTenant(orgId, (tx) =>
        tx
          .select({
            responseBody: schema.webhookSendAttempts.responseBody,
            sendId: schema.webhookSendAttempts.sendId,
          })
          .from(schema.webhookSendAttempts)
          .where(eq(schema.webhookSendAttempts.orgId, orgId)),
      );
    }

    /** One attempt per send, attempted when the send was created, with a response body. */
    async function attemptEach(orgId: string, sendIds: readonly string[]): Promise<void> {
      const rows = await sends(orgId, sendIds);
      await inTenant(orgId, (tx) =>
        tx.insert(schema.webhookSendAttempts).values(
          rows.map((row) => ({
            attemptedAt: row.createdAt,
            durationMs: 5,
            failure: null,
            manual: false,
            orgId,
            responseBody: 'ok',
            responseHeaders: {},
            sendId: row.id,
            status: 200,
          })),
        ),
      );
    }

    async function retention(): Promise<void> {
      const event = tick('webhook.retention');
      await consumer.effect(event, await consumer.handle(event));
    }

    async function redeliver(): Promise<void> {
      const event = tick('webhook.redeliver');
      await consumer.effect(event, await consumer.handle(event));
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
        .compile();
      await moduleRef.init();
      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      transactions = moduleRef.get(TenantTransactionRunner);
      consumer = moduleRef.get(WebhooksMaintenanceConsumer);
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

    it('consumes maintenance.due on its own events-profile queue', () => {
      expect(consumer).toMatchObject({
        profile: 'events',
        queue: WEBHOOK_SWEEP_QUEUE,
        types: ['maintenance.due'],
      });
    });

    it('owns webhook.redeliver and leaves every other job alone', async () => {
      await expect(consumer.handle(tick('webhook.redeliver'))).resolves.toBe('webhook.redeliver');
      await expect(
        consumer.handle({
          ...tick('webhook.redeliver'),
          payload: { job: 'domain.check', periodStart: NOW.toISOString() },
        }),
      ).resolves.toBeNull();
    });

    it('claims each due pending send and appends one webhook.attempt-due in its own org', async () => {
      const a = await orgWithSends(2);
      const b = await orgWithSends(1);

      await redeliver();

      for (const org of [a, b]) {
        const due = await attemptDue(org.sendIds);
        expect(
          due
            .map((row) => row.payload)
            .sort((x, y) => String(x.sendId).localeCompare(String(y.sendId))),
        ).toEqual([...org.sendIds].sort().map((sendId) => ({ orgId: org.orgId, sendId })));
        for (const row of await sends(org.orgId, org.sendIds)) {
          expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(NOW.getTime());
          expect(row.state).toBe('pending');
        }
      }

      // Claimed: the next tick appends nothing more for them.
      await redeliver();
      expect(await attemptDue([...a.sendIds, ...b.sendIds])).toHaveLength(3);
    });

    it('takes at most 50 per org in one tick', async () => {
      const busy = await orgWithSends(60);

      await redeliver();

      expect(await attemptDue(busy.sendIds)).toHaveLength(50);
    });

    it('takes at most 500 in one tick', async () => {
      // Drain anything of this suite still due, so the cap is spent on this test's rows.
      for (let pass = 0; pass < 100 && (await consumer.redeliver()).claimed > 0; pass += 1);
      const orgs = await Promise.all(Array.from({ length: 11 }, () => orgWithSends(50)));
      const all = orgs.flatMap((org) => org.sendIds);

      expect(await consumer.redeliver()).toEqual({ claimed: 500, due: 500 });
      expect(await attemptDue(all)).toHaveLength(500);
      expect(await consumer.redeliver()).toEqual({ claimed: 50, due: 50 });
      expect(await attemptDue(all)).toHaveLength(550);
    });

    it("narrowed to some orgs, leaves every other org's due sends alone", async () => {
      const mine = await orgWithSends(1);
      const other = await orgWithSends(1);

      expect(await consumer.redeliver([mine.orgId])).toEqual({ claimed: 1, due: 1 });

      expect(await attemptDue(mine.sendIds)).toHaveLength(1);
      expect(await attemptDue(other.sendIds)).toEqual([]);
      await redeliver();
    });

    it('skips a send claimed by an in-flight attempt', async () => {
      const held = await orgWithSends(1, { claimedUntil: new Date(NOW.getTime() + 20_000) });

      await redeliver();

      expect(await attemptDue(held.sendIds)).toEqual([]);
    });

    it('touches nothing outside pending, and nothing not yet due', async () => {
      const settled = await orgWithSends(1, { nextAttemptAt: null, state: 'failed' });
      const notSent = await orgWithSends(1, { nextAttemptAt: null, state: 'not_sent' });
      const later = await orgWithSends(1, { nextAttemptAt: new Date(NOW.getTime() + 60_000) });
      const before = await Promise.all(
        [settled, notSent, later].map((org) => sends(org.orgId, org.sendIds)),
      );

      await redeliver();

      expect(await attemptDue([...settled.sendIds, ...notSent.sendIds, ...later.sendIds])).toEqual(
        [],
      );
      const after = await Promise.all(
        [settled, notSent, later].map((org) => sends(org.orgId, org.sendIds)),
      );
      expect(after).toEqual(before);
    });

    describe('webhook.retention, outbound (T071)', () => {
      const DAY = 86_400_000;
      const at = (days: number) => new Date(NOW.getTime() - days * DAY);
      const settled = (days: number) => ({
        createdAt: at(days),
        nextAttemptAt: null,
        state: 'succeeded' as const,
      });

      it('owns webhook.retention', async () => {
        await expect(consumer.handle(tick('webhook.retention'))).resolves.toBe('webhook.retention');
      });

      it('per org, nulls bodies and response bodies past 7 days and deletes sends past 30 with their attempts', async () => {
        const orgs = [await orgWithSends(1, settled(6)), await orgWithSends(1, settled(6))];
        for (const org of orgs) {
          const endpointId = (
            await inTenant(org.orgId, (tx) =>
              tx.select({ id: schema.webhookEndpoints.id }).from(schema.webhookEndpoints),
            )
          )[0]!.id;
          const more = await inTenant(org.orgId, (tx) =>
            tx
              .insert(schema.webhookSends)
              .values(
                [settled(8), settled(31)].map((fields) => ({
                  body: '{}',
                  endpointId,
                  eventId: randomUUID(),
                  eventType: 'deploy.succeeded',
                  occurredAt: fields.createdAt,
                  orgId: org.orgId,
                  updatedAt: fields.createdAt,
                  ...fields,
                })),
              )
              .returning({ id: schema.webhookSends.id }),
          );
          org.sendIds.push(...more.map((row) => row.id));
          await attemptEach(org.orgId, org.sendIds);
        }

        await retention();

        for (const org of orgs) {
          const [fresh, week, month] = org.sendIds;
          const rows = new Map((await sendsOfOrg(org.orgId)).map((row) => [row.id, row.body]));
          expect(Object.fromEntries(rows)).toEqual({ [fresh!]: '{}', [week!]: null });
          expect(rows.has(month!)).toBe(false);
          const attempts = new Map(
            (await attemptsOfOrg(org.orgId)).map((row) => [row.sendId, row.responseBody]),
          );
          expect(Object.fromEntries(attempts)).toEqual({ [fresh!]: 'ok', [week!]: null });
        }
      });

      it('skips an endpoint a delete holds, in the delete’s lock order, instead of waiting on its cascade', async () => {
        const held = await orgWithSends(2, settled(31));
        const other = await orgWithSends(1, settled(31));
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let deleting!: () => void;
        const started = new Promise<void>((resolve) => (deleting = resolve));
        // An endpoint delete in flight: the row and its cascade to the sends, held uncommitted.
        const holder = inTenant(held.orgId, async (tx) => {
          await tx
            .delete(schema.webhookEndpoints)
            .where(eq(schema.webhookEndpoints.orgId, held.orgId));
          deleting();
          await gate;
          throw new Error('roll the delete back');
        }).catch((error: unknown) => error);
        await started;

        try {
          const pass = consumer.retain([held.orgId, other.orgId]);
          const outcome = await Promise.race([
            pass.then((result) => result.outbound.sendsDeleted),
            new Promise<'waited'>((resolve) => setTimeout(() => resolve('waited'), 3_000)),
          ]);
          expect(outcome).toBe(1);
        } finally {
          release();
          await holder;
        }

        expect((await sendsOfOrg(held.orgId)).map((row) => row.id).sort()).toEqual(
          [...held.sendIds].sort(),
        );
        expect(await sendsOfOrg(other.orgId)).toEqual([]);
      });

      it('clears an expired rotation overlap and deletes its previous secret, leaving a live one (T082)', async () => {
        const { orgId } = await orgWithSends(1, {
          createdAt: NOW,
          nextAttemptAt: null,
          state: 'succeeded',
        });
        const userId = created.users.at(-1)!;
        const service = moduleRef.get(EndpointService);
        const second = await inTenant(orgId, (tx) =>
          service.create(tx, orgId, userId, {
            description: '',
            eventTypes: ['deploy.succeeded'],
            projectIds: [],
            url: 'https://receiver.example.com/other',
          }),
        );
        const [first] = await inTenant(orgId, (tx) =>
          tx
            .select({ id: schema.webhookEndpoints.id })
            .from(schema.webhookEndpoints)
            .where(
              and(
                eq(schema.webhookEndpoints.orgId, orgId),
                ne(schema.webhookEndpoints.id, second.endpoint.id),
              ),
            ),
        );
        const [expired, live] = [first!.id, second.endpoint.id];

        // `expired` rotated 25 h ago, `live` 1 h ago: only the first overlap has ended at NOW.
        clock.set(new Date(NOW.getTime() - 25 * 3_600_000));
        await inTenant(orgId, (tx) =>
          service.rotateSecret(tx, orgId, userId, expired, { expireOld: false }),
        );
        clock.set(new Date(NOW.getTime() - 3_600_000));
        await inTenant(orgId, (tx) =>
          service.rotateSecret(tx, orgId, userId, live, { expireOld: false }),
        );
        clock.set(NOW);
        const endpoints = () =>
          inTenant(orgId, (tx) =>
            tx
              .select()
              .from(schema.webhookEndpoints)
              .where(eq(schema.webhookEndpoints.orgId, orgId)),
          );
        const before = new Map((await endpoints()).map((row) => [row.id, row]));

        await retention();

        const after = new Map((await endpoints()).map((row) => [row.id, row]));
        expect(after.get(expired)).toMatchObject({
          previousSecretExpiresAt: null,
          previousSecretId: null,
          secretId: before.get(expired)!.secretId,
        });
        expect(after.get(live)).toMatchObject({
          previousSecretExpiresAt: before.get(live)!.previousSecretExpiresAt,
          previousSecretId: before.get(live)!.previousSecretId,
        });
        const secretIds = await inTenant(orgId, (tx) =>
          tx
            .select({ id: schema.secrets.id })
            .from(schema.secrets)
            .where(eq(schema.secrets.orgId, orgId)),
        );
        const ids = new Set(secretIds.map((row) => row.id));
        expect(ids.has(before.get(expired)!.previousSecretId!)).toBe(false);
        expect(ids.has(before.get(expired)!.secretId)).toBe(true);
        expect(ids.has(before.get(live)!.previousSecretId!)).toBe(true);
        expect(ids.has(before.get(live)!.secretId)).toBe(true);
      });

      it('nulls inbound bodies past 7 days and deletes inbound deliveries past 30 (T089)', async () => {
        const rows = await database
          .insert(schema.webhookDeliveries)
          .values(
            [6, 8, 31].map((days) => ({
              body: { zen: 'x' },
              deliveryId: `029m-${randomUUID()}`,
              eventType: 'push',
              provider: 'github' as const,
              receivedAt: at(days),
              state: 'processed' as const,
            })),
          )
          .returning({ id: schema.webhookDeliveries.id });

        await retention();

        const left = await database
          .select({ body: schema.webhookDeliveries.body, id: schema.webhookDeliveries.id })
          .from(schema.webhookDeliveries)
          .where(
            inArray(
              schema.webhookDeliveries.id,
              rows.map((row) => row.id),
            ),
          );
        expect(Object.fromEntries(left.map((row) => [row.id, row.body]))).toEqual({
          [rows[0]!.id]: { zen: 'x' },
          [rows[1]!.id]: null,
        });
      });
    });
  });
});
