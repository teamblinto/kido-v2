import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  type WebhookEndpoint,
  webhookEndpointListSchema,
  webhookSecretResponseSchema,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { eq, inArray, isNotNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { CLOCK } from '../src/common/clock/clock.port';
import { FakeClock } from '../src/common/clock/fake-clock';
import type { TenantTransaction } from '../src/database/database.types';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../src/modules/identity/password/breached-password.port';
import { InMemoryMailer } from '../src/modules/mail/in-memory.mailer';
import { MAILER } from '../src/modules/mail/mailer.port';
import { OutboxWriter } from '../src/modules/outbox/outbox-writer';
import {
  DESTINATION_POLICY,
  type DestinationPolicy,
} from '../src/modules/webhooks/outbound/destination';
import { WEBHOOK_RESOLVER } from '../src/modules/webhooks/outbound/resolver.port';
import { WebhooksMaintenanceConsumer } from '../src/modules/webhooks/webhooks-maintenance.consumer';
import { unsafe } from './support/csrf-client';
import { type FakeReceiver, hang, respond, startFakeReceiver } from './support/fake-receiver';
import { FakeResolver } from './support/fake-resolver';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  http,
  type Tenant,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  // `events` relays the outbox and drains `webhook.fanout` and `integration.out` in process.
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
const HOST = 'receiver.webhooks-isolation.test';
const LOCKED_BOOT_TIMEOUT_MS = 600_000;
const DELIVERY_WAIT_MS = 15_000;
/** SC-006: one org's p95 delivery time while another org's receivers hang. */
const SC006_P95_MS = 1_000;

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

/**
 * Spec 029 T060: tenant isolation of outbound webhooks (US1 AS6) and per-organisation fairness
 * (SC-006), over the real API, Postgres, the queue and the in-process relay, fan-out and attempt
 * workers, against a loopback receiver reached through `FakeResolver`.
 */
describe('Webhooks, isolation (e2e)', () => {
  describe.skipIf(!postgres || !redis)(
    'against Postgres, the queue, a fake resolver and a loopback receiver',
    () => {
      let app: INestApplication;
      let world: TwoTenantWorld;
      let transactions: TenantTransactionRunner;
      let receiver: FakeReceiver;
      let suiteLock: { release: () => Promise<void> } | undefined;
      const clock = new FakeClock(new Date());
      const resolver = new FakeResolver();

      const endpointsPath = (orgId: string) => `${ORGS}/${orgId}/webhooks/endpoints`;

      function inTenant<T>(orgId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
        return transactions.runInTenantTransaction(orgId, fn);
      }

      async function endpointFor(tenant: Tenant, path: string): Promise<WebhookEndpoint> {
        const response = await unsafe(http(app).post(endpointsPath(tenant.orgId)), [
          tenant.owner.cookie,
        ])
          .send({ eventTypes: ['deploy.succeeded'], url: receiver.url(path, { host: HOST }) })
          .expect(201);
        return webhookSecretResponseSchema.parse(response.body).endpoint;
      }

      async function produce(tenant: Tenant): Promise<string> {
        const deploymentId = randomUUID();
        const { eventId } = await inTenant(tenant.orgId, (tx) =>
          app.get(OutboxWriter).append(tx, {
            aggregateId: deploymentId,
            orgId: tenant.orgId,
            payload: {
              deploymentId,
              orgId: tenant.orgId,
              projectId: tenant.projectId,
              siteLabel: 'c'.repeat(32),
            },
            type: 'deploy.succeeded',
          }),
        );
        return eventId;
      }

      beforeAll(async () => {
        suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
        receiver = await startFakeReceiver();
        resolver.set(HOST, [['127.0.0.1']]);

        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(BREACHED_PASSWORD_PORT)
          .useClass(ScriptedBreachPort)
          .overrideProvider(MAILER)
          .useValue(new InMemoryMailer())
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

        transactions = app.get(TenantTransactionRunner);
        world = await createTwoTenantWorld(app);
      }, LOCKED_BOOT_TIMEOUT_MS);

      afterEach(async () => {
        for (const orgId of [world.alpha.orgId, world.beta.orgId]) {
          // Disabled first, so a deferred attempt still coming back sends nothing, then deleted
          // once no attempt holds a lease (a hanging one ends at the 10 s transport deadline).
          await inTenant(orgId, async (tx) => {
            await tx.update(schema.webhookEndpoints).set({ pausedAt: null, state: 'disabled' });
            await tx
              .update(schema.webhookSends)
              .set({ nextAttemptAt: null, state: 'not_sent' })
              .where(eq(schema.webhookSends.state, 'pending'));
          });
          await until(
            async () =>
              (
                await inTenant(orgId, (tx) =>
                  tx
                    .select({ id: schema.webhookSends.id })
                    .from(schema.webhookSends)
                    .where(isNotNull(schema.webhookSends.claimedUntil)),
                )
              ).length === 0,
            20_000,
          );
          await inTenant(orgId, async (tx) => {
            const rows = await tx
              .delete(schema.webhookEndpoints)
              .returning({ secretId: schema.webhookEndpoints.secretId });
            if (rows.length > 0) {
              await tx.delete(schema.secrets).where(
                inArray(
                  schema.secrets.id,
                  rows.map((row) => row.secretId),
                ),
              );
            }
          });
        }
        receiver.reset();
      }, 60_000);

      afterAll(async () => {
        if (app !== undefined) await destroyTwoTenantWorld(app, world);
        await app?.close();
        await receiver?.close();
        await suiteLock?.release();
      });

      it("never shows or delivers one organisation's endpoints, deliveries or events to another", async () => {
        const alpha = await endpointFor(world.alpha, '/alpha');
        const beta = await endpointFor(world.beta, '/beta');

        const alphaEvent = await produce(world.alpha);
        const delivered = await until(
          () => receiver.requests('/alpha').length === 1,
          DELIVERY_WAIT_MS,
        );
        expect(delivered).toBe(true);
        const betaEvent = await produce(world.beta);
        expect(await until(() => receiver.requests('/beta').length === 1, DELIVERY_WAIT_MS)).toBe(
          true,
        );
        expect(receiver.requests('/alpha').map((r) => r.headers['forge-event-id'])).toEqual([
          alphaEvent,
        ]);
        expect(receiver.requests('/beta').map((r) => r.headers['forge-event-id'])).toEqual([
          betaEvent,
        ]);
        expect(receiver.requests('/beta')[0]!.body.toString('utf8')).not.toContain(
          world.alpha.orgId,
        );

        // Beta's owner sees beta's endpoint only, and alpha's id is a 404 on every route.
        const listed = await http(app)
          .get(endpointsPath(world.beta.orgId))
          .set('Cookie', world.beta.owner.cookie)
          .expect(200);
        expect(webhookEndpointListSchema.parse(listed.body).items.map((e) => e.id)).toEqual([
          beta.id,
        ]);
        const foreign = `${endpointsPath(world.beta.orgId)}/${alpha.id}`;
        await http(app).get(foreign).set('Cookie', world.beta.owner.cookie).expect(404);
        await unsafe(http(app).patch(foreign), [world.beta.owner.cookie])
          .send({ enabled: false })
          .expect(404);
        await unsafe(http(app).post(`${foreign}/test`), [world.beta.owner.cookie]).expect(404);
        await unsafe(http(app).delete(foreign), [world.beta.owner.cookie]).expect(404);
        // And alpha's org path is refused to beta's owner outright.
        const refused = await http(app)
          .get(endpointsPath(world.alpha.orgId))
          .set('Cookie', world.beta.owner.cookie);
        expect([403, 404]).toContain(refused.status);

        // Under beta's tenant, alpha's sends and endpoints do not exist.
        const seen = await inTenant(world.beta.orgId, async (tx) => ({
          endpoints: await tx
            .select({ id: schema.webhookEndpoints.id })
            .from(schema.webhookEndpoints),
          sends: await tx
            .select({ eventId: schema.webhookSends.eventId })
            .from(schema.webhookSends),
        }));
        expect(seen.endpoints.map((row) => row.id)).toEqual([beta.id]);
        expect(seen.sends.map((row) => row.eventId)).toEqual([betaEvent]);
        const alphaStill = await http(app)
          .get(`${endpointsPath(world.alpha.orgId)}/${alpha.id}`)
          .set('Cookie', world.alpha.owner.cookie)
          .expect(200);
        expect(alphaStill.body).toMatchObject({ id: alpha.id, state: 'enabled' });
      });

      it("keeps one organisation's p95 delivery time within 1 s while another organisation's receivers hang", async () => {
        for (let index = 0; index < 20; index += 1) {
          receiver.script(`/hang-${index}`, hang());
          await endpointFor(world.alpha, `/hang-${index}`);
        }
        await endpointFor(world.beta, '/fast');

        for (let index = 0; index < 200; index += 1) await produce(world.alpha);

        // Arrivals are watched while beta produces, so each is timed when it lands.
        const producedAt = new Map<string, number>();
        const arrivedAt = new Map<string, number>();
        let producing = true;
        const watching = (async () => {
          const deadline = Date.now() + 60_000;
          while ((producing || arrivedAt.size < producedAt.size) && Date.now() < deadline) {
            for (const request of receiver.requests('/fast')) {
              const eventId = request.headers['forge-event-id'] as string;
              if (!arrivedAt.has(eventId)) arrivedAt.set(eventId, Date.now());
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        })();
        for (let index = 0; index < 100; index += 1) {
          const at = Date.now();
          producedAt.set(await produce(world.beta), at);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        producing = false;
        await watching;

        const latencies = [...producedAt]
          .map(([eventId, at]) => (arrivedAt.get(eventId) ?? Number.POSITIVE_INFINITY) - at)
          .sort((a, b) => a - b);
        const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1]!;
        expect(p95, `p95 ${p95} ms`).toBeLessThanOrEqual(SC006_P95_MS);
        // Alpha's hanging receivers held at most 8 attempts at once (research R9).
        const hanging = receiver.all.filter((request) => request.path.startsWith('/hang-'));
        expect(hanging.length).toBeLessThanOrEqual(8 * 4);
      }, 120_000);

      it('deletes endpoints through the API while their attempts are in flight, without a deadlock', async () => {
        // Retryable failures keep every send coming back: settles lock the endpoint rows, the
        // attempt consumer claims and defers sends, and the sweep reclaims them, all while the
        // deletes cascade through the same rows.
        const endpoints: WebhookEndpoint[] = [];
        for (let index = 0; index < 6; index += 1) {
          receiver.script(`/churn-${index}`, respond(500));
          endpoints.push(await endpointFor(world.alpha, `/churn-${index}`));
        }
        receiver.script('/churn-hang', hang());
        endpoints.push(await endpointFor(world.alpha, '/churn-hang'));

        for (let index = 0; index < 40; index += 1) await produce(world.alpha);
        expect(await until(() => receiver.all.length >= 20, DELIVERY_WAIT_MS)).toBe(true);

        let sweeping = true;
        const sweeps = (async () => {
          while (sweeping) {
            clock.advance(60_000);
            await app.get(WebhooksMaintenanceConsumer).redeliver([world.alpha.orgId]);
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        })();

        try {
          // One after another: supertest binds the unlistened server per request, and parallel
          // binds reset each other's connections. The attempts and the sweep run meanwhile.
          const statuses: number[] = [];
          for (const endpoint of endpoints) {
            const response = await unsafe(
              http(app).delete(`${endpointsPath(world.alpha.orgId)}/${endpoint.id}`),
              [world.alpha.owner.cookie],
            );
            statuses.push(response.status);
          }
          expect(statuses).toEqual(endpoints.map(() => 204));
        } finally {
          sweeping = false;
          await sweeps;
        }

        const left = await inTenant(world.alpha.orgId, (tx) =>
          tx.select({ id: schema.webhookSends.id }).from(schema.webhookSends),
        );
        expect(left).toEqual([]);
      }, 120_000);
    },
  );
});
