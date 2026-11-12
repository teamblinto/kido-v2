import { ConfigModule } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { ClockModule } from '../../common/clock/clock.module';
import { plaintext } from '../../common/crypto/branded';
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
  PREVIEW_ENV_KEYS,
  PREVIEW_ENV_SOURCE,
  type PreviewEnvSource,
} from '../sandbox/sandbox.constants';
import { OrgService } from '../tenancy/services/org.service';
import { ProjectService } from '../tenancy/services/project.service';
import { TenancyModule } from '../tenancy/tenancy.module';
import { ConnectionService } from './connection.service';
import { ConnectorsModule } from './connectors.module';
import { PreviewEnvModule } from './preview-env.module';
import { PROVIDER_VERIFIERS, type ProviderVerifier } from './providers/provider';
import { ResourceSecrets, type ValueResourceKind } from './resource-secrets';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

if (!postgres || !redis) {
  console.warn(
    'SKIPPING preview-env.source.spec.ts: Postgres or the session Redis is not reachable',
  );
}

/** The org-level credentials: never a preview value (SC-008). */
const NEON_KEY = 'napi_prev0k3m9x2q7w4p8r1t6v5n0b3l7c2y9z4d8f1g6';
const SUPABASE_TOKEN = 'sbp_prev0k3m9x2q7w4p8r1t6v5n0b3l7c2y9z4d8f1g6';

const verifier: ProviderVerifier = {
  verify: () =>
    Promise.resolve({ accountName: 'Acme', accountRef: 'acme', kind: 'verified', scopes: [] }),
};

const URI = 'postgres://app:pw@ep-x-pooler.neon.tech/app?sslmode=require';
const PUBLISHABLE = 'sb_publishable_abc123';

/**
 * Spec 030 contracts/preview-env.md §§ 2–3 (T062): the only path from a connector to a preview.
 * Against Postgres with really sealed values; the source never calls a provider.
 */
describe.skipIf(!postgres || !redis)('PREVIEW_ENV_SOURCE', () => {
  let moduleRef: TestingModule;
  let database: ForgeDatabase;
  let transactions: TenantTransactionRunner;
  let source: PreviewEnvSource;
  let secrets: ResourceSecrets;
  let orgId: string;
  let userId: string;
  let projectId: string;

  function inTenant<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
    return transactions.runInTenantTransaction(orgId, fn);
  }

  const read = () => inTenant((tx) => source(tx, orgId, projectId));

  async function bound(
    provider: 'neon' | 'supabase',
    config: Record<string, unknown>,
    kind: ValueResourceKind,
    value: string,
    state: 'live' | 'provisioning' | 'releasing' = 'live',
  ): Promise<void> {
    await inTenant(async (tx) => {
      const [connection] = await tx
        .select()
        .from(schema.connections)
        .where(eq(schema.connections.provider, provider));
      const [binding] = await tx
        .insert(schema.connectorBindings)
        .values({
          boundBy: userId,
          config,
          connectionId: connection!.id,
          orgId,
          projectId,
          provider,
          state: 'bound',
        })
        .returning();
      const secretId = await secrets.seal(tx, orgId, kind, plaintext(value));

      await tx.insert(schema.connectorResources).values({
        bindingId: binding!.id,
        connectionId: connection!.id,
        kind,
        name: `forge-preview-${projectId}`,
        orgId,
        secretId,
        state,
      });
    });
  }

  beforeAll(async () => {
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
        PreviewEnvModule,
      ],
    })
      .overrideProvider(PROVIDER_VERIFIERS)
      .useValue(
        new Map([
          ['neon', verifier],
          ['cloudflare', verifier],
        ]),
      )
      .compile();
    await moduleRef.init();

    database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
    transactions = moduleRef.get(TenantTransactionRunner);
    source = moduleRef.get<PreviewEnvSource>(PREVIEW_ENV_SOURCE);
    secrets = moduleRef.get(ResourceSecrets, { strict: false });

    const [user] = await database
      .insert(schema.users)
      .values({ email: `030p-${randomUUID()}@example.test`, passwordHash: 'x' })
      .returning({ id: schema.users.id });

    userId = user!.id;
    orgId = (
      await moduleRef
        .get(OrgService)
        .create(userId, { name: 'Prev', slug: `030p-${randomUUID().slice(0, 8)}` })
    ).id;

    const [workspace] = await inTenant((tx) =>
      tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
    );

    projectId = (
      await transactions.runInTenantScope({ orgId, userId }, () =>
        moduleRef.get(ProjectService).create({
          actorId: userId,
          name: 'Prev',
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
  });

  beforeEach(async () => {
    await inTenant(async (tx) => {
      await tx.delete(schema.connectorResources).where(eq(schema.connectorResources.orgId, orgId));
      await tx.delete(schema.connectorBindings).where(eq(schema.connectorBindings.orgId, orgId));
      await tx.delete(schema.connections).where(eq(schema.connections.orgId, orgId));
      await tx.delete(schema.secrets).where(eq(schema.secrets.orgId, orgId));
    });

    const connections = moduleRef.get(ConnectionService, { strict: false });

    await inTenant((tx) => connections.connectWithToken(tx, orgId, userId, 'neon', NEON_KEY));
    // A Supabase connection as a sealed grant, as the OAuth install leaves it.
    await inTenant(async (tx) => {
      const grantId = await secrets.seal(
        tx,
        orgId,
        'supabase_publishable_key',
        plaintext(JSON.stringify({ accessToken: SUPABASE_TOKEN, refreshToken: 'r' })),
      );

      await tx.insert(schema.connections).values({
        accountLogin: 'Acme',
        accountRef: 'acme',
        authType: 'oauth',
        connectedBy: userId,
        grantedScopes: [],
        health: 'healthy',
        orgId,
        provider: 'supabase',
        secretId: grantId,
      });
    });
  });

  it('emits only PREVIEW_ENV_KEYS, with the Supabase aliases', async () => {
    await bound(
      'neon',
      { databaseName: 'app', parentBranchId: 'br', projectId: 'np', roleName: 'app' },
      'neon_branch',
      URI,
    );
    await bound('supabase', { projectRef: 'abcref' }, 'supabase_publishable_key', PUBLISHABLE);

    const env = await read();

    expect(
      Object.keys(env).every((key) => (PREVIEW_ENV_KEYS as readonly string[]).includes(key)),
    ).toBe(true);
    expect(env).toEqual({
      DATABASE_URL: URI,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: PUBLISHABLE,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
      NEXT_PUBLIC_SUPABASE_URL: 'https://abcref.supabase.co',
      SUPABASE_ANON_KEY: PUBLISHABLE,
      SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
      SUPABASE_URL: 'https://abcref.supabase.co',
      VITE_SUPABASE_ANON_KEY: PUBLISHABLE,
      VITE_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
      VITE_SUPABASE_URL: 'https://abcref.supabase.co',
    });
  });

  it('no org-level credential ever appears', async () => {
    await bound(
      'neon',
      { databaseName: 'app', parentBranchId: 'br', projectId: 'np', roleName: 'app' },
      'neon_branch',
      URI,
    );

    const text = JSON.stringify(await read());

    expect(text).not.toContain(NEON_KEY);
    expect(text).not.toContain(SUPABASE_TOKEN);
  });

  it('a needs_reauth connection contributes nothing', async () => {
    await bound(
      'neon',
      { databaseName: 'app', parentBranchId: 'br', projectId: 'np', roleName: 'app' },
      'neon_branch',
      URI,
    );
    await inTenant((tx) =>
      tx
        .update(schema.connections)
        .set({ health: 'needs_reauth' })
        .where(eq(schema.connections.provider, 'neon')),
    );

    expect(await read()).toEqual({});
  });

  it.each(['provisioning', 'releasing'] as const)(
    'a %s resource contributes nothing',
    async (state) => {
      await bound(
        'neon',
        { databaseName: 'app', parentBranchId: 'br', projectId: 'np', roleName: 'app' },
        'neon_branch',
        URI,
        state,
      );

      expect(await read()).toEqual({});
    },
  );

  it('a multi-line or oversized value is dropped', async () => {
    await bound(
      'neon',
      { databaseName: 'app', parentBranchId: 'br', projectId: 'np', roleName: 'app' },
      'neon_branch',
      `${URI}\nFORGE_CALLBACK_URL=https://evil.example`,
    );
    await bound('supabase', { projectRef: 'abcref' }, 'supabase_publishable_key', 'k'.repeat(4097));

    const env = await read();

    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.SUPABASE_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.VITE_SUPABASE_PUBLISHABLE_KEY).toBeUndefined();
  });

  it('any failure yields {} for that binding, and the rest still arrive', async () => {
    // A secret that does not open under its purpose: sealed as another kind.
    await bound(
      'neon',
      { databaseName: 'app', parentBranchId: 'br', projectId: 'np', roleName: 'app' },
      'neon_branch',
      URI,
    );
    await inTenant(async (tx) => {
      const wrong = await secrets.seal(tx, orgId, 'resend_sending_key', plaintext(URI));

      await tx
        .update(schema.connectorResources)
        .set({ secretId: wrong })
        .where(eq(schema.connectorResources.kind, 'neon_branch'));
    });
    await bound('supabase', { projectRef: 'abcref' }, 'supabase_publishable_key', PUBLISHABLE);

    const env = await read();

    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.SUPABASE_URL).toBe('https://abcref.supabase.co');
  });

  it('a failure outside any binding yields {}', async () => {
    await expect(inTenant((tx) => source(tx, orgId, 'not-a-uuid'))).resolves.toEqual({});
  });
});
