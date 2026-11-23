import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  cloudflareOfferSchema,
  connectionListSchema,
  connectionSchema,
  operationSchema,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { and, eq, gte, inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import {
  CLOUDFLARE_TOKEN,
  type CloudflareFixture,
  NEON_KEY,
  NETLIFY_TOKEN,
  type NetlifyFixture,
  type ProviderFixture,
  RESEND_KEY,
  RESEND_SENDING_KEY,
  startCloudflareFixture,
  startNeonFixture,
  startNetlifyFixture,
  startResendFixture,
  startSupabaseFixture,
  SUPABASE_CLIENT_SECRET,
  type SupabaseFixture,
} from './fixtures/provider-fixtures';
import { installNeonBranches, NEON_PROJECT } from './fixtures/neon-branches';
import {
  installResendState,
  RESEND_PENDING_DOMAIN,
  RESEND_PLATFORM_DOMAIN,
  RESEND_VERIFIED_DOMAIN,
} from './fixtures/resend-state';
import { unsafe } from './support/csrf-client';
import { type FakeDaytona, startFakeDaytona } from './support/fake-daytona';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import { MemoryObjectStore } from '../src/common/object-store/memory-object-store';
import { upload } from '../src/modules/deploy/artifact';
import { ARTIFACT_STORE } from '../src/modules/deploy/deploy.constants';
import { publishTitle } from '../src/modules/connectors/netlify-publish.handler';
import { stepUp } from './support/step-up';
import { SESSION_REDIS } from '../src/common/redis/redis.constants';
import { ownershipToken } from '../src/modules/deploy/domains/ownership-token';
import { sessionKey } from '../src/modules/identity/services/session.service';
import {
  ConnectorHealthConsumer,
  VERIFIED_WITHIN_MS,
} from '../src/modules/connectors/connector-health.consumer';
import { SandboxOpsConsumer } from '../src/modules/sandbox/sandbox-ops.consumer';
import {
  PREVIEW_ENV_KEYS,
  PREVIEW_ENV_SOURCE,
  type PreviewEnvSource,
  SANDBOX_CALLBACK_ENV_PATH,
  SANDBOX_PROJECT_ENV_PATH,
} from '../src/modules/sandbox/sandbox.constants';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  http,
  signUpAndIn,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

/**
 * Before any import: `AppModule` reads the environment on load, so each provider's base URL is the
 * fixture's, settled here on a port chosen now. `trace` so the SC-002 scan sees the most the
 * process could write; `events` so this process drains `connector.ops` (a removal) itself.
 */
const PORTS = vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  process.env.LOG_LEVEL = 'trace';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.THROTTLE_LIMIT = '100000';
  process.env.RUN_PROFILES = 'api,events';

  const base = 20_000 + Math.floor(Math.random() * 20_000);
  const ports = {
    cloudflare: base + 4,
    neon: base + 1,
    netlify: base,
    resend: base + 3,
    supabase: base + 2,
  };
  const url = (port: number) => `http://127.0.0.1:${String(port)}`;

  process.env.NETLIFY_API_URL = url(ports.netlify);
  process.env.NEON_API_URL = url(ports.neon);
  process.env.SUPABASE_API_URL = url(ports.supabase);
  process.env.CONNECTOR_RESEND_API_URL = url(ports.resend);
  process.env.CLOUDFLARE_API_URL = url(ports.cloudflare);
  // US2 reads a domain's records, whose CNAME value is the edge target — a member of the
  // all-or-none `CLOUDFLARE_*` group. The platform's own calls carry this token, which the tenant
  // fixture answers as revoked; the domains below are seeded with no check due.
  process.env.CLOUDFLARE_API_TOKEN = 'cf_platform_token_not_the_tenants';
  process.env.CLOUDFLARE_ZONE_ID = 'platform-zone';
  process.env.CUSTOM_HOSTNAME_TARGET = 'customers.forge-edge.test';
  // The provider-fixtures module's pair; hoisted code runs before imports, so it is restated.
  process.env.SUPABASE_OAUTH_CLIENT_ID = 'fixture-supabase-client';
  process.env.SUPABASE_OAUTH_CLIENT_SECRET = 'fixture-supabase-client-secret-0123456789';
  // US3: the sandbox delivery writes its files into a fake Daytona (quickstart § 6, SC-008).
  process.env.DAYTONA_API_URL = `http://127.0.0.1:${String(base + 5)}/api`;
  process.env.DAYTONA_API_KEY = 'dtn_fake_key';

  return { ...ports, daytona: base + 5 };
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const PASTED = [
  { provider: 'netlify', token: NETLIFY_TOKEN, ref: 'acme-team' },
  { provider: 'neon', token: NEON_KEY, ref: 'org-neon-1' },
  { provider: 'resend', token: RESEND_KEY, ref: 'dom-1' },
  { provider: 'cloudflare', token: CLOUDFLARE_TOKEN, ref: 'cf-acct-1' },
] as const;

async function until(predicate: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

/**
 * Spec 030 quickstart § 3 (US1, SC-002, FR-024): every provider connects through HTTP against its
 * `node:http` fixture, a short or refused credential is a 422 naming why, a replayed Supabase
 * state is refused, removal needs step-up — and no credential appears in any response, log line,
 * audit row or outbox event of the run.
 */
describe('Connectors 030 (e2e)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres, Redis and the provider fixtures', () => {
    let app: INestApplication;
    let database: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    let world: TwoTenantWorld;
    let netlify: NetlifyFixture;
    /** US4: the releases a publish reads (027's artifacts bucket, in memory). */
    const artifacts = new MemoryObjectStore();
    /** Accounts a story signed up beyond the two-tenant world, removed after it. */
    const extraUsers: string[] = [];
    let neon: ProviderFixture;
    let resend: ProviderFixture;
    let cloudflare: CloudflareFixture;
    let supabase: SupabaseFixture;
    let daytona: FakeDaytona;
    let suiteLock: { release: () => Promise<void> } | undefined;
    const started = new Date();
    const bodies: unknown[] = [];
    /** Every provider-issued credential of the run (Supabase tokens, Resend sending keys). */
    const issued: string[] = [];
    /** Exactly what US1's one Supabase connect issued: one access and one refresh token. */
    const connectIssued: string[] = [];
    const stdout: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);

    const connectors = (orgId: string) => `/api/v1/orgs/${orgId}/connectors`;
    const fixtureOf = (provider: (typeof PASTED)[number]['provider']) =>
      ({ cloudflare, neon, netlify, resend })[provider];

    function owner() {
      return world.alpha.owner.cookie;
    }

    function paste(provider: string, token: string, cookie = owner(), orgId = world.alpha.orgId) {
      return unsafe(http(app).post(`${connectors(orgId)}/${provider}/token`), [cookie]).send({
        token,
      });
    }

    function connectionsOf(orgId: string) {
      return transactions.runInTenantTransaction(orgId, (tx) =>
        tx.select().from(schema.connections).where(eq(schema.connections.orgId, orgId)),
      );
    }

    function auditOf(orgId: string) {
      return transactions.runInTenantTransaction(orgId, (tx) =>
        tx
          .select()
          .from(schema.auditLog)
          .where(and(eq(schema.auditLog.orgId, orgId), gte(schema.auditLog.createdAt, started))),
      );
    }

    beforeAll(async () => {
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
      [netlify, neon, supabase, resend, cloudflare] = await Promise.all([
        startNetlifyFixture({ port: PORTS.netlify }),
        startNeonFixture({ port: PORTS.neon }),
        startSupabaseFixture({ port: PORTS.supabase }),
        startResendFixture({ port: PORTS.resend }),
        startCloudflareFixture({ port: PORTS.cloudflare }),
      ]);
      daytona = await startFakeDaytona({ port: PORTS.daytona });
      daytona.onExecute(() => ({ exitCode: 0, result: '' }));

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ARTIFACT_STORE)
        .useValue(artifacts)
        .compile();
      app = moduleRef.createNestApplication();
      configureApplication(app);
      await app.init();

      database = app.get<ForgeDatabase>(APP_DATABASE);
      transactions = app.get(TenantTransactionRunner);
      world = await createTwoTenantWorld(app);

      process.stdout.write = (chunk: Uint8Array | string): boolean => {
        stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      };
    }, 600_000);

    afterAll(async () => {
      process.stdout.write = realWrite;
      if (world) await destroyTwoTenantWorld(app, world);
      for (const userId of extraUsers) {
        await database?.delete(schema.users).where(eq(schema.users.id, userId));
      }
      await app?.close();
      await Promise.all(
        [netlify, neon, supabase, resend, cloudflare, daytona].map((fixture) => fixture?.close()),
      );
      await suiteLock?.release();
    });

    beforeEach(() => {
      for (const fixture of [netlify, neon, supabase, resend, cloudflare]) fixture.reset();
    });

    describe('US1 — connect', () => {
      it.each(PASTED)(
        '$provider: a good token → 201, healthy, account.ref set, no token in the body',
        async ({ provider, ref, token }) => {
          const response = await paste(provider, token).expect(201);
          bodies.push(response.body);

          expect(connectionSchema.parse(response.body)).toMatchObject({
            account: { ref },
            health: 'healthy',
            provider,
          });
          expect(JSON.stringify(response.body)).not.toContain(token);
          expect(fixtureOf(provider).requests.length).toBeGreaterThan(0);
        },
      );

      it('a token with whitespace inside is refused before any provider call', async () => {
        const response = await paste('neon', 'napi_has space inside').expect(422);
        bodies.push(response.body);

        expect(response.body).toMatchObject({
          type: 'https://forge.dev/problems/validation-failed',
        });
        expect(response.body).not.toHaveProperty('reason');
        expect(neon.requests).toEqual([]);
      });

      it('an unknown or OAuth-only provider has no token route: 404', async () => {
        await paste('supabase', 'sbp_whatever').expect(404);
        await paste('github', 'ghs_whatever').expect(404);
      });

      it('a Resend sending-only key is refused: 422 naming full_access, nothing stored', async () => {
        const before = await connectionsOf(world.alpha.orgId);
        const response = await paste('resend', RESEND_SENDING_KEY).expect(422);
        bodies.push(response.body);

        expect(response.body).toMatchObject({
          missing: ['full_access'],
          reason: 'missing-scope',
          type: 'https://forge.dev/problems/validation-failed',
        });
        await expect(connectionsOf(world.alpha.orgId)).resolves.toEqual(before);
      });

      it('a revoked Netlify token is refused: 422 provider-refused', async () => {
        netlify.mode = 'revoked';
        const response = await paste('netlify', NETLIFY_TOKEN).expect(422);
        bodies.push(response.body);

        expect(response.body).toMatchObject({ reason: 'provider-refused' });
      });

      it('a Cloudflare token whose fixture denies DNS read is refused: 422 missing dns:read', async () => {
        cloudflare.dnsDenied = true;
        const response = await paste('cloudflare', CLOUDFLARE_TOKEN).expect(422);
        bodies.push(response.body);

        expect(response.body).toMatchObject({ missing: ['dns:read'], reason: 'missing-scope' });
      });

      it('a second connect replaces: one row per provider, audited connector.reconnected', async () => {
        const response = await paste('neon', NEON_KEY).expect(201);
        bodies.push(response.body);

        const rows = (await connectionsOf(world.alpha.orgId)).filter((r) => r.provider === 'neon');
        expect(rows).toHaveLength(1);

        const actions = (await auditOf(world.alpha.orgId))
          .filter((row) => (row.metadata as { provider?: string }).provider === 'neon')
          .map((row) => row.action);
        expect(actions).toEqual(['connector.connected', 'connector.reconnected']);
      });

      it('Supabase: install → authorize → complete; a replayed state is oauth-state-invalid', async () => {
        const installed = await unsafe(
          http(app).post(`${connectors(world.alpha.orgId)}/supabase/install`),
          [owner()],
        ).expect(200);
        bodies.push(installed.body);

        const authorize = new URL((installed.body as { url: string }).url);
        expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');

        const redirected = await fetch(authorize, { redirect: 'manual' });
        const back = new URL(redirected.headers.get('location')!);
        const body = {
          code: back.searchParams.get('code')!,
          state: back.searchParams.get('state')!,
        };

        const completed = await unsafe(
          http(app).post(`${connectors(world.alpha.orgId)}/supabase/complete`),
          [owner()],
        )
          .send(body)
          .expect(201);
        bodies.push(completed.body);

        connectIssued.push(...supabase.accessTokens, ...supabase.refreshTokens);
        issued.push(...connectIssued);
        expect(connectionSchema.parse(completed.body)).toMatchObject({
          account: { ref: 'sb-org-1' },
          authType: 'oauth',
          provider: 'supabase',
        });

        const replayed = await unsafe(
          http(app).post(`${connectors(world.alpha.orgId)}/supabase/complete`),
          [owner()],
        )
          .send(body)
          .expect(400);
        bodies.push(replayed.body);
        expect(replayed.body).toMatchObject({
          type: 'https://forge.dev/problems/oauth-state-invalid',
        });
      });

      it('GET / answers every connected provider in one list', async () => {
        const listed = await http(app)
          .get(connectors(world.alpha.orgId))
          .set('Cookie', owner())
          .expect(200);
        bodies.push(listed.body);

        expect(
          connectionListSchema
            .parse(listed.body)
            .connections.map((c) => c.provider)
            .sort(),
        ).toEqual(['cloudflare', 'neon', 'netlify', 'resend', 'supabase']);
      });
    });

    describe('US1 — remove', () => {
      it('without a recent second factor: 403 step-up-required, nothing changes', async () => {
        const [row] = (await connectionsOf(world.alpha.orgId)).filter(
          (r) => r.provider === 'netlify',
        );
        const refused = await unsafe(
          http(app).delete(`${connectors(world.alpha.orgId)}/${row!.id}`),
          [owner()],
        ).expect(403);
        bodies.push(refused.body);

        expect(refused.body).toMatchObject({ type: 'https://forge.dev/problems/step-up-required' });
        await expect(connectionsOf(world.alpha.orgId)).resolves.toContainEqual(
          expect.objectContaining({ id: row!.id, removalRequestedAt: null }),
        );
      });

      it('stepped up: 202 connection_remove; the row and its secret go, and Supabase is revoked', async () => {
        await stepUp(app, owner());

        for (const provider of ['netlify', 'supabase'] as const) {
          const [row] = (await connectionsOf(world.alpha.orgId)).filter(
            (r) => r.provider === provider,
          );
          const accepted = await unsafe(
            http(app).delete(`${connectors(world.alpha.orgId)}/${row!.id}`),
            [owner()],
          ).expect(202);
          bodies.push(accepted.body);

          expect(operationSchema.parse(accepted.body)).toMatchObject({
            kind: 'connection_remove',
            state: 'queued',
          });

          expect(
            await until(
              async () => !(await connectionsOf(world.alpha.orgId)).some((r) => r.id === row!.id),
              15_000,
            ),
          ).toBe(true);

          const secrets = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
            tx.select().from(schema.secrets).where(eq(schema.secrets.id, row!.secretId!)),
          );
          expect(secrets).toEqual([]);
        }

        expect(supabase.requests.some((r) => r.path === '/v1/oauth/revoke')).toBe(true);
      });
    });

    /** Quickstart § 5 (US2, SC-003, FR-010–FR-012): a pending domain's records through Cloudflare. */
    describe('US2 — Cloudflare DNS', () => {
      const TARGET = 'customers.forge-edge.test';

      /** A pending domain of alpha's project, seeded with no check due (the edge is not the subject). */
      async function pendingDomain() {
        const hostname = `w${randomUUID().slice(0, 8)}.acme.test`;
        const [row] = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx
            .insert(schema.domains)
            .values({
              addedBy: world.alpha.owner.userId,
              hostname,
              nextCheckAt: new Date(Date.now() + 86_400_000),
              orgId: world.alpha.orgId,
              ownershipToken: ownershipToken(),
              projectId: world.alpha.projectId,
              windowStartedAt: new Date(),
            })
            .returning(),
        );

        return row!;
      }

      /** The inverse of `stepUp`: the session as it is before a second factor is given. */
      async function forgetStepUp(cookie: string) {
        const token = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
        const hash = createHash('sha256').update(token).digest('hex');

        await app.get<Redis>(SESSION_REDIS).hdel(sessionKey(hash), 'steppedUpAt');
      }

      const offerPath = (domainId: string) =>
        `/api/v1/orgs/${world.alpha.orgId}/domains/${domainId}/cloudflare`;
      const tenantWrites = () =>
        cloudflare.requests.filter(
          (r) => r.method !== 'GET' && r.authorization === `Bearer ${CLOUDFLARE_TOKEN}`,
        );

      it('writable → step-up → both records written and marked; removing the domain deletes exactly those', async () => {
        const domain = await pendingDomain();

        const offered = await http(app)
          .get(offerPath(domain.id))
          .set('Cookie', owner())
          .expect(200);
        bodies.push(offered.body);
        expect(cloudflareOfferSchema.parse(offered.body)).toEqual({
          records: [
            {
              content: `forge-verify=${domain.ownershipToken}`,
              name: `_forge-challenge.${domain.hostname}`,
              type: 'TXT',
            },
            { content: TARGET, name: domain.hostname, type: 'CNAME' },
          ],
          status: 'writable',
          zone: { id: 'zone-1', name: 'acme.test' },
        });

        // Nothing is written on the offer, nor without a recent second factor (US1 stepped the
        // owner up, so the stamp is taken off the session first).
        await forgetStepUp(owner());
        const refused = await unsafe(http(app).post(`${offerPath(domain.id)}/write`), [
          owner(),
        ]).expect(403);
        bodies.push(refused.body);
        expect(refused.body).toMatchObject({
          type: 'https://forge.dev/problems/step-up-required',
        });
        expect(tenantWrites()).toEqual([]);

        await stepUp(app, owner());
        const accepted = await unsafe(http(app).post(`${offerPath(domain.id)}/write`), [
          owner(),
        ]).expect(202);
        bodies.push(accepted.body);
        expect(operationSchema.parse(accepted.body)).toMatchObject({
          kind: 'dns_write',
          state: 'queued',
        });

        expect(await until(() => Promise.resolve(cloudflare.records.length === 2), 15_000)).toBe(
          true,
        );
        for (const record of cloudflare.records) {
          expect(record).toMatchObject({ comment: `forge:domain:${domain.id}`, proxied: false });
        }
        expect(
          await until(
            async () =>
              cloudflareOfferSchema.parse(
                (await http(app).get(offerPath(domain.id)).set('Cookie', owner())).body,
              ).status === 'written',
            15_000,
          ),
        ).toBe(true);

        cloudflare.records.push({
          comment: null,
          content: '192.0.2.10',
          id: 'hand-made',
          name: 'api.acme.test',
          proxied: true,
          ttl: 300,
          type: 'A',
          zoneId: 'zone-1',
        });
        await unsafe(
          http(app).delete(
            `/api/v1/orgs/${world.alpha.orgId}/projects/${world.alpha.projectId}/domains/${domain.id}`,
          ),
          [owner()],
        ).expect(202);

        expect(await until(() => Promise.resolve(cloudflare.records.length === 1), 15_000)).toBe(
          true,
        );
        expect(cloudflare.records.map((r) => r.id)).toEqual(['hand-made']);
        expect(
          cloudflare.requests.filter(
            (r) => r.method === 'DELETE' && r.authorization === `Bearer ${CLOUDFLARE_TOKEN}`,
          ),
        ).toHaveLength(2);
      });

      it('a different CNAME already there: 409 record-conflict, the zone unchanged', async () => {
        const domain = await pendingDomain();
        cloudflare.records.push({
          comment: null,
          content: 'someone-else.example',
          id: 'theirs',
          name: domain.hostname,
          proxied: false,
          ttl: 1,
          type: 'CNAME',
          zoneId: 'zone-1',
        });
        await stepUp(app, owner());

        const refused = await unsafe(http(app).post(`${offerPath(domain.id)}/write`), [
          owner(),
        ]).expect(409);
        bodies.push(refused.body);

        expect(refused.body).toMatchObject({
          reason: 'record-conflict',
          record: { content: 'someone-else.example', name: domain.hostname, type: 'CNAME' },
        });
        expect(cloudflare.records.map((r) => r.id)).toEqual(['theirs']);
        expect(tenantWrites()).toEqual([]);
      });
    });

    describe('US3 — preview databases', () => {
      const a = () => world.alpha;
      const bindingsPath = () => `/api/v1/orgs/${a().orgId}/projects/${a().projectId}/connectors`;
      const NEON_BODY = {
        databaseName: 'neondb',
        parentBranchId: 'br-main',
        projectId: NEON_PROJECT,
        roleName: 'neondb_owner',
      };

      async function neonBinding() {
        const answer = await http(app).get(bindingsPath()).set('Cookie', owner()).expect(200);
        bodies.push(answer.body);

        return (
          answer.body as { items: { provider: string; resources: { state: string }[] }[] }
        ).items.find((item) => item.provider === 'neon');
      }

      const live = async () => (await neonBinding())?.resources[0]?.state === 'live';

      /** Every file the run wrote into a sandbox, and every upload body the fake received. */
      function sandboxFiles(): string {
        const files = [...daytona.workspace.values()].map((entry) =>
          entry.kind === 'file' ? entry.content.toString('utf8') : '',
        );

        return [...files, ...daytona.requests.map((request) => request.body)].join('\n');
      }

      it('bind → one forge-preview branch, live within 30 s; the project file carries DATABASE_URL only (SC-004, SC-008)', async () => {
        const branches = installNeonBranches(neon);
        const name = `forge-preview-${a().projectId}`;

        await paste('neon', NEON_KEY).expect(201);

        const bound = await unsafe(http(app).put(`${bindingsPath()}/neon`), [owner()])
          .send(NEON_BODY)
          .expect(200);
        bodies.push(bound.body);
        expect(bound.body).toMatchObject({ config: NEON_BODY, provider: 'neon', state: 'bound' });

        const began = Date.now();
        expect(await until(live, 30_000)).toBe(true);
        expect(Date.now() - began).toBeLessThan(30_000);
        expect(branches.branches.filter((row) => row.name === name)).toHaveLength(1);

        // The sandbox delivery at a pool claim: the callback file and the project file.
        const daytonaId = daytona.seedSandbox({ state: 'started' });
        const [row] = await transactions.runInTenantTransaction(a().orgId, (tx) =>
          tx
            .insert(schema.sandboxes)
            .values({
              daytonaId,
              orgId: a().orgId,
              projectId: a().projectId,
              workspaceRoot: daytona.workDir,
            })
            .returning({ id: schema.sandboxes.id }),
        );
        const sandboxOps = app.get(SandboxOpsConsumer, { strict: false });
        const payload = { op: 'label' as const, orgId: a().orgId, sandboxId: row!.id };
        const envelope = {
          aggregate: 'sandbox' as const,
          aggregateId: row!.id,
          eventId: randomUUID(),
          occurredAt: new Date().toISOString(),
          orgId: a().orgId,
          payload,
          traceId: null,
          type: 'sandbox.op.requested' as const,
        };
        const job = await database.transaction((tx) => sandboxOps.handle(envelope, tx));
        await sandboxOps.effect(envelope, job);

        const projectFile = daytona.workspace.get(SANDBOX_PROJECT_ENV_PATH);
        const callbackFile = daytona.workspace.get(SANDBOX_CALLBACK_ENV_PATH);
        expect(projectFile?.kind).toBe('file');
        const lines = (projectFile as { content: Buffer }).content
          .toString('utf8')
          .trim()
          .split('\n');
        const keys = lines.map((line) => line.slice(0, line.indexOf('=')));

        expect(keys).toEqual(['DATABASE_URL']);
        expect(keys.every((key) => (PREVIEW_ENV_KEYS as readonly string[]).includes(key))).toBe(
          true,
        );
        expect(lines[0]).toContain(`${branches.branches.find((r) => r.name === name)!.id}-pooler`);
        expect((callbackFile as { content: Buffer }).content.toString('utf8')).not.toContain(
          'DATABASE_URL',
        );

        await transactions.runInTenantTransaction(a().orgId, (tx) =>
          tx.delete(schema.sandboxes).where(eq(schema.sandboxes.id, row!.id)),
        );

        // Reset: the same name, a new id.
        const before = branches.branches.find((r) => r.name === name)!.id;
        const reset = await unsafe(http(app).post(`${bindingsPath()}/neon/reset`), [
          owner(),
        ]).expect(202);
        bodies.push(reset.body);
        expect(
          await until(
            async () =>
              (await live()) && branches.branches.some((r) => r.name === name && r.id !== before),
            30_000,
          ),
        ).toBe(true);
        expect(branches.branches.filter((r) => r.name === name)).toHaveLength(1);

        // Unbind: the branch is deleted at Neon, then the binding goes.
        const unbound = await unsafe(http(app).delete(`${bindingsPath()}/neon`), [owner()]).expect(
          202,
        );
        bodies.push(unbound.body);
        expect(await until(async () => (await neonBinding()) === undefined, 30_000)).toBe(true);
        expect(branches.branches.filter((r) => r.name === name)).toHaveLength(0);

        // SC-008: no org-level credential in any sandbox file of the run.
        const written = sandboxFiles();
        for (const credential of [
          NEON_KEY,
          NETLIFY_TOKEN,
          RESEND_KEY,
          CLOUDFLARE_TOKEN,
          SUPABASE_CLIENT_SECRET,
          ...issued,
        ]) {
          expect(written).not.toContain(credential);
        }
      }, 120_000);
    });

    /** Quickstart § 7 (US4, SC-006): bind a new site, publish a release, adopt on retry, site gone. */
    describe('US4 — Netlify publish', () => {
      const a = () => world.alpha;
      const bindingsPath = () => `/api/v1/orgs/${a().orgId}/projects/${a().projectId}/connectors`;
      const RELEASE = [
        { body: Buffer.from('<!doctype html><h1>published</h1>'), path: 'index.html' },
        { body: Buffer.from('export const app = 1;'), path: 'assets/app-3f2a.js' },
        { body: Buffer.from('export const app = 1;'), path: 'assets/copy.js' },
        { body: Buffer.from([0, 1, 2, 250, 251, 252, 253]), path: 'assets/logo.bin' },
      ];
      const sha1 = (body: Buffer) => createHash('sha1').update(body).digest('hex');

      /** A `succeeded` 027 release of alpha's project, its files in the artifacts store. */
      async function release(): Promise<string> {
        const { orgId, projectId } = a();
        const { artifactSha } = await upload(artifacts, orgId, projectId, RELEASE);

        return transactions.runInTenantTransaction(orgId, async (tx) => {
          const [checkpoint] = await tx
            .insert(schema.checkpoints)
            .values({
              files: [],
              gitSha: createHash('sha1').update(randomUUID()).digest('hex'),
              kind: 'baseline',
              label: 'Baseline',
              orgId,
              projectId,
            })
            .returning({ id: schema.checkpoints.id });
          const [row] = await tx
            .insert(schema.deployments)
            .values({
              artifactSha,
              checkpointId: checkpoint!.id,
              finishedAt: new Date(),
              orgId,
              projectId,
              requestedBy: a().owner.userId,
              startedAt: new Date(),
              state: 'succeeded',
              template: 'vite-react',
            })
            .returning({ id: schema.deployments.id });

          return row!.id;
        });
      }

      async function operationRow(id: string) {
        const [row] = await transactions.runInTenantTransaction(a().orgId, (tx) =>
          tx.select().from(schema.connectorOperations).where(eq(schema.connectorOperations.id, id)),
        );
        return row!;
      }

      const settled = (id: string) => async () =>
        ['succeeded', 'failed'].includes((await operationRow(id)).state);

      async function publish(deploymentId: string, cookie = owner()) {
        const answer = await unsafe(http(app).post(`${bindingsPath()}/netlify/publish`), [
          cookie,
        ]).send({ deploymentId });
        bodies.push(answer.body);
        return answer;
      }

      async function waitForPublishSlot() {
        // One publish in flight per binding: let the previous one settle before the next.
        await until(
          async () =>
            (
              await transactions.runInTenantTransaction(a().orgId, (tx) =>
                tx
                  .select({ state: schema.connectorOperations.state })
                  .from(schema.connectorOperations)
                  .where(eq(schema.connectorOperations.kind, 'netlify_publish')),
              )
            ).every((row) => row.state !== 'queued' && row.state !== 'running'),
          60_000,
        );
      }

      it('bind a new site, publish a release: ready, byte-identical files, one deploy; adopt on retry; site gone → disconnected', async () => {
        await paste('netlify', NETLIFY_TOKEN).expect(201);
        const [connection] = (await connectionsOf(a().orgId)).filter(
          (row) => row.provider === 'netlify',
        );

        const sites = await http(app)
          .get(`${connectors(a().orgId)}/${connection!.id}/netlify/sites?q=acme`)
          .set('Cookie', owner())
          .expect(200);
        bodies.push(sites.body);
        expect(sites.body).toEqual({
          items: [{ id: 'site-1', name: 'acme-site', url: 'https://acme-site.netlify.app' }],
        });

        // A taken name is refused; a new one is created in the request, no operation.
        await unsafe(http(app).put(`${bindingsPath()}/netlify`), [owner()])
          .send({ createSite: { name: 'acme-site' } })
          .expect(409);
        const bound = await unsafe(http(app).put(`${bindingsPath()}/netlify`), [owner()])
          .send({ createSite: { name: 'forge-published' } })
          .expect(200);
        bodies.push(bound.body);
        expect(bound.body).toMatchObject({
          config: { siteName: 'forge-published', siteUrl: 'https://forge-published.netlify.app' },
          latestOperation: null,
          provider: 'netlify',
          state: 'bound',
        });
        const siteId = (bound.body as { config: { siteId: string } }).config.siteId;

        // Publish: succeeded, `ready` on the timeline, the stored files exactly the release's.
        const deploymentId = await release();
        const first = await publish(deploymentId);
        expect(first.status).toBe(202);
        const firstId = (first.body as { id: string }).id;
        expect(await until(settled(firstId), 60_000)).toBe(true);
        expect(await operationRow(firstId)).toMatchObject({
          externalRef: 'deploy-1',
          providerState: 'ready',
          state: 'succeeded',
        });
        expect(netlify.deploys).toHaveLength(1);
        expect(netlify.deploys[0]).toMatchObject({ siteId, title: publishTitle(firstId) });
        const stored = netlify.uploads.get('deploy-1')!;
        const manifestDigests = {
          ...Object.fromEntries(RELEASE.map((file) => [`/${file.path}`, sha1(file.body)])),
          // The SPA fallback Kido's own host gives a release with an index.html.
          '/_redirects': sha1(Buffer.from('/*    /index.html    200\n')),
        };
        expect(netlify.deploys[0]!.files).toEqual(manifestDigests);
        // SC-006: every digest stored is the SHA1 of the bytes sent, each distinct one once.
        expect(new Set(stored.values())).toEqual(new Set(Object.values(manifestDigests)));

        const operations = await http(app)
          .get(`${bindingsPath()}/operations?kind=netlify_publish`)
          .set('Cookie', owner())
          .expect(200);
        bodies.push(operations.body);
        expect(operations.body).toMatchObject({
          items: [{ deploymentId, id: firstId, providerState: 'ready', state: 'succeeded' }],
        });

        // Crash after create, before recording: Netlify made the deploy, the answer was lost.
        // The retry adopts it by title — the fixture holds one deploy for the operation.
        let creates = 0;
        netlify.route('POST', '/sites/:siteId/deploys', ({ siteId: site }, request) => {
          creates += 1;
          const body = request.body as { files: Record<string, string>; title: string };
          netlify.deploys.push({
            files: body.files,
            id: `deploy-${String(netlify.deploys.length + 1)}`,
            processingPolls: 0,
            required: [],
            siteId: site!,
            state: 'processing',
            title: body.title,
          });
          return { status: 503 };
        });
        await waitForPublishSlot();
        const second = await publish(await release());
        expect(second.status).toBe(202);
        const secondId = (second.body as { id: string }).id;
        expect(await until(settled(secondId), 60_000)).toBe(true);
        expect(creates).toBe(1);
        expect(netlify.deploys.filter((d) => d.title === publishTitle(secondId))).toHaveLength(1);
        expect(await operationRow(secondId)).toMatchObject({
          externalRef: 'deploy-2',
          state: 'succeeded',
        });

        // A release that is not this project's is a 404, and nothing is queued.
        const foreign = await publish(randomUUID());
        expect(foreign.status).toBe(404);

        // The site is deleted at Netlify: the publish fails site-gone, the binding disconnected.
        netlify.sites = netlify.sites.filter((site) => site.id !== siteId);
        const third = await publish(await release());
        const thirdId = (third.body as { id: string }).id;
        expect(await until(settled(thirdId), 60_000)).toBe(true);
        expect(await operationRow(thirdId)).toMatchObject({ reason: 'site-gone', state: 'failed' });
        const after = await http(app).get(bindingsPath()).set('Cookie', owner()).expect(200);
        bodies.push(after.body);
        expect(
          (after.body as { items: { provider: string; state: string }[] }).items.find(
            (item) => item.provider === 'netlify',
          ),
        ).toMatchObject({ state: 'disconnected' });
      }, 180_000);

      it('an editor cannot bind (403) but may publish with project:deploy (202)', async () => {
        await paste('netlify', NETLIFY_TOKEN).expect(201);
        await unsafe(http(app).put(`${bindingsPath()}/netlify`), [owner()])
          .send({ siteId: 'site-1' })
          .expect(200);

        const editor = await signUpAndIn(app, 'netlify-editor');
        extraUsers.push(editor.userId);
        await transactions.runInTenantTransaction(a().orgId, async (tx) => {
          await tx.insert(schema.memberships).values({
            acceptedAt: new Date(),
            orgId: a().orgId,
            role: 'member',
            userId: editor.userId,
          });
          await tx.insert(schema.projectGrants).values({
            orgId: a().orgId,
            projectId: a().projectId,
            role: 'editor',
            userId: editor.userId,
          });
        });

        const refused = await unsafe(http(app).put(`${bindingsPath()}/netlify`), [editor.cookie])
          .send({ siteId: 'site-1' })
          .expect(403);
        bodies.push(refused.body);

        await waitForPublishSlot();
        const published = await publish(await release(), editor.cookie);
        expect(published.status).toBe(202);
        const id = (published.body as { id: string }).id;
        expect(await until(settled(id), 60_000)).toBe(true);
        expect(await operationRow(id)).toMatchObject({ state: 'succeeded' });
      }, 120_000);

      it('Deploy to Netlify: one request builds the head and publishes it once the build lands; a second is refused with no second build', async () => {
        const { orgId, projectId } = a();
        await paste('netlify', NETLIFY_TOKEN).expect(201);
        await unsafe(http(app).put(`${bindingsPath()}/netlify`), [owner()])
          .send({ siteId: 'site-1' })
          .expect(200);
        // A head checkpoint to build (with an older release beside it).
        await release();
        await waitForPublishSlot();
        const buildsOf = () =>
          transactions.runInTenantTransaction(orgId, (tx) =>
            tx
              .select()
              .from(schema.deployments)
              .where(
                and(
                  eq(schema.deployments.projectId, projectId),
                  eq(schema.deployments.state, 'queued'),
                ),
              ),
          );

        const answer = await unsafe(http(app).post(`${bindingsPath()}/netlify/publish`), [
          owner(),
        ]).send({});
        bodies.push(answer.body);
        expect(answer.status).toBe(202);
        const id = (answer.body as { id: string; deploymentId: string }).id;
        const [build] = await buildsOf();
        // The publish names the build it queued, and waits on it.
        expect((answer.body as { deploymentId: string }).deploymentId).toBe(build!.id);
        expect(
          await until(async () => (await operationRow(id)).providerState === 'building', 30_000),
        ).toBe(true);

        // A second press while that publish runs: 409 in-flight, and its build rolled back with it.
        const again = await unsafe(http(app).post(`${bindingsPath()}/netlify/publish`), [
          owner(),
        ]).send({});
        bodies.push(again.body);
        expect(again.status).toBe(409);
        expect(again.body).toMatchObject({ reason: 'in-flight' });
        expect(await buildsOf()).toHaveLength(1);

        // The build lands (the build consumer is the agent profile's, not started here).
        const { artifactSha } = await upload(artifacts, orgId, projectId, RELEASE);
        await transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .update(schema.deployments)
            .set({ artifactSha, finishedAt: new Date(), startedAt: new Date(), state: 'succeeded' })
            .where(eq(schema.deployments.id, build!.id)),
        );

        expect(await until(settled(id), 60_000)).toBe(true);
        expect(await operationRow(id)).toMatchObject({
          providerState: 'ready',
          state: 'succeeded',
        });
      }, 120_000);
    });

    /**
     * Quickstart §§ 6, 8 (US5, SC-005): a Resend binding waits on a pending domain and mints one
     * domain-restricted sending key once it is verified; the platform's domain is never offered;
     * archiving a project bound to Neon, Supabase and Resend leaves nothing in any fixture.
     */
    describe('US5 — Resend, and the SC-005 release', () => {
      const a = () => world.alpha;
      const bindingsOf = (projectId: string) =>
        `/api/v1/orgs/${a().orgId}/projects/${projectId}/connectors`;

      async function bindingOf(projectId: string, provider: string) {
        const answer = await http(app)
          .get(bindingsOf(projectId))
          .set('Cookie', owner())
          .expect(200);
        bodies.push(answer.body);

        return (
          answer.body as {
            items: {
              provider: string;
              domainStatus?: string | null;
              resources: { state: string }[];
            }[];
          }
        ).items.find((item) => item.provider === provider);
      }

      const liveIn = async (projectId: string, provider: string) =>
        (await bindingOf(projectId, provider))?.resources[0]?.state === 'live';

      function previewEnv(projectId: string) {
        const source = app.get<PreviewEnvSource>(PREVIEW_ENV_SOURCE, { strict: false });

        return transactions.runInTenantTransaction(a().orgId, (tx) =>
          source(tx, a().orgId, projectId),
        );
      }

      async function connectResend(): Promise<string> {
        const answer = await paste('resend', RESEND_KEY).expect(201);
        bodies.push(answer.body);

        return (answer.body as { id: string }).id;
      }

      it('pending → no key; verified + sweep → one sending key for that domain, in the preview env; the platform domain is never offered; unbind deletes the key', async () => {
        const state = installResendState(resend);
        const connectionId = await connectResend();
        const projectId = a().projectId;

        // FR-021: never listed, never bindable.
        const listed = await http(app)
          .get(`${connectors(a().orgId)}/${connectionId}/resend/domains`)
          .set('Cookie', owner())
          .expect(200);
        bodies.push(listed.body);
        const ids = (listed.body as { items: { id: string }[] }).items.map((row) => row.id);
        expect(ids).toEqual([RESEND_VERIFIED_DOMAIN, RESEND_PENDING_DOMAIN]);
        const platform = await unsafe(http(app).put(`${bindingsOf(projectId)}/resend`), [owner()])
          .send({ domainId: RESEND_PLATFORM_DOMAIN })
          .expect(404);
        bodies.push(platform.body);

        // A pending domain: bound, its status shown, no key.
        const bound = await unsafe(http(app).put(`${bindingsOf(projectId)}/resend`), [owner()])
          .send({ domainId: RESEND_PENDING_DOMAIN })
          .expect(200);
        bodies.push(bound.body);
        expect(bound.body).toMatchObject({
          config: { domainId: RESEND_PENDING_DOMAIN, domainName: 'news.acme.test' },
          domainStatus: 'pending',
          latestOperation: null,
          provider: 'resend',
          resources: [],
        });
        expect(state.keys).toEqual([]);
        expect(await previewEnv(projectId)).not.toHaveProperty('RESEND_API_KEY');

        // Verified at Resend; the daily sweep is the fallback that mints.
        state.domains.find((row) => row.id === RESEND_PENDING_DOMAIN)!.status = 'verified';
        await app.get(ConnectorHealthConsumer, { strict: false }).sweep();
        expect(await until(() => liveIn(projectId, 'resend'), 30_000)).toBe(true);

        expect(state.keys).toHaveLength(1);
        expect(state.keys[0]).toMatchObject({
          domainId: RESEND_PENDING_DOMAIN,
          name: `forge-${projectId}`,
          permission: 'sending_access',
        });
        issued.push(...state.keys.map((key) => key.token));
        await expect(previewEnv(projectId)).resolves.toMatchObject({
          RESEND_API_KEY: state.keys[0]!.token,
          RESEND_FROM_DOMAIN: 'news.acme.test',
        });

        // Unbind: the key is deleted at Resend, then the binding goes.
        const unbound = await unsafe(http(app).delete(`${bindingsOf(projectId)}/resend`), [
          owner(),
        ]).expect(202);
        bodies.push(unbound.body);
        expect(
          await until(async () => (await bindingOf(projectId, 'resend')) === undefined, 30_000),
        ).toBe(true);
        expect(state.keys).toEqual([]);
        expect(await previewEnv(projectId)).not.toHaveProperty('RESEND_API_KEY');
      }, 120_000);

      it('SC-005: archive a project bound to Neon, Supabase and Resend → every resource released, nothing left in any fixture', async () => {
        const branches = installNeonBranches(neon);
        const state = installResendState(resend);
        supabase.route('GET', '/v1/projects/:ref/api-keys', () => ({
          body: [{ api_key: 'sb_publishable_sc005', name: 'default', type: 'publishable' }],
          status: 200,
        }));

        await paste('neon', NEON_KEY).expect(201);
        await connectResend();
        const installed = await unsafe(
          http(app).post(`${connectors(a().orgId)}/supabase/install`),
          [owner()],
        ).expect(200);
        const redirected = await fetch(new URL((installed.body as { url: string }).url), {
          redirect: 'manual',
        });
        const back = new URL(redirected.headers.get('location')!);
        const supabaseConnection = await unsafe(
          http(app).post(`${connectors(a().orgId)}/supabase/complete`),
          [owner()],
        )
          .send({ code: back.searchParams.get('code')!, state: back.searchParams.get('state')! })
          .expect(201);
        issued.push(...supabase.accessTokens, ...supabase.refreshTokens);

        const projects = `/api/v1/orgs/${a().orgId}/workspaces/${a().workspaceId}/projects`;
        const created = await unsafe(http(app).post(projects), [owner()])
          .send({ name: 'SC-005 release' })
          .expect(201);
        const projectId = (created.body as { project: { id: string } }).project.id;

        for (const [provider, body] of [
          [
            'neon',
            {
              databaseName: 'neondb',
              parentBranchId: 'br-main',
              projectId: NEON_PROJECT,
              roleName: 'neondb_owner',
            },
          ],
          ['supabase', { projectRef: 'sc005ref' }],
          ['resend', { domainId: RESEND_VERIFIED_DOMAIN }],
        ] as const) {
          const bound = await unsafe(http(app).put(`${bindingsOf(projectId)}/${provider}`), [
            owner(),
          ])
            .send(body)
            .expect(200);
          bodies.push(bound.body);
        }
        for (const provider of ['neon', 'supabase', 'resend']) {
          expect(await until(() => liveIn(projectId, provider), 30_000)).toBe(true);
        }
        issued.push(...state.keys.map((key) => key.token));
        const branch = `forge-preview-${projectId}`;
        expect(branches.branches.filter((row) => row.name === branch)).toHaveLength(1);
        expect(state.keys.filter((key) => key.name === `forge-${projectId}`)).toHaveLength(1);

        // The project's resources, by id: the rows outlive their bindings (`binding_id` → null).
        const resourceIds = await transactions.runInTenantTransaction(a().orgId, async (tx) => {
          const bound = await tx
            .select({ id: schema.connectorBindings.id })
            .from(schema.connectorBindings)
            .where(eq(schema.connectorBindings.projectId, projectId));
          const rows = await tx
            .select({ id: schema.connectorResources.id })
            .from(schema.connectorResources)
            .where(
              inArray(
                schema.connectorResources.bindingId,
                bound.map((row) => row.id),
              ),
            );

          return rows.map((row) => row.id);
        });
        expect(resourceIds).toHaveLength(3);

        await unsafe(http(app).delete(`${projects}/${projectId}`), [owner()]).expect(204);

        const settled = () =>
          transactions.runInTenantTransaction(a().orgId, async (tx) => ({
            bindings: await tx
              .select({ id: schema.connectorBindings.id })
              .from(schema.connectorBindings)
              .where(eq(schema.connectorBindings.projectId, projectId)),
            resources: await tx
              .select({
                kind: schema.connectorResources.kind,
                secretId: schema.connectorResources.secretId,
                state: schema.connectorResources.state,
              })
              .from(schema.connectorResources)
              .where(inArray(schema.connectorResources.id, resourceIds)),
          }));
        expect(await until(async () => (await settled()).bindings.length === 0, 30_000)).toBe(true);

        const { resources } = await settled();
        const kinds = new Set(resources.map((row) => row.kind));
        expect(kinds).toEqual(
          new Set(['neon_branch', 'resend_sending_key', 'supabase_publishable_key']),
        );
        for (const row of resources) {
          expect(row).toMatchObject({ secretId: null, state: 'released' });
        }
        // Nothing of the project left at any provider.
        expect(branches.branches.filter((row) => row.name === branch)).toHaveLength(0);
        expect(state.keys).toEqual([]);
        expect(await previewEnv(projectId)).toEqual({});

        // US1's state again for the stories after this one: no Supabase connection.
        await stepUp(app, owner());
        const supabaseId = (supabaseConnection.body as { id: string }).id;
        await unsafe(http(app).delete(`${connectors(a().orgId)}/${supabaseId}`), [owner()]).expect(
          202,
        );
        expect(
          await until(
            async () => !(await connectionsOf(a().orgId)).some((row) => row.id === supabaseId),
            30_000,
          ),
        ).toBe(true);
      }, 180_000);
    });

    /** Quickstart § 4 (US6, SC-007): health read after one sweep, the breaker, one refresh. */
    describe('US6 — health', () => {
      const a = () => world.alpha;
      const bindingsPath = () => `/api/v1/orgs/${a().orgId}/projects/${a().projectId}/connectors`;
      const NEON_BODY = {
        databaseName: 'neondb',
        parentBranchId: 'br-main',
        projectId: NEON_PROJECT,
        roleName: 'neondb_owner',
      };
      const sweep = () => app.get(ConnectorHealthConsumer, { strict: false }).sweep();

      /** Past the sweep's skip window, so the next sweep probes every row. */
      const age = () =>
        transactions.runInTenantTransaction(a().orgId, (tx) =>
          tx
            .update(schema.connections)
            .set({ lastVerifiedAt: new Date(Date.now() - VERIFIED_WITHIN_MS - 60_000) })
            .where(eq(schema.connections.orgId, a().orgId)),
        );

      async function connectSupabase() {
        const installed = await unsafe(
          http(app).post(`${connectors(a().orgId)}/supabase/install`),
          [owner()],
        ).expect(200);
        const redirected = await fetch(new URL((installed.body as { url: string }).url), {
          redirect: 'manual',
        });
        const back = new URL(redirected.headers.get('location')!);
        const completed = await unsafe(
          http(app).post(`${connectors(a().orgId)}/supabase/complete`),
          [owner()],
        )
          .send({ code: back.searchParams.get('code')!, state: back.searchParams.get('state')! })
          .expect(201);
        issued.push(...supabase.accessTokens, ...supabase.refreshTokens);

        return (completed.body as { id: string }).id;
      }

      it('revoked at each provider → needs_reauth after one sweep, audited once; PUT neon → 409 needs-reauth in < 1 s', async () => {
        for (const { provider, token } of PASTED) {
          fixtureOf(provider).mode = 'good';
          await paste(provider, token).expect(201);
        }
        await age();
        const since = new Date();
        for (const { provider } of PASTED) fixtureOf(provider).mode = 'revoked';

        await sweep();
        await age();
        await sweep();

        const rows = (await connectionsOf(a().orgId)).filter((row) => row.provider !== 'github');
        for (const { provider } of PASTED) {
          expect(rows.find((row) => row.provider === provider)?.health).toBe('needs_reauth');
        }
        const changes = (await auditOf(a().orgId)).filter(
          (row) => row.action === 'connector.health-changed' && row.createdAt >= since,
        );
        expect(changes).toHaveLength(PASTED.length);

        const began = Date.now();
        const refused = await unsafe(http(app).put(`${bindingsPath()}/neon`), [owner()])
          .send(NEON_BODY)
          .expect(409);
        expect(Date.now() - began).toBeLessThan(1_000);
        bodies.push(refused.body);
        expect(JSON.stringify(refused.body)).toContain('needs-reauth');
      });

      it('five failures open the circuit: PUT neon → 503 with Retry-After; a good answer closes it', async () => {
        await paste('neon', NEON_KEY).expect(201);
        await age();
        neon.mode = 'unavailable';

        for (let i = 0; i < 5; i += 1) await sweep();
        const [row] = (await connectionsOf(a().orgId)).filter((r) => r.provider === 'neon');
        expect(row).toMatchObject({ health: 'unavailable' });
        expect(row!.circuitOpenUntil).not.toBeNull();

        const refused = await unsafe(http(app).put(`${bindingsPath()}/neon`), [owner()])
          .send(NEON_BODY)
          .expect(503);
        bodies.push(refused.body);
        expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);

        neon.mode = 'good';
        await sweep();
        await expect(connectionsOf(a().orgId)).resolves.toContainEqual(
          expect.objectContaining({ circuitOpenUntil: null, health: 'healthy', provider: 'neon' }),
        );
      });

      it('ten concurrent Supabase calls with an expiring token cost exactly one refresh', async () => {
        const id = await connectSupabase();
        await transactions.runInTenantTransaction(a().orgId, (tx) =>
          tx
            .update(schema.connections)
            .set({ tokenExpiresAt: new Date(Date.now() + 60_000) })
            .where(eq(schema.connections.id, id)),
        );
        supabase.route('GET', '/v1/projects', () => ({
          body: [{ id: 'sbref1', name: 'app', region: 'eu-west-1', status: 'ACTIVE_HEALTHY' }],
          status: 200,
        }));
        const before = supabase.refreshCount;

        const answers = await Promise.all(
          Array.from({ length: 10 }, () =>
            http(app)
              .get(`${connectors(a().orgId)}/${id}/supabase/projects`)
              .set('Cookie', owner()),
          ),
        );
        issued.push(...supabase.accessTokens, ...supabase.refreshTokens);
        bodies.push(...answers.map((answer): unknown => answer.body));

        expect(answers.map((answer) => answer.status)).toEqual(Array(10).fill(200));
        expect(supabase.refreshCount - before).toBe(1);
      });
    });

    /** FR-024: another organisation's connectors and bindings are not reachable. */
    describe('across organisations', () => {
      it('a member of org B is refused on org A’s connector routes, and no operation is created', async () => {
        const countOps = async () =>
          (
            await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
              tx
                .select({ id: schema.connectorOperations.id })
                .from(schema.connectorOperations)
                .where(eq(schema.connectorOperations.orgId, world.alpha.orgId)),
            )
          ).length;
        const before = await countOps();
        const intruder = world.beta.owner.cookie;
        const a = world.alpha;
        const project = `/api/v1/orgs/${a.orgId}/projects/${a.projectId}/connectors`;
        const domainId = '00000000-0000-4000-8000-000000000000';

        await stepUp(app, intruder);

        const answers = [
          await http(app).get(connectors(a.orgId)).set('Cookie', intruder),
          await unsafe(http(app).put(`${project}/neon`), [intruder]).send({
            databaseName: 'app',
            parentBranchId: 'br-main',
            projectId: 'proj-1',
            roleName: 'app',
          }),
          await unsafe(http(app).post(`${project}/netlify/publish`), [intruder]).send({
            deploymentId: domainId,
          }),
          await unsafe(http(app).post(`${project}/neon/reset`), [intruder]),
          await http(app)
            .get(`/api/v1/orgs/${a.orgId}/domains/${domainId}/cloudflare`)
            .set('Cookie', intruder),
          await http(app).get(`${project}/operations`).set('Cookie', intruder),
          await http(app).get(project).set('Cookie', intruder),
          await unsafe(http(app).delete(`${project}/neon`), [intruder]),
          await http(app)
            .get(`${connectors(a.orgId)}/${domainId}/neon/projects`)
            .set('Cookie', intruder),
          await http(app)
            .get(`${connectors(a.orgId)}/${domainId}/netlify/sites`)
            .set('Cookie', intruder),
          await unsafe(http(app).put(`${project}/netlify`), [intruder]).send({ siteId: 'site-1' }),
          await unsafe(http(app).put(`${project}/resend`), [intruder]).send({ domainId: 'dom-1' }),
          await http(app)
            .get(`${connectors(a.orgId)}/${domainId}/resend/domains`)
            .set('Cookie', intruder),
          await paste('neon', NEON_KEY, intruder, a.orgId),
          await unsafe(http(app).delete(`${connectors(a.orgId)}/${domainId}`), [intruder]),
        ];

        for (const answer of answers) {
          bodies.push(answer.body);
          expect([403, 404]).toContain(answer.status);
        }
        await expect(countOps()).resolves.toBe(before);
      });
    });

    it('SC-002: no response, log line, audit row or outbox event of the run carries a credential', async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      const orgIds = [world.alpha.orgId, world.beta.orgId];
      const audit = (await Promise.all(orgIds.map((orgId) => auditOf(orgId)))).flat();
      const events = await database
        .select()
        .from(schema.outbox)
        .where(gte(schema.outbox.occurredAt, started));

      const credentials = [
        NETLIFY_TOKEN,
        NEON_KEY,
        RESEND_KEY,
        RESEND_SENDING_KEY,
        CLOUDFLARE_TOKEN,
        SUPABASE_CLIENT_SECRET,
        ...issued,
      ];

      // US1's connect issued exactly one access and one refresh token, and the scan covers them;
      // later stories' tokens are in `issued` too, counted by their own tests.
      expect(connectIssued).toHaveLength(2);
      expect(new Set(connectIssued).size).toBe(2);
      expect(issued).toEqual(expect.arrayContaining(connectIssued));
      const logs = stdout.join('');

      expect(audit.length).toBeGreaterThan(0);
      expect(logs).toContain('connectors');

      for (const haystack of [
        JSON.stringify(bodies),
        logs,
        JSON.stringify(audit),
        JSON.stringify(events),
      ]) {
        for (const credential of credentials) {
          expect(haystack).not.toContain(credential);
        }
      }
    });
  });
});
