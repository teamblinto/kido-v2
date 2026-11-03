import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PREVIEW_LABEL_ROTATED } from '@repo/contracts';
import { schema } from '@repo/db';
import { and, eq, gt, inArray, max } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, SignJWT } from 'jose';
import { createPrivateKey, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import type { Environment, PreviewJwks } from '../src/config/environment';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../src/modules/identity/password/breached-password.port';
import { SESSION_REDIS } from '../src/common/redis/redis.constants';
import type { Envelope } from '../src/modules/outbox/envelope';
import { BrokerListener, PlainBrokerTransport } from '../src/modules/preview/broker-listener';
import { PreviewRotationConsumer } from '../src/modules/preview/preview-rotation.consumer';
import {
  BROKER_TRANSPORT,
  callbackRateKey,
  GRANT_TTL_SECONDS,
  revokedLabelKey,
} from '../src/modules/preview/preview.constants';
import { verifyRoute } from '../src/modules/preview/route-signer';
import {
  CALLBACK_RATE_LIMIT,
  CALLBACK_REJECTION,
} from '../src/modules/preview/sandbox-callback.guard';
import { SANDBOX_CALLBACK_AUDIENCE } from '../src/modules/preview/sandbox-callback.token';
import {
  DAYTONA_TIMINGS,
  DEFAULT_DAYTONA_TIMINGS,
  SANDBOX_CALLBACK_MINTER,
  type SandboxCallbackMinter,
} from '../src/modules/sandbox/sandbox.constants';
import { SandboxService } from '../src/modules/sandbox/sandbox.service';
import { unsafe } from './support/csrf-client';
import { type FakeDaytona, startFakeDaytona } from './support/fake-daytona';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  FIXTURE_PASSWORD,
  http,
  type Principal,
  signUpAndIn,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

const DOMAIN = 'forge-preview.localhost';
const SECRET = 'e2e-broker-secret';
/**
 * The fixture's projects are created on the default template, `vite-react`, so this is that
 * template's declared `devPort` and not a number of the suite's own choosing: the route the broker
 * signs, the preview host it builds and — since 023 R9 — the one port a callback may name all come
 * from the catalogue. Spec 023 corrected the declaration from `5173` to the `3000` the template's
 * own `npm run dev` actually serves (research R4), and this constant follows it.
 */
const DEV_PORT = 3000;
const AUTHORIZE = '/api/v1/preview/authorize';

/** Before any import (as `sandbox-registration.e2e-spec.ts`): `AppModule` reads the environment on load. */
const FAKE = vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.BROKER_TRANSPORT = 'plain';
  process.env.BROKER_SHARED_SECRET = 'e2e-broker-secret';
  process.env.PREVIEW_DOMAIN = 'forge-preview.localhost';

  const port = 20_000 + Math.floor(Math.random() * 20_000);
  process.env.DAYTONA_API_URL = `http://127.0.0.1:${port}/api`;
  process.env.DAYTONA_API_KEY = 'dtn_fake_key';

  return { port };
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');
const LOCKED_BOOT_TIMEOUT_MS = 600_000;

class ScriptedBreachPort implements BreachedPasswordPort {
  isBreached(_password: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/**
 * Spec 017 US2 against the real API, Postgres, Redis and a fake Daytona, with the broker listener
 * bound on the `plain` transport as `pnpm dev` binds it. The gateway is not booted here: what it
 * does with a route or a grant is `apps/gateway/test/preview-proxy.e2e-spec.ts`'s proof. This suite
 * proves the half the gateway asks the API for — what the broker answers and what the exchange
 * mints — by calling the listener exactly as `broker-client.ts` does and reading the JWS claims.
 */
describe('Preview grant exchange (e2e)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres, Redis and a fake Daytona', () => {
    let app: INestApplication;
    let fake: FakeDaytona;
    let world: TwoTenantWorld;
    let transactions: TenantTransactionRunner;
    let jwks: PreviewJwks;
    let keys: ReturnType<typeof createLocalJWKSet>;
    let brokerPort: number;
    let suiteLock: { release: () => Promise<void> } | undefined;
    const extraEmails: string[] = [];

    /** `broker-client.ts`'s wire: the shared secret header, JSON in, JSON out. */
    async function broker(
      method: 'GET' | 'POST',
      route: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ): Promise<{ body: Record<string, unknown>; status: number }> {
      const response = await fetch(`http://127.0.0.1:${brokerPort}${route}`, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { 'content-type': 'application/json', 'x-broker-secret': SECRET, ...headers },
        method,
      });
      return { body: (await response.json()) as Record<string, unknown>, status: response.status };
    }

    const hostOf = (label: string) => `${label}-${DEV_PORT}.${DOMAIN}`;

    async function labelOf(orgId: string, projectId: string): Promise<string> {
      const [row] = await transactions.runInTenantTransaction(orgId, (tx) =>
        tx
          .select({ label: schema.projects.previewLabel })
          .from(schema.projects)
          .where(eq(schema.projects.id, projectId)),
      );
      return row!.label;
    }

    function authorize(cookie: string | undefined, label: string, returnHost = hostOf(label)) {
      return unsafe(http(app).post(AUTHORIZE), cookie === undefined ? [] : [cookie]).send({
        label,
        returnHost,
      });
    }

    /** The whole exchange up to the code: what the web page hands the browser to follow. */
    async function codeFor(cookie: string, label: string): Promise<string> {
      const response = await authorize(cookie, label).expect(200);
      const url = new URL((response.body as { url: string }).url);
      expect(url.host).toBe(hostOf(label));
      return url.searchParams.get('code') ?? expect.unreachable('no code in the preview URL');
    }

    /**
     * A member of alpha, admitted straight into `memberships` so the suite needs no mail lane, and
     * a viewer of its project: the preview is `private` by default, which FR-021 (as amended)
     * opens only to `project:read` holders — an org member alone is refused.
     */
    async function joinAlpha(label: string): Promise<Principal> {
      const member = await signUpAndIn(app, label);
      extraEmails.push(member.email);
      await transactions.runInTenantTransaction(world.alpha.orgId, async (tx) => {
        await tx.insert(schema.memberships).values({
          acceptedAt: new Date(),
          orgId: world.alpha.orgId,
          role: 'member',
          userId: member.userId,
        });
        await tx.insert(schema.projectGrants).values({
          orgId: world.alpha.orgId,
          projectId: world.alpha.projectId,
          role: 'viewer',
          userId: member.userId,
        });
      });
      return member;
    }

    function auditRows(orgId: string, action: string) {
      return transactions.runInTenantTransaction(orgId, (tx) =>
        tx
          .select({ actorId: schema.auditLog.actorId, metadata: schema.auditLog.metadata })
          .from(schema.auditLog)
          .where(and(eq(schema.auditLog.orgId, orgId), eq(schema.auditLog.action, action))),
      );
    }

    beforeAll(async () => {
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
      fake = await startFakeDaytona({ port: FAKE.port });

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(BREACHED_PASSWORD_PORT)
        .useClass(ScriptedBreachPort)
        .overrideProvider(DAYTONA_TIMINGS)
        .useValue({ ...DEFAULT_DAYTONA_TIMINGS, lookupTtlMs: 0 })
        // The schema refuses `BROKER_PORT=0`; a free port is the suite's business, not a deployment's.
        .overrideProvider(BROKER_TRANSPORT)
        .useValue(new PlainBrokerTransport({ port: 0, secret: SECRET }, 'local'))
        .compile();

      app = moduleRef.createNestApplication();
      configureApplication(app);
      await app.init();
      await app.get(BrokerListener).listen();
      brokerPort = app.get(BrokerListener).port!;

      const config = app.get<ConfigService<Environment, true>>(ConfigService);
      jwks = config.get('PREVIEW_PUBLIC_JWKS', { infer: true });
      keys = createLocalJWKSet(jwks);
      transactions = app.get(TenantTransactionRunner);
      world = await createTwoTenantWorld(app);

      // Alpha's project has a running sandbox; beta's has never run.
      const { orgId, projectId } = world.alpha;
      await transactions.runInTenantScope({ orgId, userId: null }, (tx) =>
        app.get(SandboxService).register(tx, { daytonaId: fake.sandboxId, orgId, projectId }),
      );
    }, LOCKED_BOOT_TIMEOUT_MS);

    afterAll(async () => {
      await destroyTwoTenantWorld(app, world);
      if (extraEmails.length > 0) {
        await app
          .get<ForgeDatabase>(APP_DATABASE)
          .delete(schema.users)
          .where(inArray(schema.users.email, extraEmails));
      }
      await app?.close();
      await fake?.close();
      await suiteLock?.release();
    });

    it('no-grant → redirect with no sandbox connection', async () => {
      const label = await labelOf(world.alpha.orgId, world.alpha.projectId);
      fake.requests.length = 0;

      // What the gateway learns before it decides: the route says `private`, so a visitor with
      // no grant is bounced to the authorise path — and nothing without a code mints a grant.
      const resolved = await broker('GET', `/broker/routes/${label}`);
      expect(resolved.status).toBe(200);
      const route = await verifyRoute(resolved.body.route as string, jwks);
      expect(route).toMatchObject({
        label,
        org: world.alpha.orgId,
        ports: [DEV_PORT],
        project: world.alpha.projectId,
        sandbox: fake.sandboxId,
        visibility: 'private',
      });

      for (const code of [
        '',
        `${'0'.repeat(32)}.${'0'.repeat(32)}`,
        randomBytes(8).toString('hex'),
      ]) {
        await expect(
          broker('POST', '/broker/grants', { code, host: hostOf(label) }),
        ).resolves.toEqual({
          body: {},
          status: 404,
        });
      }

      // The only thing the fake saw was the control-plane origin mint; nothing touched the sandbox.
      expect(fake.requests.map((request) => request.path)).toEqual([
        `/api/sandbox/${fake.sandboxId}/ports/${DEV_PORT}/signed-preview-url`,
      ]);
    });

    it('member redemption → grant cookie set host-only, no `Domain`', async () => {
      const { orgId, owner, projectId } = world.alpha;
      const label = await labelOf(orgId, projectId);
      const host = hostOf(label);

      const issuedBefore = (await auditRows(orgId, 'preview-grant.issued')).length;
      const code = await codeFor(owner.cookie, label);
      expect(code).toMatch(/^[0-9a-f]{32}\.[0-9a-f]{32}$/);

      const redeemed = await broker('POST', '/broker/grants', { code, host });
      expect(redeemed.status).toBe(200);
      const grant = redeemed.body.grant as string;

      // The grant names the bare preview host and nothing wider: the gateway sets it as
      // `__Host-preview_grant`, which by definition carries no `Domain`, and a grant whose `aud`
      // were a parent domain would verify on every sibling label.
      const { payload } = await jwtVerify(grant, keys, { algorithms: ['EdDSA'], audience: host });
      expect(payload.aud).toBe(host);
      expect(payload.aud).not.toMatch(/^\./);
      expect(payload.aud).not.toBe(DOMAIN);
      expect(payload.sub).toBe(owner.userId);
      expect(payload.exp! - payload.iat!).toBe(GRANT_TTL_SECONDS);
      expect(decodeProtectedHeader(grant)).toMatchObject({
        alg: 'EdDSA',
        kid: expect.any(String) as string,
      });

      const issued = await auditRows(orgId, 'preview-grant.issued');
      expect(issued).toHaveLength(issuedBefore + 1);
      expect(issued).toContainEqual({ actorId: owner.userId, metadata: { host } });
    });

    it('second redemption of the same code refused', async () => {
      const { orgId, owner, projectId } = world.alpha;
      const label = await labelOf(orgId, projectId);
      const host = hostOf(label);
      const code = await codeFor(owner.cookie, label);

      expect((await broker('POST', '/broker/grants', { code, host })).status).toBe(200);
      await expect(broker('POST', '/broker/grants', { code, host })).resolves.toEqual({
        body: {},
        status: 404,
      });
    });

    it('non-member refused identically to unknown label', async () => {
      const label = await labelOf(world.alpha.orgId, world.alpha.projectId);
      const unknown = randomBytes(16).toString('hex');
      const strip = ({ requestId: _, ...rest }: Record<string, unknown>) => rest;

      const asBetaOwner = await authorize(world.beta.owner.cookie, label).expect(404);
      const asOutsider = await authorize(world.outsider.cookie, label).expect(404);
      const asNobodyLabel = await authorize(world.alpha.owner.cookie, unknown).expect(404);

      expect(strip(asBetaOwner.body as Record<string, unknown>)).toEqual(
        strip(asNobodyLabel.body as Record<string, unknown>),
      );
      expect(strip(asOutsider.body as Record<string, unknown>)).toEqual(
        strip(asNobodyLabel.body as Record<string, unknown>),
      );
      expect(await auditRows(world.alpha.orgId, 'preview-grant.refused')).toEqual(
        expect.arrayContaining([
          { actorId: world.beta.owner.userId, metadata: { because: 'not-a-member' } },
          { actorId: world.outsider.userId, metadata: { because: 'not-a-member' } },
        ]),
      );
    });

    it('signed-out visitor sent to sign-in then continues', async () => {
      const { orgId, owner, projectId } = world.alpha;
      const label = await labelOf(orgId, projectId);

      // No session: the authorise path is refused before the label is looked at, which is what
      // sends the page to `routes.signIn` with a return parameter (T031).
      const refused = await authorize(undefined, label).expect(401);
      expect(refused.body).toMatchObject({ status: 401 });

      // Signed in, the same `{ label, returnHost }` completes the same exchange.
      const code = await codeFor(owner.cookie, label);
      const redeemed = await broker('POST', '/broker/grants', { code, host: hostOf(label) });
      expect(redeemed.status).toBe(200);
    });

    it('grant for one label refused at a different label', async () => {
      const { orgId, owner, projectId } = world.alpha;
      const label = await labelOf(orgId, projectId);
      const other = randomBytes(16).toString('hex');

      // A code carries its return host; presenting it from another label's host is refused, and
      // that refusal spends it — the code is not left for the right host to redeem afterwards.
      const code = await codeFor(owner.cookie, label);
      await expect(
        broker('POST', '/broker/grants', { code, host: hostOf(other) }),
      ).resolves.toEqual({ body: {}, status: 404 });
      await expect(
        broker('POST', '/broker/grants', { code, host: hostOf(label) }),
      ).resolves.toEqual({ body: {}, status: 404 });

      // A grant already minted is bound by `aud` to its own host, which is how the gateway's local
      // verification refuses it at any other label without a broker call.
      const grant = (
        await broker('POST', '/broker/grants', {
          code: await codeFor(owner.cookie, label),
          host: hostOf(label),
        })
      ).body.grant as string;
      await expect(
        jwtVerify(grant, keys, { algorithms: ['EdDSA'], audience: hostOf(other) }),
      ).rejects.toMatchObject({ code: 'ERR_JWT_CLAIM_VALIDATION_FAILED' });

      // The authorise path never issues for a return host that is not the label's own host.
      await authorize(owner.cookie, label, hostOf(other)).expect(404);
    });

    it("removed member's existing grant refused", async () => {
      const { orgId, owner, projectId } = world.alpha;
      const label = await labelOf(orgId, projectId);
      const member = await joinAlpha('member');

      const code = await codeFor(member.cookie, label);
      expect((await broker('POST', '/broker/grants', { code, host: hostOf(label) })).status).toBe(
        200,
      );

      await unsafe(http(app).delete(`/api/v1/orgs/${orgId}/members/${member.userId}`), [
        owner.cookie,
      ]).expect(200);

      // Research R6: a grant already in a browser lives out its ten minutes; what removal ends
      // at once is every way of getting another — the session is revoked, and a fresh sign-in
      // is refused as a non-member.
      await authorize(member.cookie, label).expect(401);
      const again = await signUpAndInAs(member);
      await authorize(again, label).expect(404);
      expect(await auditRows(orgId, 'preview-grant.refused')).toEqual(
        expect.arrayContaining([{ actorId: member.userId, metadata: { because: 'not-a-member' } }]),
      );
    });

    it('public preview served directly with `noindex` and no grant required (SC-004)', async () => {
      const { orgId, projectId } = world.alpha;
      const label = await labelOf(orgId, projectId);
      await transactions.runInTenantTransaction(orgId, (tx) =>
        tx
          .update(schema.projects)
          .set({ previewVisibility: 'public' })
          .where(eq(schema.projects.id, projectId)),
      );

      try {
        // The route is what tells the gateway to serve without a grant and stamp `noindex`
        // (`preview-proxy.e2e-spec.ts` asserts the header); no broker call other than this one is
        // part of a public visit.
        const resolved = await broker('GET', `/broker/routes/${label}`);
        expect(resolved.status).toBe(200);
        await expect(verifyRoute(resolved.body.route as string, jwks)).resolves.toMatchObject({
          label,
          visibility: 'public',
        });
      } finally {
        await transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .update(schema.projects)
            .set({ previewVisibility: 'private' })
            .where(eq(schema.projects.id, projectId)),
        );
      }
    });

    /**
     * US3 (T039): what the broker answers before and after an owner rotates or narrows. Which
     * request the gateway lets through on each answer — and that a socket already open on the
     * old label drains rather than being torn down — is `apps/gateway/test/preview-proxy.e2e-spec.ts`
     * (T043); here only the route side of each row is asserted.
     */
    describe('rotation and visibility (US3)', () => {
      const previewPath = () =>
        `/api/v1/orgs/${world.alpha.orgId}/projects/${world.alpha.projectId}/preview`;

      /** A member's grant on the current label, as the gateway would hold it in its cookie. */
      async function grantFor(cookie: string, label: string): Promise<string> {
        const code = await codeFor(cookie, label);
        const redeemed = await broker('POST', '/broker/grants', { code, host: hostOf(label) });
        expect(redeemed.status).toBe(200);
        return redeemed.body.grant as string;
      }

      /**
       * No relay runs under `RUN_PROFILES=api`, so the outbox row is asserted and the consumer's
       * `handle` → `effect` pair is driven by hand with the row as its envelope, the way the
       * worker would after the relay published it.
       */
      async function consumeRotation(previousLabel: string): Promise<void> {
        const rows = await app
          .get<ForgeDatabase>(APP_DATABASE)
          .select()
          .from(schema.outbox)
          .where(
            and(
              eq(schema.outbox.type, 'project.preview-label.rotated'),
              eq(schema.outbox.aggregateId, world.alpha.projectId),
            ),
          );
        const row = rows.find((candidate) => candidate.payload.previousLabel === previousLabel);
        expect(row).toBeDefined();
        expect(row!.payload).toEqual({
          orgId: world.alpha.orgId,
          previousLabel,
          projectId: world.alpha.projectId,
        });
        const event = {
          aggregate: row!.aggregate,
          aggregateId: row!.aggregateId,
          eventId: row!.id,
          occurredAt: row!.occurredAt.toISOString(),
          orgId: row!.originOrgId,
          payload: row!.payload,
          traceId: row!.traceId,
          type: 'project.preview-label.rotated',
        } as Envelope<'project.preview-label.rotated'>;
        const consumer = app.get(PreviewRotationConsumer);
        await consumer.effect(event, await consumer.handle(event));
        expect(await app.get<Redis>(SESSION_REDIS).exists(revokedLabelKey(previousLabel))).toBe(1);
      }

      it('rotation → old host refused, new host serves the same sandbox on the same ports', async () => {
        const { orgId, owner, projectId } = world.alpha;
        const previous = await labelOf(orgId, projectId);
        const before = await verifyRoute(
          (await broker('GET', `/broker/routes/${previous}`)).body.route as string,
          jwks,
        );

        const rotated = await unsafe(http(app).post(`${previewPath()}/rotate`), [owner.cookie])
          .send()
          .expect(200);
        const label = await labelOf(orgId, projectId);
        expect(label).not.toBe(previous);
        expect(rotated.body).toEqual({
          port: DEV_PORT,
          status: PREVIEW_LABEL_ROTATED,
          url: `https://${hostOf(label)}`,
        });

        // The old label is now unknown: the same `404 {}` a label that never existed gets.
        await expect(broker('GET', `/broker/routes/${previous}`)).resolves.toEqual({
          body: {},
          status: 404,
        });
        // The new one names the same sandbox, port and visibility; only the label differs.
        const resolved = await broker('GET', `/broker/routes/${label}`);
        expect(resolved.status).toBe(200);
        const after = await verifyRoute(resolved.body.route as string, jwks);
        expect(after).toMatchObject({
          label,
          ports: before.ports,
          sandbox: before.sandbox,
          visibility: before.visibility,
        });
        expect(after.ports).toEqual([DEV_PORT]);

        expect(await auditRows(orgId, 'preview.label-rotated')).toContainEqual({
          actorId: owner.userId,
          metadata: {},
        });
        await consumeRotation(previous);
      });

      it('grants against the old label refused', async () => {
        const { orgId, owner, projectId } = world.alpha;
        const previous = await labelOf(orgId, projectId);
        const member = await joinAlpha('rotated-member');
        // In flight at rotation time: a grant already in a browser and a code not yet redeemed.
        const grant = await grantFor(member.cookie, previous);
        const pending = await codeFor(member.cookie, previous);

        await unsafe(http(app).post(`${previewPath()}/rotate`), [owner.cookie])
          .send()
          .expect(200);
        const label = await labelOf(orgId, projectId);
        await consumeRotation(previous);

        // The pending code is refused by the `pv:revoked:` marker, and spent by that refusal.
        await expect(
          broker('POST', '/broker/grants', { code: pending, host: hostOf(previous) }),
        ).resolves.toEqual({ body: {}, status: 404 });
        expect(await auditRows(orgId, 'preview-grant.refused')).toContainEqual({
          actorId: member.userId,
          metadata: { because: 'label-revoked', host: hostOf(previous) },
        });
        // No new code is issued for the retired label, and the old grant's `aud` is not the new host.
        await authorize(member.cookie, previous).expect(404);
        await expect(
          jwtVerify(grant, keys, { algorithms: ['EdDSA'], audience: hostOf(label) }),
        ).rejects.toMatchObject({ code: 'ERR_JWT_CLAIM_VALIDATION_FAILED' });
        // The exchange against the new label is open to the same member as before.
        expect(await grantFor(member.cookie, label)).toEqual(expect.any(String));
      });

      // A socket already open on the old label at rotation time drains rather than being torn
      // down: owned by `apps/gateway/test/preview-proxy.e2e-spec.ts` (T043). The broker's part
      // is what the first `it` above proves — the old label answers `404` from the moment the
      // rotation commits, and nothing here revokes a route the gateway already holds.

      it('visibility narrowed public → private requires the grant exchange on the next request', async () => {
        const { orgId, owner, projectId } = world.alpha;
        const label = await labelOf(orgId, projectId);
        const visibilityOf = async () => {
          const resolved = await broker('GET', `/broker/routes/${label}`);
          return (await verifyRoute(resolved.body.route as string, jwks)).visibility;
        };

        try {
          const widened = await unsafe(http(app).put(`${previewPath()}/visibility`), [owner.cookie])
            .send({ visibility: 'public' })
            .expect(200);
          expect(widened.body).toMatchObject({ port: DEV_PORT, visibility: 'public' });
          expect(await visibilityOf()).toBe('public');

          const narrowed = await unsafe(http(app).put(`${previewPath()}/visibility`), [
            owner.cookie,
          ])
            .send({ visibility: 'private' })
            .expect(200);
          expect(narrowed.body).toMatchObject({ visibility: 'private' });
          // The very next route the gateway fetches says `private`, which is what makes it bounce
          // a grant-less visitor to the authorise path; a route it cached while `public` lasts at
          // most its own TTL (`preview-proxy.e2e-spec.ts` covers that side).
          expect(await visibilityOf()).toBe('private');

          const changes = await auditRows(orgId, 'preview.visibility-changed');
          expect(changes).toContainEqual({
            actorId: owner.userId,
            metadata: { from: 'private', to: 'public' },
          });
          expect(changes).toContainEqual({
            actorId: owner.userId,
            metadata: { from: 'public', to: 'private' },
          });
        } finally {
          await transactions.runInTenantTransaction(orgId, (tx) =>
            tx
              .update(schema.projects)
              .set({ previewVisibility: 'private' })
              .where(eq(schema.projects.id, projectId)),
          );
        }
      });
    });

    /**
     * US4 (T044): a cold preview's resolve is the wake trigger, gated by entitlement. No relay
     * runs under `RUN_PROFILES=api`, so the `sandbox.op.requested` rows stay unpublished and are
     * read straight from the outbox; the row is put back to `active` by hand afterwards.
     */
    describe('waking (US4)', () => {
      let sandboxId: string;

      async function setSandbox(values: Partial<typeof schema.sandboxes.$inferInsert>) {
        await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx
            .update(schema.sandboxes)
            .set(values)
            .where(
              and(
                eq(schema.sandboxes.orgId, world.alpha.orgId),
                eq(schema.sandboxes.projectId, world.alpha.projectId),
              ),
            ),
        );
      }

      async function hibernate(): Promise<void> {
        const now = new Date();
        await setSandbox({
          hibernatedAt: now,
          state: 'hibernated',
          stateEnteredAt: now,
          transition: null,
          transitionSince: null,
        });
      }

      async function restore(): Promise<void> {
        await setSandbox({
          hibernatedAt: null,
          state: 'active',
          stateEnteredAt: new Date(),
          transition: null,
          transitionSince: null,
        });
      }

      /**
       * The resume ops enqueued since `after` (a `seq`, the relay's own order). `forge_app` may
       * not delete from `outbox`, so each test takes its own high-water mark instead.
       */
      async function resumeOps(after = 0) {
        const rows = await app
          .get<ForgeDatabase>(APP_DATABASE)
          .select({ payload: schema.outbox.payload, seq: schema.outbox.seq })
          .from(schema.outbox)
          .where(
            and(
              eq(schema.outbox.type, 'sandbox.op.requested'),
              eq(schema.outbox.aggregateId, sandboxId),
              gt(schema.outbox.seq, after),
            ),
          )
          .orderBy(schema.outbox.seq);
        return rows.map((row) => row.payload);
      }

      async function mark(): Promise<number> {
        const [row] = await app
          .get<ForgeDatabase>(APP_DATABASE)
          .select({ seq: max(schema.outbox.seq) })
          .from(schema.outbox);
        return row?.seq ?? 0;
      }

      /** The two headers `broker-client.ts` forwards from an entitled visitor. */
      async function entitledCaller(label: string): Promise<Record<string, string>> {
        const code = await codeFor(world.alpha.owner.cookie, label);
        const redeemed = await broker('POST', '/broker/grants', { code, host: hostOf(label) });
        expect(redeemed.status).toBe(200);
        return {
          'x-preview-grant': redeemed.body.grant as string,
          'x-preview-host': hostOf(label),
        };
      }

      beforeAll(async () => {
        const [row] = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx
            .select({ id: schema.sandboxes.id })
            .from(schema.sandboxes)
            .where(eq(schema.sandboxes.projectId, world.alpha.projectId)),
        );
        sandboxId = row!.id;
      });

      it("a hibernated, entitled preview's resolve enqueues one resume even under two concurrent requests", async () => {
        const label = await labelOf(world.alpha.orgId, world.alpha.projectId);
        const caller = await entitledCaller(label);
        const since = await mark();
        await hibernate();
        try {
          const answers = await Promise.all([
            broker('GET', `/broker/routes/${label}`, undefined, caller),
            broker('GET', `/broker/routes/${label}`, undefined, caller),
          ]);
          expect(answers).toEqual([
            { body: { waking: true }, status: 202 },
            { body: { waking: true }, status: 202 },
          ]);
          expect(await resumeOps(since)).toEqual([
            {
              leaseEpoch: 0,
              op: 'resume',
              operationId: `preview/${label}`,
              orgId: world.alpha.orgId,
              sandboxId,
            },
          ]);
          // A resolve after the first committed is answered `waking` by the row's transition alone.
          await expect(
            broker('GET', `/broker/routes/${label}`, undefined, caller),
          ).resolves.toEqual({ body: { waking: true }, status: 202 });
          expect(await resumeOps(since)).toHaveLength(1);
        } finally {
          await restore();
        }
      });

      it('an unroutable state (archived) is refused with no resume attempted', async () => {
        const { orgId, projectId } = world.alpha;
        const label = await labelOf(orgId, projectId);
        const caller = await entitledCaller(label);
        const since = await mark();
        await hibernate();
        // `sandboxes.state = 'archived'` is refused by `sandboxes_not_archived_check` (spec 014
        // FR-013): what "archived" is on this schema is the project's `deleted_at`, which makes
        // the label unknown to the broker before the sandbox row is even read.
        await transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .update(schema.projects)
            .set({ deletedAt: new Date() })
            .where(eq(schema.projects.id, projectId)),
        );
        try {
          await expect(
            broker('GET', `/broker/routes/${label}`, undefined, caller),
          ).resolves.toEqual({ body: {}, status: 404 });
          expect(await resumeOps(since)).toEqual([]);
        } finally {
          await transactions.runInTenantTransaction(orgId, (tx) =>
            tx
              .update(schema.projects)
              .set({ deletedAt: null })
              .where(eq(schema.projects.id, projectId)),
          );
          await restore();
        }
      });

      it("the preview read answers each start-up stage from the row and the dev server's report, waking nothing", async () => {
        const { orgId, owner, projectId } = world.alpha;
        const read = async () =>
          (
            await http(app)
              .get(`/api/v1/orgs/${orgId}/projects/${projectId}/preview`)
              .set('Cookie', owner.cookie)
              .expect(200)
          ).body as { stage: string };
        const reported = (state: string) => ({
          ports: { [DEV_PORT]: { observedAt: new Date().toISOString(), state } },
        });
        const since = await mark();
        try {
          await setSandbox({ ports: {}, transition: 'creating', transitionSince: new Date() });
          expect((await read()).stage).toBe('creating');
          await setSandbox({ transition: null, transitionSince: null });
          expect((await read()).stage).toBe('starting');
          await setSandbox(reported('starting'));
          expect((await read()).stage).toBe('starting');
          await setSandbox(reported('failed'));
          expect((await read()).stage).toBe('failed');
          await setSandbox(reported('listening'));
          expect(await read()).toMatchObject({
            port: DEV_PORT,
            stage: 'ready',
            url: `https://${hostOf(await labelOf(orgId, projectId))}`,
          });
          await hibernate();
          expect((await read()).stage).toBe('asleep');
          // Beta's project has never had a sandbox; its owner reads it through its own org.
          const beta = world.beta;
          const betaRead = await http(app)
            .get(`/api/v1/orgs/${beta.orgId}/projects/${beta.projectId}/preview`)
            .set('Cookie', beta.owner.cookie)
            .expect(200);
          expect(betaRead.body).toMatchObject({ port: DEV_PORT, stage: 'no-sandbox' });
          // A read is never the wake trigger the broker's resolve is.
          expect(await resumeOps(since)).toEqual([]);
        } finally {
          await setSandbox({ ports: {} });
          await restore();
        }
      });

      it('an unauthorised visitor against a hibernated label triggers no resume', async () => {
        const label = await labelOf(world.alpha.orgId, world.alpha.projectId);
        const since = await mark();
        await hibernate();
        try {
          // No grant, and a grant that is not a grant: neither wakes it.
          await expect(broker('GET', `/broker/routes/${label}`)).resolves.toEqual({
            body: {},
            status: 401,
          });
          await expect(
            broker('GET', `/broker/routes/${label}`, undefined, {
              'x-preview-grant': 'not-a-jws',
              'x-preview-host': hostOf(label),
            }),
          ).resolves.toEqual({ body: {}, status: 401 });
          expect(await resumeOps(since)).toEqual([]);
          const row = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
            tx.query.sandboxes.findFirst({ where: eq(schema.sandboxes.id, sandboxId) }),
          );
          expect(row).toMatchObject({ state: 'hibernated', transition: null });
        } finally {
          await restore();
        }
      });
    });

    /**
     * US5 (T051): the callback broker — the one route a sandbox may reach, admitted by the token
     * the ops consumer mints, never by a session. The body cannot name a project; what a call is
     * recorded against is the token's claims, re-checked against the `sandboxes` row on every call.
     */
    describe('sandbox callbacks (US5)', () => {
      const CALLBACKS = '/api/v1/internal/sandbox-callbacks';
      const BETA_SANDBOX = 'sandbox-fake-beta';
      let mint: SandboxCallbackMinter;

      const claimsFor = (tenant: 'alpha' | 'beta') => ({
        leaseEpoch: 0,
        org: world[tenant].orgId,
        project: world[tenant].projectId,
        sandbox: tenant === 'alpha' ? fake.sandboxId : BETA_SANDBOX,
      });

      /** No `unsafe()`: the path is CSRF-exempt, and a sandbox sends no cookie and no `Origin`. */
      const callback = (token: string, body: object) =>
        http(app).post(CALLBACKS).set('Authorization', `Bearer ${token}`).send(body);

      const status = (port: number) => ({ action: 'preview.status', port, state: 'listening' });

      function portsOf(tenant: 'alpha' | 'beta') {
        return transactions.runInTenantTransaction(world[tenant].orgId, async (tx) => {
          const [row] = await tx
            .select({ ports: schema.sandboxes.ports })
            .from(schema.sandboxes)
            .where(eq(schema.sandboxes.projectId, world[tenant].projectId));
          return row!.ports as Record<string, { observedAt: string; state: string }>;
        });
      }

      const refusals = (orgId: string) => auditRows(orgId, 'sandbox-callback.refused');
      const strip = ({ requestId: _, ...rest }: Record<string, unknown>) => rest;

      beforeAll(async () => {
        mint = app.get<SandboxCallbackMinter>(SANDBOX_CALLBACK_MINTER);
        // Beta gets a sandbox of its own: the "another project" a rate limit must not degrade.
        fake.addSandbox(BETA_SANDBOX);
        const { orgId, projectId } = world.beta;
        await transactions.runInTenantScope({ orgId, userId: null }, (tx) =>
          app.get(SandboxService).register(tx, { daytonaId: BETA_SANDBOX, orgId, projectId }),
        );
      });

      beforeEach(async () => {
        await app
          .get<Redis>(SESSION_REDIS)
          .del(callbackRateKey(fake.sandboxId), callbackRateKey(BETA_SANDBOX));
      });

      it("a permitted action succeeds and is recorded against the calling sandbox's project", async () => {
        const before = (await refusals(world.alpha.orgId)).length;
        await callback(await mint(claimsFor('alpha')), status(DEV_PORT)).expect(204);

        expect(await portsOf('alpha')).toMatchObject({
          [DEV_PORT]: { observedAt: expect.any(String) as string, state: 'listening' },
        });
        expect(await portsOf('beta')).toEqual({});
        expect(await refusals(world.alpha.orgId)).toHaveLength(before);
      });

      it('an unpermitted action is refused and audited', async () => {
        const refused = await callback(await mint(claimsFor('alpha')), {
          action: 'preview.stop',
          port: DEV_PORT,
        }).expect(403);
        expect(refused.body).toMatchObject({ detail: CALLBACK_REJECTION, status: 403 });
        expect(await refusals(world.alpha.orgId)).toContainEqual({
          actorId: null,
          metadata: { because: 'unknown-action', sandbox: fake.sandboxId },
        });
      });

      /**
       * 023 US2, FR-015: the declared-port write, end to end and through the real jsonb merge.
       * A key the map already holds is what proves `||` rather than a replacement — 010 created
       * this column, 017 gave it a writer, and this feature is the first thing that fills it.
       */
      it('a declared-port report merges one entry and leaves every other key as it was', async () => {
        const STALE = { observedAt: '2026-09-17T10:31:02.441Z', state: 'failed' };
        await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx
            .update(schema.sandboxes)
            .set({ ports: { 9999: STALE } })
            .where(eq(schema.sandboxes.projectId, world.alpha.projectId)),
        );

        await callback(await mint(claimsFor('alpha')), status(DEV_PORT)).expect(204);

        const ports = await portsOf('alpha');
        expect(Object.keys(ports).sort()).toEqual([String(DEV_PORT), '9999'].sort());
        // The other key is untouched — same state, same timestamp, not re-observed.
        expect(ports['9999']).toEqual(STALE);
        // The declared port's entry is the broker's clock, not the sandbox's assertion.
        expect(ports[String(DEV_PORT)]).toEqual({
          observedAt: expect.any(String) as string,
          state: 'listening',
        });
        expect(Date.parse(ports[String(DEV_PORT)]!.observedAt)).toBeGreaterThan(
          Date.parse(STALE.observedAt),
        );
      });

      /**
       * 023 R9 / FR-016: the second refusal on the path 017 built. It must be indistinguishable on
       * the wire from the action refusal — a sandbox probing for what the platform will accept
       * learns nothing from the response, only the audit log does.
       */
      it('a port the project’s template did not declare is refused exactly as an unknown action is', async () => {
        const UNDECLARED = DEV_PORT + 1;
        const before = await portsOf('alpha');

        const undeclared = await callback(
          await mint(claimsFor('alpha')),
          status(UNDECLARED),
        ).expect(403);
        const unknown = await callback(await mint(claimsFor('alpha')), {
          action: 'preview.stop',
          port: DEV_PORT,
        }).expect(403);

        expect(undeclared.body).toMatchObject({ detail: CALLBACK_REJECTION, status: 403 });
        expect(strip(undeclared.body as Record<string, unknown>)).toEqual(
          strip(unknown.body as Record<string, unknown>),
        );
        expect(JSON.stringify(undeclared.body)).not.toMatch(
          new RegExp(`because|declar|${UNDECLARED}`, 'i'),
        );

        expect(await refusals(world.alpha.orgId)).toContainEqual({
          actorId: null,
          metadata: { because: 'undeclared-port', sandbox: fake.sandboxId },
        });
        // FR-016: nothing changed. The undeclared key was never a key.
        expect(await portsOf('alpha')).toEqual(before);
      });

      it('a foreign project id is refused and audited', async () => {
        // Alpha's sandbox holding a token whose `project` claim is beta's: no row in alpha's org
        // carries that project, so the per-call re-check refuses it, and beta's ports stay untouched.
        const foreign = await mint({ ...claimsFor('alpha'), project: world.beta.projectId });
        const refused = await callback(foreign, status(DEV_PORT)).expect(403);
        expect(refused.body).toMatchObject({ detail: CALLBACK_REJECTION, status: 403 });
        expect(await refusals(world.alpha.orgId)).toContainEqual({
          actorId: null,
          metadata: { because: 'sandbox-mismatch', sandbox: fake.sandboxId },
        });
        expect(await portsOf('beta')).toEqual({});
      });

      it('an expired or revoked credential is refused with no detail beyond expiry', async () => {
        const config = app.get<ConfigService<Environment, true>>(ConfigService);
        const signingKey: string = config.get('PREVIEW_SIGNING_KEY', { infer: true });
        const now = Math.floor(Date.now() / 1000);
        const expired = await new SignJWT(claimsFor('alpha'))
          .setProtectedHeader({
            alg: 'EdDSA',
            kid: config.get('PREVIEW_SIGNING_KEY_ID', { infer: true }),
          })
          .setAudience(SANDBOX_CALLBACK_AUDIENCE)
          .setIssuedAt(now - 7200)
          .setExpirationTime(now - 3600)
          .sign(
            createPrivateKey({
              format: 'der',
              key: Buffer.from(signingKey, 'base64'),
              type: 'pkcs8',
            }),
          );
        // Revoked: the row's `daytonaId` is no longer the one the token names (a re-registration).
        const revoked = await mint({ ...claimsFor('alpha'), sandbox: 'sandbox-fake-retired' });

        const asExpired = await callback(expired, status(DEV_PORT)).expect(403);
        const asRevoked = await callback(revoked, status(DEV_PORT)).expect(403);
        for (const body of [asExpired.body, asRevoked.body] as Record<string, unknown>[]) {
          expect(body).toMatchObject({ detail: CALLBACK_REJECTION, status: 403 });
          expect(JSON.stringify(body)).not.toMatch(/expir|because|mismatch|retired/i);
        }
        expect(strip(asExpired.body as Record<string, unknown>)).toEqual(
          strip(asRevoked.body as Record<string, unknown>),
        );
        expect(await refusals(world.alpha.orgId)).toContainEqual({
          actorId: null,
          metadata: { because: 'sandbox-mismatch', sandbox: 'sandbox-fake-retired' },
        });
      });

      it("a sandbox exceeding its rate limit is refused without degrading another project's calls (SC-010, SC-011)", async () => {
        const alpha = await mint(claimsFor('alpha'));
        const beta = await mint(claimsFor('beta'));

        for (let call = 0; call < CALLBACK_RATE_LIMIT; call += 1) {
          await callback(alpha, status(DEV_PORT)).expect(204);
        }
        const limited = await callback(alpha, status(DEV_PORT)).expect(429);
        expect(limited.headers['retry-after']).toBeDefined();

        await callback(beta, status(DEV_PORT)).expect(204);
        expect(await portsOf('beta')).toMatchObject({ [DEV_PORT]: { state: 'listening' } });
      });
    });

    /** The removed member signing in again on the same account: the fixture's login, reused. */
    async function signUpAndInAs(principal: Principal): Promise<string> {
      const response = await unsafe(http(app).post('/api/v1/auth/login'))
        .set('X-Forwarded-For', `198.35.${Math.floor(Math.random() * 256)}.1`)
        .send({ email: principal.email, password: FIXTURE_PASSWORD })
        .expect(200);
      const header = (response.headers as unknown as Record<string, string[]>)['set-cookie']![0]!;
      return header.split(';')[0]!;
    }
  });
});
