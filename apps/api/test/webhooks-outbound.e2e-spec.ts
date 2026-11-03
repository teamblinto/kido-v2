import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  type WebhookEndpoint,
  webhookDeliveryListSchema,
  webhookDeliverySchema,
  webhookDeliverySummarySchema,
  webhookEndpointListSchema,
  webhookEndpointSchema,
  webhookEnvelopeSchema,
  webhookSecretResponseSchema,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { CLOCK } from '../src/common/clock/clock.port';
import { FakeClock } from '../src/common/clock/fake-clock';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../src/database/database.types';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import { RunStore } from '../src/modules/agent/run-store';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../src/modules/identity/password/breached-password.port';
import { InMemoryMailer } from '../src/modules/mail/in-memory.mailer';
import { MAILER } from '../src/modules/mail/mailer.port';
import { OutboxWriter } from '../src/modules/outbox/outbox-writer';
import { MembershipService } from '../src/modules/tenancy/services/membership.service';
import {
  DESTINATION_POLICY,
  type DestinationPolicy,
} from '../src/modules/webhooks/outbound/destination';
import { WEBHOOK_RESOLVER } from '../src/modules/webhooks/outbound/resolver.port';
import { signPayload } from '../src/modules/webhooks/outbound/signature';
import { WebhooksMaintenanceConsumer } from '../src/modules/webhooks/webhooks-maintenance.consumer';
import { unsafe } from './support/csrf-client';
import {
  type FakeReceiver,
  type ReceivedRequest,
  respond,
  retryAfter,
  startFakeReceiver,
} from './support/fake-receiver';
import { FakeResolver } from './support/fake-resolver';
import { awaitMail } from './support/mail';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  http,
  type Principal,
  signUpAndIn,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  // `events` relays the outbox and drains `webhook.fanout`, `integration.out` and `mail` in
  // process, under the outbox suite lock. No `agent`: runs are finished through `RunStore`.
  process.env.RUN_PROFILES = 'api,events';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.THROTTLE_LIMIT = '100000';
  process.env.LOGIN_THROTTLE_ACCOUNT_BURST = '100';
  process.env.LOGIN_THROTTLE_IP_BURST = '4000';
  process.env.SITE_DOMAIN = 'forge-site.localhost';
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const ORGS = '/api/v1/orgs';
const HOST = 'receiver.webhooks-e2e.test';
const SITE_DOMAIN = 'forge-site.localhost';
const LOCKED_BOOT_TIMEOUT_MS = 600_000;
/** SC-001: the first attempt within 10 s of the event. */
const SC001_BOUND_MS = 10_000;
const DELIVERY_WAIT_MS = 15_000;

/** Loopback only: research R8's E2E substitution for the real policy, never the production one. */
const loopbackOnly: DestinationPolicy = { isAllowedAddress: (ip) => ip === '127.0.0.1' };

class ScriptedBreachPort implements BreachedPasswordPort {
  isBreached(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

async function until(predicate: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

/** The problem document without what differs per request: `instance` and `requestId`. */
function problemOf(body: unknown): unknown {
  return Object.fromEntries(
    Object.entries(body as Record<string, unknown>).filter(
      ([key]) => key !== 'instance' && key !== 'requestId',
    ),
  );
}

/**
 * Spec 029 US1, US3, US4 and US5 over the real API, Postgres, the queue Redis role and the in-process relay,
 * fan-out, attempt and mail workers. The receiver is `startFakeReceiver` on loopback, reached by
 * name through `FakeResolver`; the destination policy admits `127.0.0.1` only.
 */
describe('Webhooks, outbound (e2e)', () => {
  describe.skipIf(!postgres || !redis)(
    'against Postgres, the queue, a fake resolver and a loopback receiver',
    () => {
      let app: INestApplication;
      let world: TwoTenantWorld;
      let database: ForgeDatabase;
      let transactions: TenantTransactionRunner;
      let receiver: FakeReceiver;
      let suiteLock: { release: () => Promise<void> } | undefined;
      const START = new Date();
      const clock = new FakeClock(START);
      const resolver = new FakeResolver();
      const mailer = new InMemoryMailer();
      const extraEmails: string[] = [];

      const endpointsPath = (orgId: string) => `${ORGS}/${orgId}/webhooks/endpoints`;

      function inTenant<T>(orgId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
        return transactions.runInTenantTransaction(orgId, fn);
      }

      function createEndpoint(
        orgId: string,
        caller: Principal,
        body: { eventTypes: string[]; path: string; projectIds?: string[] },
      ) {
        return unsafe(http(app).post(endpointsPath(orgId)), [caller.cookie]).send({
          eventTypes: body.eventTypes,
          ...(body.projectIds === undefined ? {} : { projectIds: body.projectIds }),
          url: receiver.url(body.path, { host: HOST }),
        });
      }

      async function endpointAt(
        path: string,
        eventTypes: string[],
        projectIds?: string[],
      ): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
        const response = await createEndpoint(world.alpha.orgId, world.alpha.owner, {
          eventTypes,
          path,
          projectIds,
        }).expect(201);
        return webhookSecretResponseSchema.parse(response.body);
      }

      /** Appends an internal event on a tenant transaction, as its producer would. */
      async function produceDeploySucceeded(projectId = world.alpha.projectId): Promise<string> {
        const deploymentId = randomUUID();
        const { eventId } = await inTenant(world.alpha.orgId, (tx) =>
          app.get(OutboxWriter).append(tx, {
            aggregateId: deploymentId,
            orgId: world.alpha.orgId,
            payload: {
              deploymentId,
              orgId: world.alpha.orgId,
              projectId,
              siteLabel: 'b'.repeat(32),
            },
            type: 'deploy.succeeded',
          }),
        );
        return eventId;
      }

      async function arrived(path: string, count = 1): Promise<readonly ReceivedRequest[]> {
        const ok = await until(() => receiver.requests(path).length >= count, DELIVERY_WAIT_MS);
        expect(ok, `${count} request(s) at ${path}`).toBe(true);
        return receiver.requests(path);
      }

      function verify(request: ReceivedRequest, secret: string): void {
        const header = request.headers['forge-signature'] as string;
        const t = Number(/^t=(\d+),/.exec(header)?.[1]);
        expect(header).toBe(signPayload([secret], t, request.body.toString('utf8')));
      }

      beforeAll(async () => {
        suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
        receiver = await startFakeReceiver();
        resolver.set(HOST, [['127.0.0.1']]);

        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(BREACHED_PASSWORD_PORT)
          .useClass(ScriptedBreachPort)
          .overrideProvider(MAILER)
          .useValue(mailer)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(WEBHOOK_RESOLVER)
          .useValue(resolver)
          .overrideProvider(DESTINATION_POLICY)
          .useValue(loopbackOnly)
          .compile();

        app = moduleRef.createNestApplication();
        configureApplication(app);
        await app.init();

        database = app.get<ForgeDatabase>(APP_DATABASE);
        transactions = app.get(TenantTransactionRunner);
        world = await createTwoTenantWorld(app);
      }, LOCKED_BOOT_TIMEOUT_MS);

      afterEach(async () => {
        receiver.reset();
        // US3 moves the clock by days; sessions and leases are read against it.
        clock.set(START);
        for (const orgId of [world.alpha.orgId, world.beta.orgId]) {
          await inTenant(orgId, async (tx) => {
            const rows = await tx.delete(schema.webhookEndpoints).returning({
              previousSecretId: schema.webhookEndpoints.previousSecretId,
              secretId: schema.webhookEndpoints.secretId,
            });
            const secretIds = rows.flatMap((row) =>
              row.previousSecretId === null ? [row.secretId] : [row.secretId, row.previousSecretId],
            );
            if (secretIds.length > 0) {
              await tx.delete(schema.secrets).where(inArray(schema.secrets.id, secretIds));
            }
          });
        }
      });

      afterAll(async () => {
        if (app !== undefined) {
          await destroyTwoTenantWorld(app, world);
          if (extraEmails.length > 0) {
            await database.delete(schema.users).where(inArray(schema.users.email, extraEmails));
          }
        }
        await app?.close();
        await receiver?.close();
        await suiteLock?.release();
      });

      it('shows the signing secret exactly once', async () => {
        const { endpoint, secret } = await endpointAt('/once', ['deploy.succeeded']);

        expect(secret).toMatch(/^whsec_/);
        const read = await http(app)
          .get(`${endpointsPath(world.alpha.orgId)}/${endpoint.id}`)
          .set('Cookie', world.alpha.owner.cookie)
          .expect(200);
        const list = await http(app)
          .get(endpointsPath(world.alpha.orgId))
          .set('Cookie', world.alpha.owner.cookie)
          .expect(200);

        expect(webhookEndpointSchema.parse(read.body)).toEqual(endpoint);
        expect(webhookEndpointListSchema.parse(list.body)).toEqual({ items: [endpoint] });
        for (const text of [read.text, list.text]) {
          expect(text).not.toContain(secret);
          expect(text).not.toContain('whsec_');
        }
      });

      it('sends one signed request for a subscribed deploy.succeeded', async () => {
        const { endpoint, secret } = await endpointAt('/deploys', ['deploy.succeeded']);

        const eventId = await produceDeploySucceeded();

        const [request] = await arrived('/deploys');
        verify(request!, secret);
        const envelope = webhookEnvelopeSchema.parse(JSON.parse(request!.body.toString('utf8')));
        expect(envelope).toMatchObject({
          id: eventId,
          orgId: world.alpha.orgId,
          projectId: world.alpha.projectId,
          type: 'deploy.succeeded',
        });
        expect(envelope.data).toMatchObject({
          siteUrl: `https://${'b'.repeat(32)}.${SITE_DOMAIN}`,
        });
        expect(request!.headers).toMatchObject({
          'forge-event-id': eventId,
          'forge-event-type': 'deploy.succeeded',
        });

        await until(async () => {
          const [send] = await inTenant(world.alpha.orgId, (tx) =>
            tx
              .select({ state: schema.webhookSends.state })
              .from(schema.webhookSends)
              .where(eq(schema.webhookSends.endpointId, endpoint.id)),
          );
          return send?.state === 'succeeded';
        }, DELIVERY_WAIT_MS);
        // Settled once: nothing more arrives for the same event.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(receiver.requests('/deploys')).toHaveLength(1);
      });

      it('sends nothing for an unsubscribed type or an out-of-scope project', async () => {
        await endpointAt('/failed-only', ['deploy.failed']);
        const scopeless = randomUUID();
        await endpointAt('/scoped', ['deploy.succeeded'], [world.alpha.projectId]);
        await endpointAt('/everything', ['deploy.succeeded']);

        // In scope of `/everything` only: a project id no endpoint is scoped to.
        await produceDeploySucceeded(scopeless);

        await arrived('/everything');
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(receiver.requests('/failed-only')).toEqual([]);
        expect(receiver.requests('/scoped')).toEqual([]);
      });

      it('records a ping sent by send test', async () => {
        const { endpoint, secret } = await endpointAt('/ping', ['deploy.succeeded']);

        const response = await unsafe(
          http(app).post(`${endpointsPath(world.alpha.orgId)}/${endpoint.id}/test`),
          [world.alpha.owner.cookie],
        ).expect(202);
        const summary = webhookDeliverySummarySchema.parse(response.body);
        expect(summary).toMatchObject({ eventType: 'ping', state: 'pending' });

        const [request] = await arrived('/ping');
        verify(request!, secret);
        expect(request!.headers['forge-delivery-id']).toBe(summary.id);
        expect(JSON.parse(request!.body.toString('utf8'))).toMatchObject({
          data: {},
          id: summary.eventId,
          type: 'ping',
        });

        expect(
          await until(async () => {
            const attempts = await inTenant(world.alpha.orgId, (tx) =>
              tx
                .select()
                .from(schema.webhookSendAttempts)
                .where(eq(schema.webhookSendAttempts.sendId, summary.id)),
            );
            return attempts.length === 1 && attempts[0]!.status === 200;
          }, DELIVERY_WAIT_MS),
        ).toBe(true);
      });

      it('refuses a member without org:webhooks.manage the same way whether or not endpoints exist', async () => {
        const member = await signUpAndIn(app, 'webhooks-member');
        extraEmails.push(member.email);
        await transactions.runInTenantScope(
          { orgId: world.alpha.orgId, userId: world.alpha.owner.userId },
          () =>
            app
              .get(MembershipService)
              .add({ orgId: world.alpha.orgId, role: 'member', userId: member.userId }),
        );

        const probe = async (id: string) => ({
          create: await createEndpoint(world.alpha.orgId, member, {
            eventTypes: ['deploy.succeeded'],
            path: '/member',
          }),
          list: await http(app).get(endpointsPath(world.alpha.orgId)).set('Cookie', member.cookie),
          read: await http(app)
            .get(`${endpointsPath(world.alpha.orgId)}/${id}`)
            .set('Cookie', member.cookie),
          test: await unsafe(http(app).post(`${endpointsPath(world.alpha.orgId)}/${id}/test`), [
            member.cookie,
          ]),
        });

        const without = await probe(randomUUID());
        const { endpoint } = await endpointAt('/exists', ['deploy.succeeded']);
        const withOne = await probe(endpoint.id);

        for (const probed of [without, withOne]) {
          for (const response of Object.values(probed)) expect(response.status).toBe(403);
        }
        for (const key of ['create', 'list', 'read', 'test'] as const) {
          expect(problemOf(withOne[key].body)).toEqual(problemOf(without[key].body));
        }
        expect(JSON.stringify(withOne.list.body)).not.toContain(endpoint.id);
      });

      it('delivers run.completed when a run finishes and member.joined when an invitation is accepted', async () => {
        const { secret } = await endpointAt('/lifecycle', ['member.joined', 'run.completed']);

        // A run, finished through the store's own transition (the agent worker's path).
        const store = app.get(RunStore, { strict: false });
        const orgId = world.alpha.orgId;
        const runId = await inTenant(orgId, async (tx) => {
          const run = await store.insertRun(tx, {
            model: 'fake',
            orgId,
            projectId: world.alpha.projectId,
            userId: world.alpha.owner.userId,
          });
          return run.id;
        });
        await inTenant(orgId, (tx) =>
          store.claim(tx, { leaseTtlMs: 45_000, orgId, owner: 'webhooks-e2e', runId }),
        );
        await inTenant(orgId, (tx) =>
          store.transition(tx, { epoch: 1, from: 'starting', orgId, runId, to: 'running' }),
        );
        await inTenant(orgId, (tx) =>
          store.transition(tx, { epoch: 1, from: 'running', orgId, runId, to: 'succeeded' }),
        );

        // An invitation, accepted over HTTP with the token from its mail.
        const invitee = await signUpAndIn(app, 'webhooks-invitee');
        extraEmails.push(invitee.email);
        await unsafe(http(app).post(`${ORGS}/${orgId}/invitations`), [world.alpha.owner.cookie])
          .send({ email: invitee.email, role: 'member' })
          .expect(202);
        const mail = await awaitMail(
          mailer,
          (message) =>
            message.template === 'invitation' &&
            message.to.toLowerCase() === invitee.email.toLowerCase(),
          { timeoutMs: DELIVERY_WAIT_MS },
        );
        const token = /[?&]token=([^&"'\s]+)/.exec(mail.text)?.[1];
        await unsafe(http(app).post(`${ORGS}/${orgId}/invitations/accept`), [invitee.cookie])
          .send({ token })
          .expect(201);

        const requests = await arrived('/lifecycle', 2);
        const envelopes = requests.map((request) => {
          verify(request, secret);
          return webhookEnvelopeSchema.parse(JSON.parse(request.body.toString('utf8')));
        });
        expect(envelopes.map((envelope) => envelope.type).sort()).toEqual([
          'member.joined',
          'run.completed',
        ]);
        expect(envelopes.find((envelope) => envelope.type === 'run.completed')).toMatchObject({
          data: { outcome: 'succeeded', runId },
          projectId: world.alpha.projectId,
        });
        expect(envelopes.find((envelope) => envelope.type === 'member.joined')).toMatchObject({
          data: { role: 'member', userId: invitee.userId },
          orgId,
          projectId: null,
        });
      });

      it('reaches the receiver within 10 s of the event for 95% of 100 events', async () => {
        await endpointAt('/load', ['deploy.succeeded']);
        const producedAt = new Map<string, number>();
        const arrivedAt = new Map<string, number>();

        for (let index = 0; index < 100; index += 1) {
          const eventId = await produceDeploySucceeded();
          producedAt.set(eventId, Date.now());
        }

        const deadline = Date.now() + 30_000;
        while (arrivedAt.size < producedAt.size && Date.now() < deadline) {
          for (const request of receiver.requests('/load')) {
            const eventId = request.headers['forge-event-id'] as string;
            if (!arrivedAt.has(eventId)) arrivedAt.set(eventId, Date.now());
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        const latencies = [...producedAt].map(([eventId, at]) =>
          arrivedAt.has(eventId) ? arrivedAt.get(eventId)! - at : Number.POSITIVE_INFINITY,
        );
        const within = latencies.filter((latency) => latency <= SC001_BOUND_MS).length;
        expect(within).toBeGreaterThanOrEqual(95);
        // At least once: a redelivered event never becomes a second request.
        expect(
          new Set(receiver.requests('/load').map((r) => r.headers['forge-event-id'])).size,
        ).toBe(receiver.requests('/load').length);
      }, 60_000);

      describe('US4: the delivery log and replay', () => {
        const DAY = 86_400_000;

        const deliveriesPath = (endpointId: string, rest = '') =>
          `${endpointsPath(world.alpha.orgId)}/${endpointId}/deliveries${rest}`;

        function sendsOf(endpointId: string) {
          return inTenant(world.alpha.orgId, (tx) =>
            tx
              .select()
              .from(schema.webhookSends)
              .where(eq(schema.webhookSends.endpointId, endpointId)),
          );
        }

        /** Waits until the endpoint's only send has settled in `state`, and returns its id. */
        async function settled(endpointId: string, state: 'failed' | 'succeeded'): Promise<string> {
          const ok = await until(async () => {
            const rows = await sendsOf(endpointId);
            return rows.length === 1 && rows[0]!.state === state;
          }, DELIVERY_WAIT_MS);
          expect(ok, `the send settles ${state}`).toBe(true);
          return (await sendsOf(endpointId))[0]!.id;
        }

        async function read(endpointId: string, deliveryId: string) {
          const response = await http(app)
            .get(deliveriesPath(endpointId, `/${deliveryId}`))
            .set('Cookie', world.alpha.owner.cookie)
            .expect(200);
          return { delivery: webhookDeliverySchema.parse(response.body), text: response.text };
        }

        function replay(endpointId: string, deliveryId: string) {
          return unsafe(http(app).post(deliveriesPath(endpointId, `/${deliveryId}/replay`)), [
            world.alpha.owner.cookie,
          ]);
        }

        it('shows each attempt with status, headers and at most 4 KB of body', async () => {
          receiver.script(
            '/log',
            respond(500, { body: 'x'.repeat(10_000), headers: { 'x-trace': 'trace-1' } }),
          );
          const { endpoint, secret } = await endpointAt('/log', ['deploy.succeeded']);
          const eventId = await produceDeploySucceeded();
          await arrived('/log');
          const deliveryId = await until(
            async () => (await sendsOf(endpoint.id))[0]?.attempts === 1,
            DELIVERY_WAIT_MS,
          ).then(async () => (await sendsOf(endpoint.id))[0]!.id);

          const list = await http(app)
            .get(deliveriesPath(endpoint.id))
            .set('Cookie', world.alpha.owner.cookie)
            .expect(200);
          const page = webhookDeliveryListSchema.parse(list.body);
          expect(page.items).toMatchObject([
            { eventId, eventType: 'deploy.succeeded', id: deliveryId, lastFailure: 'http-error' },
          ]);

          const { delivery, text } = await read(endpoint.id, deliveryId);
          expect(delivery.body).toContain(eventId);
          expect(delivery.attemptLog).toHaveLength(1);
          const [attempt] = delivery.attemptLog;
          expect(attempt).toMatchObject({
            address: '127.0.0.1',
            failure: 'http-error',
            manual: false,
            status: 500,
          });
          expect(attempt!.responseHeaders).toMatchObject({ 'x-trace': 'trace-1' });
          expect(Buffer.byteLength(attempt!.responseBody!, 'utf8')).toBeLessThanOrEqual(4_096);
          expect(attempt!.responseBody).toMatch(/^x+$/);
          expect(text).not.toContain(secret);
          expect(text).not.toContain('whsec_');
        });

        it('replays a failed delivery with the same event id and a fresh timestamp', async () => {
          receiver.script('/replay', respond(400), respond(204));
          const { endpoint, secret } = await endpointAt('/replay', ['deploy.succeeded']);
          const eventId = await produceDeploySucceeded();
          const deliveryId = await settled(endpoint.id, 'failed');
          const [first] = await arrived('/replay');

          clock.advance(60_000);
          const response = await replay(endpoint.id, deliveryId).expect(202);
          expect(webhookDeliverySummarySchema.parse(response.body)).toMatchObject({
            attempts: 1,
            eventId,
            id: deliveryId,
            state: 'pending',
          });

          const [, second] = await arrived('/replay', 2);
          verify(second!, secret);
          expect(second!.headers['forge-event-id']).toBe(eventId);
          expect(second!.headers['forge-delivery-id']).toBe(deliveryId);
          expect(second!.body.equals(first!.body)).toBe(true);
          const stamp = (request: ReceivedRequest) =>
            Number(/^t=(\d+),/.exec(request.headers['forge-signature'] as string)?.[1]);
          expect(stamp(second!) - stamp(first!)).toBeGreaterThanOrEqual(60);

          await settled(endpoint.id, 'succeeded');
          const { delivery } = await read(endpoint.id, deliveryId);
          expect(delivery).toMatchObject({ attempts: 1, state: 'succeeded' });
          expect(delivery.attemptLog.map((attempt) => [attempt.status, attempt.manual])).toEqual([
            [204, true],
            [400, false],
          ]);
          const audits = await inTenant(world.alpha.orgId, (tx) =>
            tx
              .select({ actorId: schema.auditLog.actorId })
              .from(schema.auditLog)
              .where(
                and(
                  eq(schema.auditLog.action, 'webhook.send-replayed'),
                  eq(schema.auditLog.target, deliveryId),
                ),
              ),
          );
          expect(audits).toEqual([{ actorId: world.alpha.owner.userId }]);
        });

        it('marks a body expired after 7 days and refuses its replay', async () => {
          receiver.script('/expiring', respond(200, { body: 'thanks' }));
          const { endpoint } = await endpointAt('/expiring', ['deploy.succeeded']);
          await produceDeploySucceeded();
          const deliveryId = await settled(endpoint.id, 'succeeded');

          clock.advance(7 * DAY + 60_000);
          await app.get(WebhooksMaintenanceConsumer).retain([world.alpha.orgId]);

          const { delivery } = await read(endpoint.id, deliveryId);
          expect(delivery.body).toBeNull();
          expect(delivery.attemptLog).toMatchObject([{ responseBody: null, status: 200 }]);
          const refused = await replay(endpoint.id, deliveryId).expect(409);
          expect(problemOf(refused.body)).toMatchObject({ reason: 'delivery-expired' });
          await new Promise((resolve) => setTimeout(resolve, 300));
          expect(receiver.requests('/expiring')).toHaveLength(1);
        });

        it('drops a delivery from the log after 30 days', async () => {
          const { endpoint } = await endpointAt('/aging', ['deploy.succeeded']);
          await produceDeploySucceeded();
          const deliveryId = await settled(endpoint.id, 'succeeded');

          clock.advance(30 * DAY + 60_000);
          const list = await http(app)
            .get(deliveriesPath(endpoint.id))
            .set('Cookie', world.alpha.owner.cookie)
            .expect(200);
          expect(webhookDeliveryListSchema.parse(list.body)).toEqual({
            items: [],
            nextCursor: null,
          });
          await http(app)
            .get(deliveriesPath(endpoint.id, `/${deliveryId}`))
            .set('Cookie', world.alpha.owner.cookie)
            .expect(404);

          await app.get(WebhooksMaintenanceConsumer).retain([world.alpha.orgId]);
          expect(await sendsOf(endpoint.id)).toEqual([]);
          const attempts = await inTenant(world.alpha.orgId, (tx) =>
            tx
              .select()
              .from(schema.webhookSendAttempts)
              .where(eq(schema.webhookSendAttempts.sendId, deliveryId)),
          );
          expect(attempts).toEqual([]);
        });

        it('404s a delivery id read through another endpoint', async () => {
          const mine = await endpointAt('/mine', ['deploy.succeeded']);
          const other = await endpointAt('/other', ['deploy.failed']);
          await produceDeploySucceeded();
          const deliveryId = await settled(mine.endpoint.id, 'succeeded');

          const read404 = await http(app)
            .get(deliveriesPath(other.endpoint.id, `/${deliveryId}`))
            .set('Cookie', world.alpha.owner.cookie)
            .expect(404);
          const unknown = await http(app)
            .get(deliveriesPath(mine.endpoint.id, `/${randomUUID()}`))
            .set('Cookie', world.alpha.owner.cookie)
            .expect(404);
          expect(problemOf(read404.body)).toEqual(problemOf(unknown.body));
          await replay(other.endpoint.id, deliveryId).expect(404);
          // `instance` echoes the request path; nothing else in the problem names the delivery.
          expect(JSON.stringify(problemOf(read404.body))).not.toContain(deliveryId);
        });
      });

      describe('US5: secret rotation', () => {
        const HOUR = 3_600_000;

        function rotate(endpointId: string, body: { expireOld?: boolean } = {}) {
          return unsafe(
            http(app).post(`${endpointsPath(world.alpha.orgId)}/${endpointId}/rotate-secret`),
            [world.alpha.owner.cookie],
          ).send(body);
        }

        function stampOf(request: ReceivedRequest): number {
          return Number(/^t=(\d+),/.exec(request.headers['forge-signature'] as string)?.[1]);
        }

        function expectSignedBy(request: ReceivedRequest, secrets: readonly string[]): void {
          const header = request.headers['forge-signature'] as string;
          expect(header).toBe(
            signPayload(secrets, stampOf(request), request.body.toString('utf8')),
          );
          expect(header.match(/v1=/g)).toHaveLength(secrets.length);
        }

        it('signs with both secrets during the overlap, newest first', async () => {
          const { endpoint, secret: oldSecret } = await endpointAt('/overlap', [
            'deploy.succeeded',
          ]);

          const response = await rotate(endpoint.id).expect(200);
          const rotated = webhookSecretResponseSchema.parse(response.body);
          expect(rotated.secret).toMatch(/^whsec_/);
          expect(rotated.secret).not.toBe(oldSecret);
          expect(response.text).not.toContain(oldSecret);
          expect(rotated.endpoint.secretRotation).toEqual({
            previousExpiresAt: new Date(clock.now().getTime() + 24 * HOUR).toISOString(),
          });

          clock.advance(23 * HOUR);
          await produceDeploySucceeded();

          const [request] = await arrived('/overlap');
          expectSignedBy(request!, [rotated.secret, oldSecret]);
          // A verifier holding either secret alone accepts the request.
          const body = request!.body.toString('utf8');
          const header = request!.headers['forge-signature'] as string;
          const [newest, previous] = header.split(',').slice(1);
          expect(`t=${String(stampOf(request!))},${newest!}`).toBe(
            signPayload([rotated.secret], stampOf(request!), body),
          );
          expect(`t=${String(stampOf(request!))},${previous!}`).toBe(
            signPayload([oldSecret], stampOf(request!), body),
          );
        });

        it('signs with only the new secret after 24 hours or when the old one is expired at once', async () => {
          const aged = await endpointAt('/aged', ['deploy.succeeded']);
          const agedRotation = webhookSecretResponseSchema.parse(
            (await rotate(aged.endpoint.id).expect(200)).body,
          );
          const now = await endpointAt('/expired-now', ['deploy.succeeded']);
          const nowRotation = webhookSecretResponseSchema.parse(
            (await rotate(now.endpoint.id, { expireOld: true }).expect(200)).body,
          );
          expect(nowRotation.endpoint.secretRotation).toBeNull();

          clock.advance(24 * HOUR + 60_000);
          await produceDeploySucceeded();

          const [agedRequest] = await arrived('/aged');
          const [nowRequest] = await arrived('/expired-now');
          expectSignedBy(agedRequest!, [agedRotation.secret]);
          expectSignedBy(nowRequest!, [nowRotation.secret]);

          // Retention then deletes the expired previous secret and clears the overlap.
          const [before] = await inTenant(world.alpha.orgId, (tx) =>
            tx
              .select({ previousSecretId: schema.webhookEndpoints.previousSecretId })
              .from(schema.webhookEndpoints)
              .where(eq(schema.webhookEndpoints.id, aged.endpoint.id)),
          );
          expect(before!.previousSecretId).not.toBeNull();
          await app.get(WebhooksMaintenanceConsumer).retain([world.alpha.orgId]);
          const read = await http(app)
            .get(`${endpointsPath(world.alpha.orgId)}/${aged.endpoint.id}`)
            .set('Cookie', world.alpha.owner.cookie)
            .expect(200);
          expect(webhookEndpointSchema.parse(read.body).secretRotation).toBeNull();
          const left = await inTenant(world.alpha.orgId, (tx) =>
            tx
              .select({ id: schema.secrets.id })
              .from(schema.secrets)
              .where(eq(schema.secrets.id, before!.previousSecretId!)),
          );
          expect(left).toEqual([]);
        });

        it('never returns a secret outside create and rotate', async () => {
          const created = await createEndpoint(world.alpha.orgId, world.alpha.owner, {
            eventTypes: ['deploy.succeeded'],
            path: '/walk',
          }).expect(201);
          const { endpoint } = webhookSecretResponseSchema.parse(created.body);
          const rotated = await rotate(endpoint.id).expect(200);
          expect(created.text).toContain('whsec_');
          expect(rotated.text).toContain('whsec_');

          const one = `${endpointsPath(world.alpha.orgId)}/${endpoint.id}`;
          const cookie = world.alpha.owner.cookie;
          const texts: string[] = [];
          texts.push(
            (
              await http(app)
                .get(endpointsPath(world.alpha.orgId))
                .set('Cookie', cookie)
                .expect(200)
            ).text,
          );
          texts.push((await http(app).get(one).set('Cookie', cookie).expect(200)).text);
          texts.push(
            (
              await unsafe(http(app).patch(one), [cookie])
                .send({ description: 'walked' })
                .expect(200)
            ).text,
          );
          texts.push((await unsafe(http(app).post(`${one}/test`), [cookie]).expect(202)).text);
          const ok = await until(async () => {
            const page = await http(app).get(`${one}/deliveries`).set('Cookie', cookie);
            return webhookDeliveryListSchema
              .parse(page.body)
              .items.some((item) => item.state === 'succeeded');
          }, DELIVERY_WAIT_MS);
          expect(ok).toBe(true);
          const list = await http(app).get(`${one}/deliveries`).set('Cookie', cookie).expect(200);
          texts.push(list.text);
          const [delivery] = webhookDeliveryListSchema.parse(list.body).items;
          texts.push(
            (
              await http(app)
                .get(`${one}/deliveries/${delivery!.id}`)
                .set('Cookie', cookie)
                .expect(200)
            ).text,
          );
          texts.push(
            (
              await unsafe(http(app).post(`${one}/deliveries/${delivery!.id}/replay`), [
                cookie,
              ]).expect(202)
            ).text,
          );
          texts.push((await unsafe(http(app).delete(one), [cookie]).expect(204)).text);

          for (const text of texts) expect(text).not.toContain('whsec_');
        });
      });

      describe('US3: retry, circuit and pause', () => {
        const MINUTE = 60_000;
        const HOUR = 60 * MINUTE;
        const NOMINAL_GAPS = [
          MINUTE,
          5 * MINUTE,
          30 * MINUTE,
          2 * HOUR,
          5 * HOUR,
          8 * HOUR,
          8 * HOUR,
        ];

        function sendsOf(endpointId: string) {
          return inTenant(world.alpha.orgId, (tx) =>
            tx
              .select()
              .from(schema.webhookSends)
              .where(eq(schema.webhookSends.endpointId, endpointId))
              .orderBy(asc(schema.webhookSends.createdAt), asc(schema.webhookSends.id)),
          );
        }

        async function endpointRow(endpointId: string) {
          const [row] = await inTenant(world.alpha.orgId, (tx) =>
            tx
              .select()
              .from(schema.webhookEndpoints)
              .where(eq(schema.webhookEndpoints.id, endpointId)),
          );
          return row!;
        }

        /**
         * Waits until every send of the endpoint has been claimed once: attempted, out of
         * `pending`, or released to an open circuit's close (which consumes no attempt).
         */
        async function firstAttempts(endpointId: string, count: number): Promise<void> {
          const ok = await until(async () => {
            const rows = await sendsOf(endpointId);
            return (
              rows.length >= count &&
              rows.every(
                (row) =>
                  row.state !== 'pending' ||
                  row.attempts > 0 ||
                  row.nextAttemptAt!.getTime() > row.createdAt.getTime(),
              )
            );
          }, DELIVERY_WAIT_MS);
          expect(ok, `first attempts of ${count} send(s)`).toBe(true);
        }

        /**
         * One redelivery tick, as the 60 s `webhook.redeliver` would run it: the clock to the
         * earliest due `pending` send of the endpoint, the sweep, then a wait until every send it
         * claimed has been attempted (or released by the circuit). False when nothing is pending.
         */
        async function tick(endpointId: string, notAfter = Number.POSITIVE_INFINITY) {
          const pending = (await sendsOf(endpointId)).filter((row) => row.state === 'pending');
          if (pending.length === 0) return false;
          const earliest = Math.min(...pending.map((row) => row.nextAttemptAt!.getTime()));
          if (earliest > notAfter) return false;
          if (earliest > clock.now().getTime()) clock.set(earliest);
          const leased = clock.now().getTime() + 30_000;

          await app.get(WebhooksMaintenanceConsumer).redeliver([world.alpha.orgId]);

          const ok = await until(
            async () =>
              (await sendsOf(endpointId)).every(
                (row) => row.state !== 'pending' || row.nextAttemptAt!.getTime() !== leased,
              ),
            DELIVERY_WAIT_MS,
          );
          expect(ok, 'the claimed attempts settle').toBe(true);
          return true;
        }

        /** Ticks until nothing of the endpoint is due by `notAfter`, then moves the clock there. */
        async function driveUntil(endpointId: string, notAfter: number): Promise<void> {
          for (let guard = 0; guard < 200 && (await tick(endpointId, notAfter)); guard += 1);
          if (Number.isFinite(notAfter) && notAfter > clock.now().getTime()) clock.set(notAfter);
        }

        it('walks the eight-attempt schedule on 503 and succeeds when the receiver recovers', async () => {
          receiver.script('/walk', ...Array.from({ length: 7 }, () => respond(503)), respond(204));
          const { endpoint } = await endpointAt('/walk', ['deploy.succeeded']);
          await produceDeploySucceeded();
          await firstAttempts(endpoint.id, 1);
          const firstAt = clock.now().getTime();

          for (let attempt = 1; attempt <= 7; attempt += 1) {
            const [send] = await sendsOf(endpoint.id);
            expect(send).toMatchObject({ attempts: attempt, state: 'pending' });
            const gap = send!.nextAttemptAt!.getTime() - clock.now().getTime();
            const nominal = NOMINAL_GAPS[attempt - 1]!;
            const clamped = send!.nextAttemptAt!.getTime() === firstAt + 24 * HOUR;
            expect(
              clamped || (gap >= 0.8 * nominal - 1 && gap <= 1.2 * nominal + 1),
              `gap after attempt ${attempt}: ${gap} ms`,
            ).toBe(true);
            expect(await tick(endpoint.id)).toBe(true);
          }

          const [send] = await sendsOf(endpoint.id);
          expect(send).toMatchObject({ attempts: 8, lastFailure: null, state: 'succeeded' });
          expect(receiver.requests('/walk')).toHaveLength(8);
          expect(send!.updatedAt.getTime()).toBeLessThanOrEqual(firstAt + 24 * HOUR);
          expect(await endpointRow(endpoint.id)).toMatchObject({
            circuitOpenUntil: null,
            failingSince: null,
            failureCount: 0,
            state: 'enabled',
          });
        }, 120_000);

        it('delivers every delivery recorded during a 12-hour outage once the receiver recovers', async () => {
          receiver.script('/outage', respond(503));
          const { endpoint } = await endpointAt('/outage', ['deploy.succeeded']);
          const start = clock.now().getTime();
          const eventIds: string[] = [];

          for (const offset of [0, 4 * HOUR, 8 * HOUR, 12 * HOUR]) {
            await driveUntil(endpoint.id, start + offset);
            eventIds.push(await produceDeploySucceeded());
            await firstAttempts(endpoint.id, eventIds.length);
          }
          receiver.script('/outage', respond(204));
          await driveUntil(endpoint.id, Number.POSITIVE_INFINITY);

          const sends = await sendsOf(endpoint.id);
          expect(sends.map((row) => row.state)).toEqual([
            'succeeded',
            'succeeded',
            'succeeded',
            'succeeded',
          ]);
          const delivered = new Set(
            receiver.requests('/outage').map((request) => request.headers['forge-event-id']),
          );
          for (const eventId of eventIds) expect(delivered.has(eventId), eventId).toBe(true);
          expect((await endpointRow(endpoint.id)).state).toBe('enabled');
        }, 180_000);

        it('attempts a 400 exactly once', async () => {
          receiver.script('/bad', respond(400));
          const { endpoint } = await endpointAt('/bad', ['deploy.succeeded']);
          await produceDeploySucceeded();
          await firstAttempts(endpoint.id, 1);

          clock.advance(25 * HOUR);
          await app.get(WebhooksMaintenanceConsumer).redeliver([world.alpha.orgId]);
          await new Promise((resolve) => setTimeout(resolve, 500));

          expect(receiver.requests('/bad')).toHaveLength(1);
          expect(await sendsOf(endpoint.id)).toMatchObject([
            { attempts: 1, lastFailure: 'http-error', nextAttemptAt: null, state: 'failed' },
          ]);
        });

        it('honours a longer Retry-After on 429', async () => {
          receiver.script('/busy', retryAfter(600, 429), respond(204));
          const { endpoint } = await endpointAt('/busy', ['deploy.succeeded']);
          await produceDeploySucceeded();
          await firstAttempts(endpoint.id, 1);

          const [send] = await sendsOf(endpoint.id);
          expect(send).toMatchObject({ attempts: 1, state: 'pending' });
          expect(send!.nextAttemptAt!.getTime() - clock.now().getTime()).toBe(600_000);

          expect(await tick(endpoint.id)).toBe(true);
          expect((await sendsOf(endpoint.id))[0]).toMatchObject({
            attempts: 2,
            state: 'succeeded',
          });
        });

        it('keeps delivering to a healthy endpoint while another endpoint circuit is open', async () => {
          const tripped = await endpointAt('/tripped', ['deploy.succeeded']);
          const healthy = await endpointAt('/healthy', ['deploy.succeeded']);
          const closes = new Date(clock.now().getTime() + 10 * MINUTE);
          await inTenant(world.alpha.orgId, (tx) =>
            tx
              .update(schema.webhookEndpoints)
              .set({
                circuitOpenUntil: closes,
                failingSince: clock.now(),
                failureCount: 5,
              })
              .where(eq(schema.webhookEndpoints.id, tripped.endpoint.id)),
          );

          const eventId = await produceDeploySucceeded();

          const [request] = await arrived('/healthy');
          expect(request!.headers['forge-event-id']).toBe(eventId);
          verify(request!, healthy.secret);
          const released = await until(async () => {
            const [send] = await sendsOf(tripped.endpoint.id);
            return send?.nextAttemptAt?.getTime() === closes.getTime();
          }, DELIVERY_WAIT_MS);
          expect(released).toBe(true);
          expect(await sendsOf(tripped.endpoint.id)).toMatchObject([
            { attempts: 0, claimedUntil: null, state: 'pending' },
          ]);
          expect(receiver.requests('/tripped')).toEqual([]);
        });

        it('pauses the endpoint after 24 hours of failure and notifies each owner once', async () => {
          receiver.script('/down', respond(503));
          const { endpoint } = await endpointAt('/down', ['deploy.succeeded']);
          const start = clock.now().getTime();
          const owners = await inTenant(world.alpha.orgId, (tx) =>
            tx
              .select({ email: schema.users.email })
              .from(schema.memberships)
              .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
              .where(
                and(
                  eq(schema.memberships.orgId, world.alpha.orgId),
                  eq(schema.memberships.role, 'owner'),
                  isNotNull(schema.memberships.acceptedAt),
                ),
              ),
          );
          const pausedMails = () =>
            mailer.outbox.filter((message) => message.template === 'webhook-paused');
          const before = pausedMails().length;

          await produceDeploySucceeded();
          await firstAttempts(endpoint.id, 1);
          // A second delivery six hours in: it gives up more than 24 h after the failing began.
          await driveUntil(endpoint.id, start + 6 * HOUR);
          await produceDeploySucceeded();
          await firstAttempts(endpoint.id, 2);
          await driveUntil(endpoint.id, Number.POSITIVE_INFINITY);

          const row = await endpointRow(endpoint.id);
          expect(row.state).toBe('paused');
          expect(row.pausedAt!.getTime()).toBeGreaterThanOrEqual(start + 24 * HOUR);
          // The send that gave up is `failed`; one still pending when the pause came is
          // `not_sent` (which one depends on the jitter).
          const states = (await sendsOf(endpoint.id)).map((send) => send.state);
          expect(states).toContain('failed');
          expect(states.every((state) => state === 'failed' || state === 'not_sent')).toBe(true);

          const mailed = await until(
            () => pausedMails().length - before >= owners.length,
            DELIVERY_WAIT_MS,
          );
          expect(mailed).toBe(true);
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          const sent = pausedMails().slice(before);
          expect(sent.map((message) => message.to).sort()).toEqual(
            owners.map((owner) => owner.email).sort(),
          );
          for (const message of sent) {
            expect(message.text).toContain(HOST);
            expect(message.text).not.toContain('/down');
          }
        }, 180_000);

        it('records deliveries for a paused endpoint as not sent and delivers again once re-enabled', async () => {
          const { endpoint, secret } = await endpointAt('/resumed', ['deploy.succeeded']);
          await inTenant(world.alpha.orgId, (tx) =>
            tx
              .update(schema.webhookEndpoints)
              .set({ failingSince: clock.now(), pausedAt: clock.now(), state: 'paused' })
              .where(eq(schema.webhookEndpoints.id, endpoint.id)),
          );

          const whilePaused = await produceDeploySucceeded();
          const recorded = await until(
            async () => (await sendsOf(endpoint.id)).length === 1,
            DELIVERY_WAIT_MS,
          );
          expect(recorded).toBe(true);
          expect(await sendsOf(endpoint.id)).toMatchObject([
            { nextAttemptAt: null, state: 'not_sent' },
          ]);

          const enabled = await unsafe(
            http(app).patch(`${endpointsPath(world.alpha.orgId)}/${endpoint.id}`),
            [world.alpha.owner.cookie],
          )
            .send({ enabled: true })
            .expect(200);
          expect(webhookEndpointSchema.parse(enabled.body)).toMatchObject({
            lastFailure: null,
            pausedAt: null,
            state: 'enabled',
          });

          const eventId = await produceDeploySucceeded();
          const [request] = await arrived('/resumed');
          expect(request!.headers['forge-event-id']).toBe(eventId);
          verify(request!, secret);
          expect(receiver.requests('/resumed')).toHaveLength(1);
          const settled = await until(
            async () => (await sendsOf(endpoint.id)).some((send) => send.state === 'succeeded'),
            DELIVERY_WAIT_MS,
          );
          expect(settled).toBe(true);
          const states = new Map(
            (await sendsOf(endpoint.id)).map((send) => [send.eventId, send.state]),
          );
          expect(Object.fromEntries(states)).toEqual({
            [eventId]: 'succeeded',
            [whilePaused]: 'not_sent',
          });
        });
      });
    },
  );
});
