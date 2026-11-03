import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { webhookDeliverySummarySchema, webhookSecretResponseSchema } from '@repo/contracts';
import { schema } from '@repo/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import type { ClockPort } from '../src/common/clock/clock.port';
import type { TenantTransaction } from '../src/database/database.types';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../src/modules/identity/password/breached-password.port';
import { classifyAttempt } from '../src/modules/webhooks/outbound/classify';
import type { DestinationPolicy } from '../src/modules/webhooks/outbound/destination';
import { WEBHOOK_RESOLVER } from '../src/modules/webhooks/outbound/resolver.port';
import {
  SafeTransport,
  type WebhookRequest,
} from '../src/modules/webhooks/outbound/safe-transport';
import { ATTEMPT_TIMEOUT_MS } from '../src/modules/webhooks/webhooks.constants';
import { unsafe } from './support/csrf-client';
import {
  type FakeReceiver,
  hang,
  redirect,
  startFakeReceiver,
  unboundedBody,
} from './support/fake-receiver';
import { FakeResolver } from './support/fake-resolver';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  http,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  // `events` relays the outbox and drains `integration.out` in process, under the suite lock.
  process.env.RUN_PROFILES = 'api,events';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.THROTTLE_LIMIT = '100000';
  process.env.LOGIN_THROTTLE_ACCOUNT_BURST = '100';
  process.env.LOGIN_THROTTLE_IP_BURST = '4000';
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const ORGS = '/api/v1/orgs';
const LOCKED_BOOT_TIMEOUT_MS = 600_000;
const DELIVERY_WAIT_MS = 15_000;
/** A documentation-range stand-in for "resolved publicly": never connected to by this suite. */
const PUBLIC_ADDRESS = '93.184.216.34';
/** The "public" loopback alias of the second policy, and the "private" one it refuses. */
const PUBLIC_ALIAS = '127.0.0.2';
const PRIVATE_ALIAS = '127.0.0.3';

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
 * Spec 029 US2 (SC-002, SC-005) over the real API, Postgres, the queue and the in-process attempt
 * worker, with the **real** `DESTINATION_POLICY`: nothing overrides it. The receiver listens on
 * loopback, which that policy refuses; that is the point. Only the resolver is a fake, so a test
 * can script what DNS answers.
 *
 * The cases that need a connection to succeed first (mixed answers, a redirect, a stall, an
 * unbounded body) use a second `SafeTransport` with a policy that admits one designated "public"
 * loopback alias only, and classify its result through `classifyAttempt`, as the consumer does.
 */
describe('Webhooks, destination policy (e2e)', () => {
  describe.skipIf(!postgres || !redis)('with the real destination policy', () => {
    let app: INestApplication;
    let world: TwoTenantWorld;
    let transactions: TenantTransactionRunner;
    let receiver: FakeReceiver;
    let suiteLock: { release: () => Promise<void> } | undefined;
    const resolver = new FakeResolver();

    const endpointsPath = (orgId: string) => `${ORGS}/${orgId}/webhooks/endpoints`;

    function inTenant<T>(orgId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantTransaction(orgId, fn);
    }

    function create(url: string) {
      return unsafe(http(app).post(endpointsPath(world.alpha.orgId)), [
        world.alpha.owner.cookie,
      ]).send({ eventTypes: ['deploy.succeeded'], url });
    }

    /** Creates an endpoint at `host`, sends it a test ping, and waits for the send to settle. */
    async function pingThrough(host: string, path: string) {
      const created = await create(receiver.url(path, { host })).expect(201);
      const { endpoint } = webhookSecretResponseSchema.parse(created.body);
      const response = await unsafe(
        http(app).post(`${endpointsPath(world.alpha.orgId)}/${endpoint.id}/test`),
        [world.alpha.owner.cookie],
      ).expect(202);
      const summary = webhookDeliverySummarySchema.parse(response.body);

      const read = () =>
        inTenant(world.alpha.orgId, async (tx) => ({
          attempts: await tx
            .select()
            .from(schema.webhookSendAttempts)
            .where(eq(schema.webhookSendAttempts.sendId, summary.id)),
          send: (
            await tx
              .select()
              .from(schema.webhookSends)
              .where(eq(schema.webhookSends.id, summary.id))
          )[0],
        }));
      // Settled: out of `pending`, or (a retryable failure, US3) back in it after one attempt.
      const settled = await until(async () => {
        const { send } = await read();
        return (
          send !== undefined &&
          (send.state !== 'pending' || (send.attempts > 0 && send.claimedUntil === null))
        );
      }, DELIVERY_WAIT_MS);
      expect(settled, `send ${summary.id} settled`).toBe(true);
      return read();
    }

    beforeAll(async () => {
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
      receiver = await startFakeReceiver();

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(BREACHED_PASSWORD_PORT)
        .useClass(ScriptedBreachPort)
        .overrideProvider(WEBHOOK_RESOLVER)
        .useValue(resolver)
        .compile();

      app = moduleRef.createNestApplication();
      configureApplication(app);
      await app.init();

      transactions = app.get(TenantTransactionRunner);
      world = await createTwoTenantWorld(app);
    }, LOCKED_BOOT_TIMEOUT_MS);

    afterEach(async () => {
      receiver.reset();
      resolver.reset();
      await inTenant(world.alpha.orgId, async (tx) => {
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
    });

    afterAll(async () => {
      if (app !== undefined) await destroyTwoTenantWorld(app, world);
      await app?.close();
      await receiver?.close();
      await suiteLock?.release();
    });

    it('refuses a literal special-use address at save for each of 127.0.0.1, 10.0.0.1, 169.254.169.254, [::1], [::ffff:10.0.0.1]', async () => {
      for (const host of [
        '127.0.0.1',
        '10.0.0.1',
        '169.254.169.254',
        '[::1]',
        '[::ffff:10.0.0.1]',
      ]) {
        const response = await create(`http://${host}/hook`);
        expect(response.status, host).toBe(409);
        expect(response.body, host).toMatchObject({ reason: 'destination-not-allowed' });
      }
      const listed = await http(app)
        .get(endpointsPath(world.alpha.orgId))
        .set('Cookie', world.alpha.owner.cookie)
        .expect(200);
      expect(listed.body).toEqual({ items: [] });
    });

    it.each(['169.254.169.254', '10.0.0.1', '127.0.0.1', '::1', '::ffff:10.0.0.1', '100.64.0.1'])(
      'makes no connection when a name that resolved publicly re-resolves to %s',
      async (address) => {
        const host = `rebind-${address.replaceAll(/[.:]/g, '-')}.webhooks-e2e.test`;
        resolver.set(host, [[PUBLIC_ADDRESS], [address]]);
        // The name resolved publicly once: the answer a save-time check would have seen.
        expect(await resolver.resolve(host)).toEqual({
          addresses: [PUBLIC_ADDRESS],
          kind: 'answer',
        });

        const { attempts, send } = await pingThrough(host, '/rebind');

        expect(receiver.all).toHaveLength(0);
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({
          address: null,
          failure: 'destination-refused',
          status: null,
        });
        expect(send).toMatchObject({
          attempts: 1,
          lastFailure: 'destination-refused',
          state: 'failed',
        });
      },
    );

    it('treats an unresolvable name as retryable dns-failed, not a destination refusal', async () => {
      const host = 'nxdomain.webhooks-e2e.test';
      const { attempts, send } = await pingThrough(host, '/nx');

      expect(receiver.all).toHaveLength(0);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ address: null, failure: 'dns-failed', status: null });
      expect(send?.lastFailure).toBe('dns-failed');
      // Retryable: the schedule keeps it pending for the next attempt (US3).
      expect(send).toMatchObject({ attempts: 1, state: 'pending' });
      expect(classifyAttempt({ error: 'dns-failed', headers: {}, status: null }).kind).toBe(
        'retryable',
      );

      resolver.unavailable(host);
      const down = await pingThrough(host, '/down');
      expect(down.attempts[0]).toMatchObject({ address: null, failure: 'dns-failed' });
    });

    describe('through a policy that admits one "public" loopback alias', () => {
      let publicReceiver: FakeReceiver;
      let privateReceiver: FakeReceiver;
      let transport: SafeTransport;
      const aliasResolver = new FakeResolver();
      const onlyPublic: DestinationPolicy = { isAllowedAddress: (ip) => ip === PUBLIC_ALIAS };
      const realClock: ClockPort = { now: () => new Date() };
      const HOST = 'mixed.webhooks-e2e.test';

      const request = (url: string): WebhookRequest => ({
        body: '{"type":"ping"}',
        deliveryId: '11111111-1111-4111-8111-111111111111',
        eventId: '22222222-2222-4222-8222-222222222222',
        eventType: 'ping',
        signature: `t=1790000000,v1=${'a'.repeat(64)}`,
        url,
      });

      beforeAll(async () => {
        publicReceiver = await startFakeReceiver({ host: PUBLIC_ALIAS });
        // The same port on the private alias, so a URL that reached either would reach it.
        privateReceiver = await startFakeReceiver({
          host: PRIVATE_ALIAS,
          port: publicReceiver.port,
        });
        transport = new SafeTransport(aliasResolver, onlyPublic, realClock);
      });

      afterEach(() => {
        publicReceiver.reset();
        privateReceiver.reset();
        aliasResolver.reset();
      });

      afterAll(async () => {
        await publicReceiver?.close();
        await privateReceiver?.close();
      });

      it('connects only to the public address when the answer mixes public and private', async () => {
        aliasResolver.set(HOST, [[PRIVATE_ALIAS, PUBLIC_ALIAS, '10.0.0.1']]);

        const result = await transport.send(request(publicReceiver.url('/mixed', { host: HOST })));

        expect(result).toMatchObject({ address: PUBLIC_ALIAS, error: null, status: 200 });
        expect(publicReceiver.requests('/mixed')).toHaveLength(1);
        expect(privateReceiver.all).toHaveLength(0);
      });

      it('does not follow a redirect to a private address', async () => {
        aliasResolver.set(HOST, [[PUBLIC_ALIAS]]);
        publicReceiver.script('/redirect', redirect(privateReceiver.url('/landing')));

        const result = await transport.send(
          request(publicReceiver.url('/redirect', { host: HOST })),
        );

        expect(result.status).toBe(302);
        expect(classifyAttempt(result)).toMatchObject({
          failure: 'redirect-not-followed',
          kind: 'terminal',
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(privateReceiver.all).toHaveLength(0);
        expect(publicReceiver.all).toHaveLength(1);
      });

      it(
        'ends a stalled receiver at 10 s as timeout',
        async () => {
          aliasResolver.set(HOST, [[PUBLIC_ALIAS]]);
          publicReceiver.script('/stall', hang());

          const result = await transport.send(
            request(publicReceiver.url('/stall', { host: HOST })),
          );

          expect(result.error).toBe('timeout');
          expect(result.durationMs).toBeGreaterThanOrEqual(ATTEMPT_TIMEOUT_MS - 50);
          expect(result.durationMs).toBeLessThan(ATTEMPT_TIMEOUT_MS + 2_000);
          expect(classifyAttempt(result)).toMatchObject({ failure: 'timeout', kind: 'retryable' });
        },
        ATTEMPT_TIMEOUT_MS + 10_000,
      );

      it('ends an unbounded body as response-too-large', async () => {
        aliasResolver.set(HOST, [[PUBLIC_ALIAS]]);
        publicReceiver.script('/flood', unboundedBody());

        const result = await transport.send(request(publicReceiver.url('/flood', { host: HOST })));

        expect(result.error).toBe('response-too-large');
        expect(result.durationMs).toBeLessThan(ATTEMPT_TIMEOUT_MS);
        expect(classifyAttempt(result)).toMatchObject({
          failure: 'response-too-large',
          kind: 'terminal',
        });
      });
    });
  });
});
