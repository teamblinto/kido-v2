import { ConfigModule } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { and, asc, eq, gt } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { ClockModule } from '../../common/clock/clock.module';
import { CryptoModule } from '../../common/crypto/crypto.module';
import { RedisModule } from '../../common/redis/redis.module';
import { RunProfilesModule } from '../../common/run-profiles/run-profiles.module';
import { validateEnvironment } from '../../config/environment';
import { APP_DATABASE } from '../../database/database.constants';
import { DatabaseModule } from '../../database/database.module';
import type { ForgeDatabase, TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { MailModule } from '../mail/mail.module';
import { PreviewModule } from '../preview/preview.module';
import {
  ORG_ROLE_PERMISSIONS,
  PROJECT_ROLE_PERMISSIONS,
  WORKSPACE_ROLE_PERMISSIONS,
} from '../rbac/permissions';
import { OrgService } from '../tenancy/services/org.service';
import { ProjectService } from '../tenancy/services/project.service';
import { TenancyModule } from '../tenancy/tenancy.module';
import {
  type ProviderFixture,
  RESEND_KEY,
  startResendFixture,
} from '../../../test/fixtures/provider-fixtures';
import {
  installResendState,
  RESEND_PENDING_DOMAIN,
  RESEND_PLATFORM_DOMAIN,
  RESEND_VERIFIED_DOMAIN,
  type ResendState,
} from '../../../test/fixtures/resend-state';
import { OrgCache } from '../../common/redis/org-cache';
import type { OrgCacheKey } from '../../common/redis/cache-key';
import { BindingService } from './binding.service';
import { ConnectorListings } from './connector-listings';
import { ConnectionService } from './connection.service';
import { ConnectorsModule } from './connectors.module';
import { PROVIDER_VERIFIERS, type ProviderVerifier } from './providers/provider';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

if (!postgres || !redis) {
  console.warn('SKIPPING binding.service.spec.ts: Postgres or the session Redis is not reachable');
}

const KEY = 'napi_bind0k3m9x2q7w4p8r1t6v5n0b3l7c2y9z4d8f1g6';

const verifier: ProviderVerifier = {
  verify: () =>
    Promise.resolve({
      accountName: 'Acme',
      accountRef: 'org-acme',
      kind: 'verified',
      scopes: ['projects:read'],
    }),
};

const NEON = { databaseName: 'app', parentBranchId: 'br-main', projectId: 'np-1', roleName: 'app' };

describe('BindingService', () => {
  it('binding is org:connectors.manage, which no editor role carries', () => {
    expect(ORG_ROLE_PERMISSIONS.member).not.toContain('org:connectors.manage');
    expect(WORKSPACE_ROLE_PERMISSIONS.editor).not.toContain('org:connectors.manage' as never);
    expect(PROJECT_ROLE_PERMISSIONS.editor).not.toContain('org:connectors.manage' as never);
  });

  describe.skipIf(!postgres || !redis)('against Postgres', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    let connections: ConnectionService;
    let bindings: BindingService;
    let orgId: string;
    let userId: string;
    let projectId: string;
    let since = new Date();
    let resend: ProviderFixture;
    let resendState: ResendState;
    const previousResendUrl = process.env.CONNECTOR_RESEND_API_URL;
    /** An in-memory `OrgCache` with a settable clock, so the one-minute throttle is observable. */
    const cached = new Map<string, { value: string; until: number }>();
    let cacheNow = 0;
    const cache = {
      delete: (key: OrgCacheKey) => Promise.resolve(cached.delete(key.toString())),
      get: (key: OrgCacheKey) => {
        const entry = cached.get(key.toString());
        return Promise.resolve(entry !== undefined && entry.until > cacheNow ? entry.value : null);
      },
      set: (key: OrgCacheKey, value: string, ttlSeconds: number) => {
        cached.set(key.toString(), { until: cacheNow + ttlSeconds * 1000, value });
        return Promise.resolve();
      },
    };

    function inTenant<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantTransaction(orgId, fn);
    }

    const ref = () => ({ orgId, projectId });

    function rows() {
      return inTenant((tx) =>
        tx.select().from(schema.connectorBindings).where(eq(schema.connectorBindings.orgId, orgId)),
      );
    }

    function operations() {
      return inTenant((tx) =>
        tx
          .select()
          .from(schema.connectorOperations)
          .where(eq(schema.connectorOperations.orgId, orgId))
          .orderBy(asc(schema.connectorOperations.createdAt)),
      );
    }

    function audits() {
      return inTenant((tx) =>
        tx
          .select({ action: schema.auditLog.action })
          .from(schema.auditLog)
          .where(and(eq(schema.auditLog.orgId, orgId), gt(schema.auditLog.createdAt, since)))
          .orderBy(asc(schema.auditLog.createdAt)),
      ).then((list) => list.map((row) => row.action));
    }

    beforeAll(async () => {
      resend = await startResendFixture();
      process.env.CONNECTOR_RESEND_API_URL = resend.url;

      moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            ignoreEnvFile: true,
            isGlobal: true,
            validate: validateEnvironment,
          }),
          ClockModule,
          RunProfilesModule,
          CryptoModule,
          DatabaseModule,
          MailModule,
          RedisModule,
          PreviewModule,
          TenancyModule,
          ConnectorsModule,
        ],
      })
        .overrideProvider(PROVIDER_VERIFIERS)
        .useValue(
          new Map([
            ['neon', verifier],
            ['supabase', verifier],
            ['resend', verifier],
          ]),
        )
        .overrideProvider(OrgCache)
        .useValue(cache)
        .compile();
      await moduleRef.init();

      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      transactions = moduleRef.get(TenantTransactionRunner);
      connections = moduleRef.get(ConnectionService, { strict: false });
      bindings = moduleRef.get(BindingService, { strict: false });

      const [user] = await database
        .insert(schema.users)
        .values({ email: `030b-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });

      userId = user!.id;
      orgId = (
        await moduleRef
          .get(OrgService)
          .create(userId, { name: 'Bind', slug: `030b-${randomUUID().slice(0, 8)}` })
      ).id;

      const [workspace] = await inTenant((tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      );

      projectId = (
        await transactions.runInTenantScope({ orgId, userId }, () =>
          moduleRef.get(ProjectService).create({
            actorId: userId,
            name: 'Bind',
            orgId,
            ownerId: userId,
            workspaceId: workspace!.id,
          }),
        )
      ).id;
    }, 60_000);

    afterAll(async () => {
      await database.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
      await database.delete(schema.users).where(eq(schema.users.id, userId));
      await moduleRef?.close();
      await resend?.close();
      process.env.CONNECTOR_RESEND_API_URL = previousResendUrl;
    });

    beforeEach(async () => {
      await inTenant(async (tx) => {
        await tx
          .delete(schema.connectorOperations)
          .where(eq(schema.connectorOperations.orgId, orgId));
        await tx
          .delete(schema.connectorResources)
          .where(eq(schema.connectorResources.orgId, orgId));
        await tx.delete(schema.connectorBindings).where(eq(schema.connectorBindings.orgId, orgId));
        await tx.delete(schema.connections).where(eq(schema.connections.orgId, orgId));
      });
      await inTenant((tx) => connections.connectWithToken(tx, orgId, userId, 'neon', KEY));
      resend.reset();
      resendState = installResendState(resend);
      cached.clear();
      since = new Date();
    });

    it('bind stores the parsed config, enqueues neon_branch_create and audits connector.bound', async () => {
      const binding = await inTenant((tx) => bindings.bind(tx, ref(), userId, 'neon', NEON));

      expect(binding).toMatchObject({ config: NEON, provider: 'neon', state: 'bound' });
      expect(binding.latestOperation).toMatchObject({
        kind: 'neon_branch_create',
        state: 'queued',
      });
      expect(await audits()).toEqual(['connector.bound']);
    });

    it('a body outside the provider schema is refused before anything is written', async () => {
      await expect(
        inTenant((tx) => bindings.bind(tx, ref(), userId, 'neon', { ...NEON, extra: 1 })),
      ).rejects.toThrow();
      expect(await rows()).toHaveLength(0);
    });

    it('one binding per project per provider: a re-bind keeps one row', async () => {
      await inTenant((tx) => bindings.bind(tx, ref(), userId, 'neon', NEON));
      await inTenant(async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.connectorOperations)
          .where(eq(schema.connectorOperations.orgId, orgId));
        await tx
          .update(schema.connectorOperations)
          .set({ finishedAt: new Date(), state: 'succeeded' })
          .where(eq(schema.connectorOperations.id, row!.id));
      });
      await inTenant((tx) =>
        bindings.bind(tx, ref(), userId, 'neon', { ...NEON, projectId: 'np-2' }),
      );

      const list = await rows();

      expect(list).toHaveLength(1);
      expect(list[0]!.config).toMatchObject({ projectId: 'np-2' });
    });

    it('re-bind releases the old resources first: live becomes releasing in the request', async () => {
      const first = await inTenant((tx) => bindings.bind(tx, ref(), userId, 'neon', NEON));

      await inTenant(async (tx) => {
        await tx
          .update(schema.connectorOperations)
          .set({ finishedAt: new Date(), state: 'succeeded' })
          .where(eq(schema.connectorOperations.orgId, orgId));
        await tx.insert(schema.connectorResources).values({
          bindingId: first.id,
          connectionId: first.connectionId,
          externalId: 'br-old',
          kind: 'neon_branch',
          name: `forge-preview-${projectId}`,
          orgId,
          scopeRef: 'np-1',
          state: 'live',
        });
      });
      since = new Date();

      const second = await inTenant((tx) =>
        bindings.bind(tx, ref(), userId, 'neon', { ...NEON, projectId: 'np-2' }),
      );

      expect(second.resources).toEqual([
        { kind: 'neon_branch', name: `forge-preview-${projectId}`, state: 'releasing' },
      ]);
      expect(await audits()).toEqual(['connector.unbound', 'connector.bound']);
      expect((await operations()).at(-1)).toMatchObject({ kind: 'neon_branch_create' });
    });

    it('an unusable connection refuses in < 1 s with the contract reason, writing nothing', async () => {
      await inTenant((tx) =>
        tx
          .update(schema.connections)
          .set({ health: 'needs_reauth' })
          .where(eq(schema.connections.orgId, orgId)),
      );

      const started = performance.now();

      await expect(
        inTenant((tx) => bindings.bind(tx, ref(), userId, 'neon', NEON)),
      ).rejects.toMatchObject({ extensions: { reason: 'needs-reauth' } });
      expect(performance.now() - started).toBeLessThan(1000);
      await expect(
        inTenant((tx) => bindings.bind(tx, ref(), userId, 'supabase', { projectRef: 'abc' })),
      ).rejects.toMatchObject({ extensions: { reason: 'disconnected' } });
      expect(await rows()).toHaveLength(0);
      expect(await operations()).toHaveLength(0);
    });

    it('unbind enqueues resource_release and keeps the row until the release completes', async () => {
      await inTenant((tx) => bindings.bind(tx, ref(), userId, 'neon', NEON));
      await inTenant((tx) =>
        tx
          .update(schema.connectorOperations)
          .set({ finishedAt: new Date(), state: 'succeeded' })
          .where(eq(schema.connectorOperations.orgId, orgId)),
      );

      const operation = await inTenant((tx) => bindings.unbind(tx, ref(), userId, 'neon'));

      expect(operation).toMatchObject({ kind: 'resource_release', state: 'queued' });
      expect(await rows()).toHaveLength(1);
    });

    it('a second reset while one is in flight is 409 in-flight', async () => {
      await inTenant((tx) => bindings.bind(tx, ref(), userId, 'neon', NEON));

      await expect(
        inTenant((tx) => bindings.requestNeonReset(tx, ref(), userId)),
      ).rejects.toMatchObject({ extensions: { reason: 'in-flight' } });
    });

    describe('Resend (US5)', () => {
      async function connectResend(): Promise<string> {
        const connection = await inTenant((tx) =>
          connections.connectWithToken(tx, orgId, userId, 'resend', RESEND_KEY),
        );

        return connection.id;
      }

      it("FR-021: the platform's sending domain is never listed", async () => {
        const connectionId = await connectResend();

        const page = await inTenant((tx) =>
          moduleRef
            .get(ConnectorListings, { strict: false })
            .resendDomains(tx, orgId, connectionId),
        );

        expect(page.items.map((row) => row.id)).toEqual([
          RESEND_VERIFIED_DOMAIN,
          RESEND_PENDING_DOMAIN,
        ]);
        expect(page.items.map((row) => row.name)).not.toContain('forge.dev');
      });

      it("FR-021: the platform's sending domain is never bindable, and nothing is written", async () => {
        await connectResend();

        await expect(
          inTenant((tx) =>
            bindings.bind(tx, ref(), userId, 'resend', { domainId: RESEND_PLATFORM_DOMAIN }),
          ),
        ).rejects.toMatchObject({ status: 404 });
        expect(await rows()).toHaveLength(0);
        expect(await operations()).toHaveLength(0);
      });

      it('a verified domain mints now; the binding stores the domain name', async () => {
        await connectResend();

        const binding = await inTenant((tx) =>
          bindings.bind(tx, ref(), userId, 'resend', { domainId: RESEND_VERIFIED_DOMAIN }),
        );

        expect(binding).toMatchObject({
          config: { domainId: RESEND_VERIFIED_DOMAIN, domainName: 'mail.acme.test' },
          provider: 'resend',
        });
        expect(binding.latestOperation).toMatchObject({ kind: 'resend_key_mint', state: 'queued' });
      });

      it('a pending domain waits: no mint, its status shown; re-read at most once a minute, then minted once', async () => {
        await connectResend();

        const binding = await inTenant((tx) =>
          bindings.bind(tx, ref(), userId, 'resend', { domainId: RESEND_PENDING_DOMAIN }),
        );

        expect(binding).toMatchObject({ domainStatus: 'pending', latestOperation: null });
        expect(await operations()).toHaveLength(0);

        const reads = () =>
          resend.requests.filter((request) => request.path === `/domains/${RESEND_PENDING_DOMAIN}`)
            .length;
        const before = reads();

        resendState.domains.find((row) => row.id === RESEND_PENDING_DOMAIN)!.status = 'verified';
        // Within the minute: the cached status answers, Resend is not asked again.
        await inTenant((tx) => bindings.list(tx, ref()));
        expect(reads()).toBe(before);
        expect(await operations()).toHaveLength(0);

        cacheNow += 61_000;
        const [listed] = await inTenant((tx) => bindings.list(tx, ref()));
        expect(reads()).toBe(before + 1);
        expect(listed).toMatchObject({ domainStatus: 'verified' });
        expect((await operations()).map((row) => row.kind)).toEqual(['resend_key_mint']);

        // A mint is open: listing again requests no second one.
        cacheNow += 61_000;
        await inTenant((tx) => bindings.list(tx, ref()));
        expect(await operations()).toHaveLength(1);
      });
    });
  });
});
