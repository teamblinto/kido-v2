import type { INestApplication } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { eq, inArray } from 'drizzle-orm';
import { createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { INBOUND_PATHS } from '../src/common/csrf/inbound-paths';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import { WEBHOOK_REJECTION } from '../src/modules/webhooks/inbound/verifiers/github.verifier';
import { unsafe } from './support/csrf-client';

const POSTGRES = inject('postgresReachable');
const REDIS = inject('redisReachable');

/** `HOOKS_HOST`'s `local` default; the suites set no other. */
const HOOKS = 'hooks.localhost';
const PRODUCT = 'app.localhost';
const ENDPOINT = INBOUND_PATHS[0];

function signGithub(body: string): string {
  const secret = process.env.GITHUB_WEBHOOK_SECRET!;

  return `sha256=${createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')}`;
}

function pushBody(): string {
  return JSON.stringify({
    after: '9a7c2d1e5b3f4086a2c1d0e9f8b7a6c5d4e3f201',
    installation: { id: 42_000_987 },
    ref: 'refs/heads/main',
    repository: { id: 8_800_987 },
  });
}

async function boot(config?: ConfigService): Promise<INestApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule] });

  if (config !== undefined) {
    builder = builder.overrideProvider(ConfigService).useValue(config);
  }

  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ rawBody: true });

  configureApplication(app);
  await app.init();

  return app;
}

/**
 * Spec 029 US6 — the inbound pipeline on the dedicated hooks origin (contracts/hooks-origin.md).
 *
 * Both addresses reach one handler and one `unique (provider, delivery_id)`; the hooks host serves
 * nothing but the inbound paths (SC-012); and the product-host address can be retired by
 * `WEBHOOK_LEGACY_ADDRESS=false` without touching the hooks one.
 */
describe('webhooks hooks origin (e2e)', () => {
  describe.skipIf(!POSTGRES || !REDIS)('against Postgres', () => {
    let app: INestApplication;
    let retired: INestApplication;
    let db: ForgeDatabase;
    const deliveries: string[] = [];

    beforeAll(async () => {
      app = await boot();
      db = app.get<ForgeDatabase>(APP_DATABASE);

      // The same validated configuration with the legacy address switched off: a second
      // application, because the middleware reads the setting once, at construction.
      const validated = app.get(ConfigService);
      const legacyOff = new Proxy(validated, {
        get(target, property, receiver) {
          if (property !== 'get') return Reflect.get(target, property, receiver) as unknown;

          // `{ infer: true }` only narrows types, so the key alone reads the same value.
          return (key: string) =>
            key === 'WEBHOOK_LEGACY_ADDRESS'
              ? false
              : (target as { get(k: string): unknown }).get(key);
        },
      });

      retired = await boot(legacyOff);
    }, 600_000);

    afterAll(async () => {
      // The rows only; the outbox is append-only to this role, and a relayed `webhook.received`
      // whose delivery is gone is one the consumer already treats as nothing to do.
      if (db !== undefined && deliveries.length > 0) {
        await db
          .delete(schema.webhookDeliveries)
          .where(inArray(schema.webhookDeliveries.deliveryId, deliveries));
      }
      await retired?.close();
      await app?.close();
    });

    function deliver(
      target: INestApplication,
      host: string,
      deliveryId: string,
      signed = true,
    ): request.Test {
      const body = pushBody();
      const call = request(target.getHttpServer() as Server)
        .post(ENDPOINT)
        .set('Host', host)
        .set('content-type', 'application/json')
        .set('x-github-delivery', deliveryId)
        .set('x-github-event', 'push');

      deliveries.push(deliveryId);

      return (signed ? call.set('x-hub-signature-256', signGithub(body)) : call).send(body);
    }

    async function rowsFor(deliveryId: string) {
      return db
        .select({ id: schema.webhookDeliveries.id, state: schema.webhookDeliveries.state })
        .from(schema.webhookDeliveries)
        .where(eq(schema.webhookDeliveries.deliveryId, deliveryId));
    }

    async function outboxFor(aggregateId: string) {
      return db
        .select({ type: schema.outbox.type })
        .from(schema.outbox)
        .where(eq(schema.outbox.aggregateId, aggregateId));
    }

    it('accepts a signed GitHub delivery on the hooks host', async () => {
      const deliveryId = randomUUID();

      await deliver(app, `${HOOKS}:8080`, deliveryId).expect(HttpStatus.NO_CONTENT);

      const rows = await rowsFor(deliveryId);

      expect(rows).toEqual([{ id: expect.any(String) as string, state: 'received' }]);
      await expect(outboxFor(rows[0]!.id)).resolves.toEqual([{ type: 'webhook.received' }]);
    });

    it('acknowledges the same delivery id on the product host as a duplicate', async () => {
      const deliveryId = randomUUID();

      await deliver(app, HOOKS, deliveryId).expect(HttpStatus.NO_CONTENT);
      const [first] = await rowsFor(deliveryId);

      await deliver(app, PRODUCT, deliveryId).expect(HttpStatus.NO_CONTENT);

      await expect(rowsFor(deliveryId)).resolves.toEqual([first]);
      await expect(outboxFor(first!.id)).resolves.toHaveLength(1);
    });

    it.each([
      '/api/v1/auth/session',
      '/api/v1/orgs',
      '/',
      '/assets/x.js',
      `/api/v1/orgs/${randomUUID()}/projects/${randomUUID()}/runs/${randomUUID()}/stream`,
    ])('answers 404 on the hooks host for %s', async (path) => {
      const onHooks = await request(app.getHttpServer() as Server)
        .get(path)
        .set('Host', HOOKS)
        .set('X-Request-Id', 'hooks-origin-probe')
        .expect(HttpStatus.NOT_FOUND);

      expect(onHooks.body).toMatchObject({ status: 404 });
      expect(String((onHooks.body as { type?: string }).type)).toMatch(/not-found$/);
    });

    it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
      'answers an unsafe %s to a product path on the hooks host with the unknown-route 404, not a CSRF 403',
      async (method) => {
        const verb = method.toLowerCase() as 'post' | 'put' | 'patch' | 'delete';
        const server = app.getHttpServer() as Server;
        const path = `/api/v1/orgs/${randomUUID()}/projects`;

        // No CSRF cookie, header or Origin: the hooks host must refuse on the path alone.
        const onHooks = await request(server)
          [verb](path)
          .set('Host', HOOKS)
          .set('X-Request-Id', 'hooks-origin-unsafe')
          .expect(HttpStatus.NOT_FOUND);

        // The same method on a route nobody mounted, on the product host, past the CSRF check.
        const unknownPath = `/api/v1/no-such-route/${randomUUID()}`;
        const unknown = await unsafe(
          request(server)
            [verb](unknownPath)
            .set('Host', PRODUCT)
            .set('X-Request-Id', 'hooks-origin-unsafe'),
        ).expect(HttpStatus.NOT_FOUND);

        expect(onHooks.headers['content-type']).toBe(unknown.headers['content-type']);
        expect(onHooks.text).toBe(unknown.text.split(unknownPath).join(path));
      },
    );

    it('answers 404 for the product-host webhook when the legacy address is retired', async () => {
      const refused = randomUUID();
      const accepted = randomUUID();

      await deliver(retired, PRODUCT, refused).expect(HttpStatus.NOT_FOUND);
      await expect(rowsFor(refused)).resolves.toEqual([]);

      // The hooks address is unaffected by the setting.
      await deliver(retired, HOOKS, accepted).expect(HttpStatus.NO_CONTENT);
      await expect(rowsFor(accepted)).resolves.toHaveLength(1);
    });

    it('refuses an unsigned delivery on either address before anything is stored', async () => {
      for (const host of [HOOKS, PRODUCT]) {
        const deliveryId = randomUUID();
        const response = await deliver(app, host, deliveryId, false).expect(
          HttpStatus.UNAUTHORIZED,
        );

        expect((response.body as { detail?: string }).detail).toBe(WEBHOOK_REJECTION);
        await expect(rowsFor(deliveryId)).resolves.toEqual([]);
      }
    });
  });
});
