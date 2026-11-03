import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import { holdOutboxSuiteLock } from '../../../../test/support/outbox-suite-lock';

import {
  type FakeReceiver,
  hang,
  respond,
  startFakeReceiver,
} from '../../../../test/support/fake-receiver';
import { FakeResolver } from '../../../../test/support/fake-resolver';
import { AppModule } from '../../../app.module';
import { CLOCK } from '../../../common/clock/clock.port';
import { FakeClock } from '../../../common/clock/fake-clock';
import { APP_DATABASE, APP_POOL } from '../../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { AuditService } from '../../audit/audit.service';
import { RetryableFailure } from '../../outbox/consumer';
import type { Envelope } from '../../outbox/envelope';
import { OutboxWriter } from '../../outbox/outbox-writer';
import { OrgService } from '../../tenancy/services/org.service';
import { INTEGRATION_OUT_QUEUE } from '../webhooks.constants';
import {
  type AttemptPlan,
  DEFER_RETRIES,
  DEFERRED,
  WebhookAttemptConsumer,
} from './attempt.consumer';
import { DESTINATION_POLICY, type DestinationPolicy } from './destination';
import { EndpointRepository } from './endpoint.repository';
import { EndpointService } from './endpoint.service';
import { WEBHOOK_RESOLVER } from './resolver.port';
import { SafeTransport, type TransportResult, type WebhookRequest } from './safe-transport';
import { SendRepository } from './send.repository';
import { signPayload } from './signature';
import { SigningSecrets } from './signing-secret';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

/** The suite lock may wait out a relaying suite before the module boots. */
const LOCKED_BOOT_TIMEOUT_MS = 600_000;

const NOW = new Date('2026-09-23T12:00:00.000Z');
const HOST = 'receiver.webhooks.test';

/** Loopback admitted, as research R8's E2E substitution: never the production policy. */
const loopbackOnly: DestinationPolicy = { isAllowedAddress: (ip) => ip === '127.0.0.1' };

/**
 * Spec 029 T036 — `WebhookAttemptConsumer`, the single-attempt path of US1, against Postgres and a
 * loopback receiver reached through `FakeResolver`: the claim lease, success, failure, the exact
 * request, and no transaction held while the transport runs.
 */
describe('WebhookAttemptConsumer', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and a loopback receiver', () => {
    let moduleRef: TestingModule;
    let suiteLock: { release: () => Promise<void> } | undefined;
    let database: ForgeDatabase;
    let pool: Pool;
    let transactions: TenantTransactionRunner;
    let endpoints: EndpointService;
    let receiver: FakeReceiver;
    const clock = new FakeClock(NOW);
    const resolver = new FakeResolver();
    const created: { orgs: string[]; users: string[] } = { orgs: [], users: [] };

    function inTenant<T>(orgId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantTransaction(orgId, fn);
    }

    function consumerWith(transport: Pick<SafeTransport, 'send'>): WebhookAttemptConsumer {
      return new WebhookAttemptConsumer(
        moduleRef.get(SendRepository),
        moduleRef.get(EndpointRepository),
        moduleRef.get(SigningSecrets),
        transport as SafeTransport,
        transactions,
        clock,
        moduleRef.get(OutboxWriter),
        moduleRef.get(AuditService),
      );
    }

    /** An org with one endpoint at `path` on the receiver, and one pending send to it. */
    async function pendingSend(path: string, host = HOST) {
      const [user] = await database
        .insert(schema.users)
        .values({ email: `029a-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });
      created.users.push(user!.id);
      const orgId = (
        await moduleRef.get(OrgService).create(user!.id, {
          name: 'Webhook attempt fixture',
          slug: `029a-${randomUUID().slice(0, 8)}`,
        })
      ).id;
      created.orgs.push(orgId);
      const { endpoint, secret } = await inTenant(orgId, (tx) =>
        endpoints.create(tx, orgId, user!.id, {
          description: '',
          eventTypes: ['deploy.succeeded'],
          projectIds: [],
          url: receiver.url(path, { host }),
        }),
      );
      const summary = await inTenant(orgId, (tx) =>
        endpoints.test(tx, orgId, user!.id, endpoint.id),
      );
      const event: Envelope<'webhook.attempt-due'> = {
        aggregate: 'webhook-send',
        aggregateId: summary.id,
        eventId: randomUUID(),
        occurredAt: NOW.toISOString(),
        orgId,
        payload: { orgId, sendId: summary.id },
        traceId: null,
        type: 'webhook.attempt-due',
      };
      return { endpointId: endpoint.id, event, orgId, secret, sendId: summary.id };
    }

    /** As the consumer base runs it: `handle` in a transaction, then `effect` with none held. */
    async function run(
      consumer: WebhookAttemptConsumer,
      event: Envelope<'webhook.attempt-due'>,
    ): Promise<void> {
      const plan = await database.transaction((tx) => consumer.handle(event, tx));
      await consumer.effect(event, plan);
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

    function attemptRows(orgId: string, sendId: string) {
      return inTenant(orgId, (tx) =>
        tx
          .select()
          .from(schema.webhookSendAttempts)
          .where(eq(schema.webhookSendAttempts.sendId, sendId)),
      );
    }

    function endpointRow(orgId: string, endpointId: string) {
      return inTenant(orgId, async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.webhookEndpoints)
          .where(eq(schema.webhookEndpoints.id, endpointId));
        return row!;
      });
    }

    beforeAll(async () => {
      // This suite's sends are pending and their `webhook.attempt-due` rows unpublished: a suite
      // that relays (the webhooks e2e) would otherwise claim and settle them in its own consumer,
      // racing the assertions here and the org delete below, whose cascade then waits on an
      // endpoint that settle holds while settle waits on the org row (both foreign keys).
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
      receiver = await startFakeReceiver();
      resolver.set(HOST, [['127.0.0.1']]);
      moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(CLOCK)
        .useValue(clock)
        .overrideProvider(WEBHOOK_RESOLVER)
        .useValue(resolver)
        .overrideProvider(DESTINATION_POLICY)
        .useValue(loopbackOnly)
        .compile();
      await moduleRef.init();
      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      pool = moduleRef.get<Pool>(APP_POOL);
      transactions = moduleRef.get(TenantTransactionRunner);
      endpoints = moduleRef.get(EndpointService);
    }, LOCKED_BOOT_TIMEOUT_MS);

    afterEach(() => {
      receiver.reset();
      clock.set(NOW);
    });

    afterAll(async () => {
      if (created.orgs.length > 0) {
        await database.delete(schema.orgs).where(inArray(schema.orgs.id, created.orgs));
      }
      if (created.users.length > 0) {
        await database.delete(schema.users).where(inArray(schema.users.id, created.users));
      }
      await moduleRef?.close();
      await receiver?.close();
      await suiteLock?.release();
    });

    it('drains integration.out, concurrency 32, retrying only a fairness deferral', () => {
      expect(moduleRef.get(WebhookAttemptConsumer)).toMatchObject({
        attempts: DEFER_RETRIES + 1,
        concurrency: 32,
        profile: 'events',
        queue: INTEGRATION_OUT_QUEUE,
        types: ['webhook.attempt-due'],
      });
    });

    it('a claim sets claimed_until, and a second concurrent claim of the same send is a no-op', async () => {
      const send = await pendingSend('/claim');
      const consumer = moduleRef.get(WebhookAttemptConsumer);

      const plans = await Promise.all([
        database.transaction((tx) => consumer.handle(send.event, tx)),
        database.transaction((tx) => consumer.handle(send.event, tx)),
      ]);

      expect(
        plans.filter((plan: AttemptPlan | typeof DEFERRED | null) => plan !== null),
      ).toHaveLength(1);
      const row = await sendRow(send.orgId, send.sendId);
      expect(row.claimedUntil).toEqual(new Date(NOW.getTime() + 30_000));
      expect(row.state).toBe('pending');
    });

    it('on a 2xx the send succeeds with attempts = 1, one attempt row, and last_success_at set', async () => {
      const send = await pendingSend('/ok');
      receiver.script('/ok', respond(204, { headers: { 'x-receiver': 'yes' } }));

      await run(moduleRef.get(WebhookAttemptConsumer), send.event);

      expect(await sendRow(send.orgId, send.sendId)).toMatchObject({
        attempts: 1,
        claimedUntil: null,
        firstAttemptAt: NOW,
        lastFailure: null,
        nextAttemptAt: null,
        state: 'succeeded',
      });
      const attempts = await attemptRows(send.orgId, send.sendId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        address: '127.0.0.1',
        attemptedAt: NOW,
        failure: null,
        manual: false,
        status: 204,
      });
      expect(attempts[0]!.responseHeaders).toMatchObject({ 'x-receiver': 'yes' });
      expect((await endpointRow(send.orgId, send.endpointId)).lastSuccessAt).toEqual(NOW);
    });

    it('a 500 is retryable: the send stays pending on the schedule (US3)', async () => {
      const send = await pendingSend('/fail-500');
      receiver.script('/fail-500', respond(500, { body: 'down' }));

      await run(moduleRef.get(WebhookAttemptConsumer), send.event);

      expect(await sendRow(send.orgId, send.sendId)).toMatchObject({
        attempts: 1,
        claimedUntil: null,
        lastFailure: 'http-error',
        state: 'pending',
      });
      const attempts = await attemptRows(send.orgId, send.sendId);
      expect(attempts.map((row) => [row.failure, row.status])).toEqual([['http-error', 500]]);
      expect((await endpointRow(send.orgId, send.endpointId)).lastSuccessAt).toBeNull();
    });

    it.each([
      ['a 404', respond(404), 'http-error', 404],
      [
        'a 302',
        respond(302, { headers: { location: 'http://elsewhere.test/' } }),
        'redirect-not-followed',
        302,
      ],
    ])('%s ends the send failed', async (_label, step, failure, status) => {
      const send = await pendingSend(`/fail-${status}`);
      receiver.script(`/fail-${status}`, step);

      await run(moduleRef.get(WebhookAttemptConsumer), send.event);

      expect(await sendRow(send.orgId, send.sendId)).toMatchObject({
        attempts: 1,
        claimedUntil: null,
        lastFailure: failure,
        nextAttemptAt: null,
        state: 'failed',
      });
      const attempts = await attemptRows(send.orgId, send.sendId);
      expect(attempts.map((row) => [row.failure, row.status])).toEqual([[failure, status]]);
      expect((await endpointRow(send.orgId, send.endpointId)).lastSuccessAt).toBeNull();
    });

    it('a failure before any response (a timeout) is retryable, with no status', async () => {
      const send = await pendingSend('/hang');
      receiver.script('/hang', hang());
      const quick = new SafeTransport(resolver, loopbackOnly, clock, { timeoutMs: 200 });

      await run(consumerWith(quick), send.event);

      expect(await sendRow(send.orgId, send.sendId)).toMatchObject({
        lastFailure: 'timeout',
        state: 'pending',
      });
      const attempts = await attemptRows(send.orgId, send.sendId);
      expect(attempts.map((row) => [row.failure, row.status, row.address])).toEqual([
        ['timeout', null, '127.0.0.1'],
      ]);
    });

    it('sends exactly the contract headers and a Forge-Signature that verifies with the secret', async () => {
      const send = await pendingSend('/signed');

      await run(moduleRef.get(WebhookAttemptConsumer), send.event);

      const [received] = receiver.requests('/signed');
      expect(Object.keys(received!.headers).sort()).toEqual([
        'connection',
        'content-length',
        'content-type',
        'forge-delivery-id',
        'forge-event-id',
        'forge-event-type',
        'forge-signature',
        'host',
        'user-agent',
      ]);
      const stored = await sendRow(send.orgId, send.sendId);
      expect(received!.headers).toMatchObject({
        'content-type': 'application/json',
        'forge-delivery-id': send.sendId,
        'forge-event-id': stored.eventId,
        'forge-event-type': 'ping',
        'user-agent': 'Forge-Webhooks/1',
      });
      const body = received!.body.toString('utf8');
      expect(body).toBe(stored.body);
      const header = received!.headers['forge-signature'] as string;
      const t = Number(/^t=(\d+),/.exec(header)?.[1]);
      expect(t).toBe(Math.floor(NOW.getTime() / 1000));
      expect(header).toBe(signPayload([send.secret], t, body));
    });

    it('holds no database transaction while the transport runs', async () => {
      const send = await pendingSend('/no-tx');
      const real = moduleRef.get(SafeTransport);
      const active: number[] = [];
      const watching = {
        send: (request: WebhookRequest): Promise<TransportResult> => {
          active.push(pool.totalCount - pool.idleCount);
          return real.send(request);
        },
      };

      await run(consumerWith(watching), send.event);

      expect(active).toEqual([0]);
      expect((await sendRow(send.orgId, send.sendId)).state).toBe('succeeded');
    });

    it.each([
      [
        'an unavailable resolver',
        (host: string): unknown => resolver.unavailable(host),
        'dns-failed',
        'pending',
      ],
      ['an empty answer', (_host: string): unknown => undefined, 'dns-failed', 'pending'],
      [
        'an answer with every address refused',
        (host: string): unknown => resolver.set(host, [['10.0.0.1', '169.254.169.254', '::1']]),
        'destination-refused',
        'failed',
      ],
    ] as const)(
      '%s fails the attempt with no address and no request',
      async (label, script, failure, state) => {
        const host = `outcome-${label.replaceAll(' ', '-')}.webhooks.test`;
        script(host);
        const send = await pendingSend('/outcome', host);

        await run(moduleRef.get(WebhookAttemptConsumer), send.event);

        expect(receiver.requests('/outcome')).toEqual([]);
        const attempts = await attemptRows(send.orgId, send.sendId);
        expect(attempts.map((row) => [row.failure, row.status, row.address])).toEqual([
          [failure, null, null],
        ]);
        expect(await sendRow(send.orgId, send.sendId)).toMatchObject({
          attempts: 1,
          lastFailure: failure,
          state,
        });
      },
    );

    it('pins the first allowed address of a mixed answer', async () => {
      const host = 'mixed.webhooks.test';
      resolver.set(host, [['10.0.0.1', '127.0.0.1', '127.0.0.2']]);
      const send = await pendingSend('/mixed', host);

      await run(moduleRef.get(WebhookAttemptConsumer), send.event);

      expect(receiver.requests('/mixed')).toHaveLength(1);
      const attempts = await attemptRows(send.orgId, send.sendId);
      expect(attempts.map((row) => [row.failure, row.address])).toEqual([[null, '127.0.0.1']]);
    });

    it('a claimed send whose endpoint was disabled is not sent', async () => {
      const send = await pendingSend('/disabled');
      await inTenant(send.orgId, (tx) =>
        tx
          .update(schema.webhookEndpoints)
          .set({ state: 'disabled' })
          .where(eq(schema.webhookEndpoints.id, send.endpointId)),
      );

      await run(moduleRef.get(WebhookAttemptConsumer), send.event);

      expect(receiver.requests('/disabled')).toEqual([]);
      expect(await sendRow(send.orgId, send.sendId)).toMatchObject({
        claimedUntil: null,
        nextAttemptAt: null,
        state: 'not_sent',
      });
    });

    describe('US3: the schedule, the circuit and the pause (T056)', () => {
      const HOUR = 3_600_000;

      function setEndpoint(
        orgId: string,
        endpointId: string,
        fields: Partial<typeof schema.webhookEndpoints.$inferInsert>,
      ) {
        return inTenant(orgId, (tx) =>
          tx
            .update(schema.webhookEndpoints)
            .set(fields)
            .where(eq(schema.webhookEndpoints.id, endpointId)),
        );
      }

      function setSend(
        orgId: string,
        sendId: string,
        fields: Partial<typeof schema.webhookSends.$inferInsert>,
      ) {
        return inTenant(orgId, (tx) =>
          tx.update(schema.webhookSends).set(fields).where(eq(schema.webhookSends.id, sendId)),
        );
      }

      function outboxRows(endpointId: string, type: string) {
        return database
          .select()
          .from(schema.outbox)
          .where(and(eq(schema.outbox.aggregateId, endpointId), eq(schema.outbox.type, type)));
      }

      function auditRows(orgId: string, action: string) {
        return inTenant(orgId, (tx) =>
          tx
            .select()
            .from(schema.auditLog)
            .where(and(eq(schema.auditLog.orgId, orgId), eq(schema.auditLog.action, action))),
        );
      }

      /** Another pending send on the same endpoint, through the service's own test path. */
      async function anotherSend(orgId: string, endpointId: string): Promise<string> {
        const [owner] = await inTenant(orgId, (tx) =>
          tx.select().from(schema.memberships).where(eq(schema.memberships.orgId, orgId)),
        );
        const summary = await inTenant(orgId, (tx) =>
          endpoints.test(tx, orgId, owner!.userId, endpointId),
        );
        return summary.id;
      }

      it('a retryable failure keeps the send pending, with next_attempt_at from the schedule and attempts incremented', async () => {
        const send = await pendingSend('/retry');
        receiver.script('/retry', respond(503));

        await run(moduleRef.get(WebhookAttemptConsumer), send.event);

        const row = await sendRow(send.orgId, send.sendId);
        expect(row).toMatchObject({
          attempts: 1,
          claimedUntil: null,
          firstAttemptAt: NOW,
          lastFailure: 'http-error',
          state: 'pending',
        });
        const gap = row.nextAttemptAt!.getTime() - NOW.getTime();
        expect(gap).toBeGreaterThanOrEqual(0.8 * 60_000);
        expect(gap).toBeLessThanOrEqual(1.2 * 60_000);
      });

      it('after 8 attempts the send is failed', async () => {
        const send = await pendingSend('/eight');
        receiver.script('/eight', respond(500));
        const consumer = moduleRef.get(WebhookAttemptConsumer);

        for (let attempt = 1; attempt <= 8; attempt += 1) {
          const before = await sendRow(send.orgId, send.sendId);
          expect(before.state).toBe('pending');
          clock.set(before.nextAttemptAt!);
          // The circuit opens at the fifth failure; the schedule's gaps outlast it.
          await setEndpoint(send.orgId, send.endpointId, { circuitOpenUntil: null });
          await run(consumer, send.event);
        }

        expect(await sendRow(send.orgId, send.sendId)).toMatchObject({
          attempts: 8,
          nextAttemptAt: null,
          state: 'failed',
        });
        expect(receiver.requests('/eight')).toHaveLength(8);
      });

      it('a terminal failure is failed after 1', async () => {
        const send = await pendingSend('/terminal');
        receiver.script('/terminal', respond(400));

        await run(moduleRef.get(WebhookAttemptConsumer), send.event);

        expect(await sendRow(send.orgId, send.sendId)).toMatchObject({
          attempts: 1,
          nextAttemptAt: null,
          state: 'failed',
        });
      });

      it('the fifth consecutive failure sets circuit_open_until', async () => {
        const send = await pendingSend('/circuit');
        receiver.script('/circuit', respond(503));
        const consumer = moduleRef.get(WebhookAttemptConsumer);

        for (let attempt = 1; attempt <= 5; attempt += 1) {
          clock.set((await sendRow(send.orgId, send.sendId)).nextAttemptAt!);
          await run(consumer, send.event);
          const endpoint = await endpointRow(send.orgId, send.endpointId);
          expect(endpoint.failureCount).toBe(attempt);
          expect(endpoint.circuitOpenUntil === null).toBe(attempt < 5);
        }
        expect((await endpointRow(send.orgId, send.endpointId)).circuitOpenUntil).toEqual(
          new Date(clock.now().getTime() + 10 * 60_000),
        );
      });

      it('while the circuit is open, a claim moves next_attempt_at to its close and consumes no attempt', async () => {
        const send = await pendingSend('/open');
        const closes = new Date(NOW.getTime() + 7 * 60_000);
        await setEndpoint(send.orgId, send.endpointId, {
          circuitOpenUntil: closes,
          failureCount: 5,
        });

        await run(moduleRef.get(WebhookAttemptConsumer), send.event);

        expect(receiver.requests('/open')).toEqual([]);
        expect(await attemptRows(send.orgId, send.sendId)).toEqual([]);
        expect(await sendRow(send.orgId, send.sendId)).toMatchObject({
          attempts: 0,
          claimedUntil: null,
          nextAttemptAt: closes,
          state: 'pending',
        });
      });

      it('a success clears failure_count, circuit_open_until and failing_since', async () => {
        const send = await pendingSend('/recovered');
        await setEndpoint(send.orgId, send.endpointId, {
          circuitOpenUntil: new Date(NOW.getTime() - 1),
          failingSince: new Date(NOW.getTime() - HOUR),
          failureCount: 6,
        });

        await run(moduleRef.get(WebhookAttemptConsumer), send.event);

        expect(await endpointRow(send.orgId, send.endpointId)).toMatchObject({
          circuitOpenUntil: null,
          failingSince: null,
          failureCount: 0,
          lastSuccessAt: NOW,
        });
      });

      it('failing_since is set on the first failure after a success, and kept on the next', async () => {
        const send = await pendingSend('/since');
        receiver.script('/since', respond(503));
        const consumer = moduleRef.get(WebhookAttemptConsumer);

        await run(consumer, send.event);
        expect((await endpointRow(send.orgId, send.endpointId)).failingSince).toEqual(NOW);

        clock.set((await sendRow(send.orgId, send.sendId)).nextAttemptAt!);
        await run(consumer, send.event);
        expect((await endpointRow(send.orgId, send.endpointId)).failingSince).toEqual(NOW);
      });

      it('an exhausted send with failing_since ≤ now − 24 h pauses the endpoint, moves its other pending sends to not_sent, appends one webhook.endpoint-paused and audits with a null actor', async () => {
        const send = await pendingSend('/pause');
        receiver.script('/pause', respond(503));
        const other = await anotherSend(send.orgId, send.endpointId);
        await setEndpoint(send.orgId, send.endpointId, {
          failingSince: new Date(NOW.getTime() - 25 * HOUR),
          failureCount: 1,
        });
        await setSend(send.orgId, send.sendId, {
          attempts: 7,
          firstAttemptAt: new Date(NOW.getTime() - 23 * HOUR),
        });

        await run(moduleRef.get(WebhookAttemptConsumer), send.event);

        expect(await sendRow(send.orgId, send.sendId)).toMatchObject({
          attempts: 8,
          state: 'failed',
        });
        expect(await endpointRow(send.orgId, send.endpointId)).toMatchObject({
          pausedAt: NOW,
          state: 'paused',
        });
        expect(await sendRow(send.orgId, other)).toMatchObject({
          nextAttemptAt: null,
          state: 'not_sent',
        });
        const paused = await outboxRows(send.endpointId, 'webhook.endpoint-paused');
        expect(paused.map((row) => row.payload)).toEqual([
          { endpointId: send.endpointId, orgId: send.orgId },
        ]);
        const audit = await auditRows(send.orgId, 'webhook.endpoint-paused');
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({ actorId: null });
      });

      it('an exhausted send with a more recent failing_since does not pause', async () => {
        const send = await pendingSend('/no-pause');
        receiver.script('/no-pause', respond(503));
        await setEndpoint(send.orgId, send.endpointId, {
          failingSince: new Date(NOW.getTime() - 23 * HOUR),
          failureCount: 1,
        });
        await setSend(send.orgId, send.sendId, {
          attempts: 7,
          firstAttemptAt: new Date(NOW.getTime() - 23 * HOUR),
        });

        await run(moduleRef.get(WebhookAttemptConsumer), send.event);

        expect((await sendRow(send.orgId, send.sendId)).state).toBe('failed');
        expect(await endpointRow(send.orgId, send.endpointId)).toMatchObject({
          pausedAt: null,
          state: 'enabled',
        });
        expect(await outboxRows(send.endpointId, 'webhook.endpoint-paused')).toEqual([]);
      });

      it('a settled attempt dispatches the org’s oldest due send that has no attempt-due yet', async () => {
        const send = await pendingSend('/chain');
        const waiting = await anotherSend(send.orgId, send.endpointId);
        await setSend(send.orgId, waiting, { nextAttemptAt: new Date(NOW.getTime() - 1_000) });

        await run(moduleRef.get(WebhookAttemptConsumer), send.event);

        const due = await database
          .select({ payload: schema.outbox.payload })
          .from(schema.outbox)
          .where(
            and(
              eq(schema.outbox.type, 'webhook.attempt-due'),
              eq(schema.outbox.aggregateId, waiting),
            ),
          );
        // One from the service's own test path, one from the chain.
        expect(due).toHaveLength(2);
        expect((await sendRow(send.orgId, waiting)).nextAttemptAt).toEqual(
          new Date(NOW.getTime() + 30_000),
        );
      });

      it('a ninth concurrent claim for one org is deferred by 5 s without consuming an attempt', async () => {
        const send = await pendingSend('/fair');
        for (let index = 0; index < 8; index += 1) {
          const busy = await anotherSend(send.orgId, send.endpointId);
          await setSend(send.orgId, busy, { claimedUntil: new Date(NOW.getTime() + 20_000) });
        }

        const consumer = moduleRef.get(WebhookAttemptConsumer);
        const plan = await database.transaction((tx) => consumer.handle(send.event, tx));
        expect(plan).toBe(DEFERRED);
        // Back through the lane's backoff while retries remain; then the sweep owns it.
        await expect(consumer.effect(send.event, plan, 1)).rejects.toBeInstanceOf(RetryableFailure);
        await expect(consumer.effect(send.event, plan, DEFER_RETRIES + 1)).resolves.toBeUndefined();

        expect(receiver.requests('/fair')).toEqual([]);
        expect(await sendRow(send.orgId, send.sendId)).toMatchObject({
          attempts: 0,
          claimedUntil: null,
          nextAttemptAt: new Date(NOW.getTime() + 5_000),
          state: 'pending',
        });
      });
    });
  });
});
