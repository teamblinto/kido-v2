import { ConfigModule } from '@nestjs/config';
import type { ConfigService } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { type ConnectorResource, schema } from '@repo/db';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import {
  installNeonBranches,
  NEON_PROJECT,
  type NeonBranchState,
} from '../../../test/fixtures/neon-branches';
import {
  NEON_KEY,
  type ProviderFixture,
  startNeonFixture,
  startSupabaseFixture,
  type SupabaseFixture,
} from '../../../test/fixtures/provider-fixtures';
import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { ClockModule } from '../../common/clock/clock.module';
import { plaintext, revealPlaintext } from '../../common/crypto/branded';
import { CryptoModule } from '../../common/crypto/crypto.module';
import { DekService } from '../../common/crypto/dek.service';
import { RedisModule } from '../../common/redis/redis.module';
import { RunProfilesModule } from '../../common/run-profiles/run-profiles.module';
import { type Environment, validateEnvironment } from '../../config/environment';
import { APP_DATABASE } from '../../database/database.constants';
import { DatabaseModule } from '../../database/database.module';
import type { ForgeDatabase, TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { AuditService } from '../audit/audit.service';
import { MailModule } from '../mail/mail.module';
import type { Envelope } from '../outbox/envelope';
import { OutboxWriter } from '../outbox/outbox-writer';
import { PreviewModule } from '../preview/preview.module';
import { OrgService } from '../tenancy/services/org.service';
import { ProjectService } from '../tenancy/services/project.service';
import { TenancyModule } from '../tenancy/tenancy.module';
import { BindingRepository } from './binding.repository';
import { BindingService } from './binding.service';
import {
  ConnectionRemoveHandler,
  type ResourceReleaser,
  type ResourceReleasers,
} from './connection-remove.handler';
import { ConnectionRepository } from './connection.repository';
import { ConnectionService, credentialPurpose } from './connection.service';
import {
  ConnectorOpsConsumer,
  type OperationHandler,
  type OperationHandlers,
} from './connector-ops.consumer';
import { ConnectorsModule } from './connectors.module';
import { OperationRepository } from './operation.repository';
import {
  BindingReleaseHandler,
  NeonBranchHandler,
  NeonBranchReleaser,
  previewBranchName,
  SupabaseKeyHandler,
  SupabaseKeyReleaser,
} from './preview-resource.handlers';
import { NeonClient } from './providers/neon/neon.client';
import { PROVIDER_VERIFIERS, type ProviderVerifier } from './providers/provider';
import { SupabaseClient } from './providers/supabase/supabase.client';
import { ResourceReleaseHandler } from './resource-release.handler';
import { ResourceRepository } from './resource.repository';
import { ResourceSecrets } from './resource-secrets';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

if (!postgres || !redis) {
  console.warn(
    'SKIPPING preview-resource.handlers.spec.ts: Postgres or the session Redis is not reachable',
  );
}

const verifier: ProviderVerifier = {
  verify: () =>
    Promise.resolve({ accountName: 'Acme', accountRef: 'org', kind: 'verified', scopes: [] }),
};

const NEON = {
  databaseName: 'neondb',
  parentBranchId: 'br-main',
  projectId: NEON_PROJECT,
  roleName: 'neondb_owner',
};

/**
 * Spec 030 T066 (US3): the Neon branch, Supabase key and release handlers dispatched by the real
 * `ConnectorOpsConsumer`, against Postgres and the providers' `node:http` fixtures.
 */
describe.skipIf(!postgres || !redis)('US3 operation handlers', () => {
  let moduleRef: TestingModule;
  let database: ForgeDatabase;
  let transactions: TenantTransactionRunner;
  let consumer: ConnectorOpsConsumer;
  let bindings: BindingService;
  let neonFixture: ProviderFixture;
  let supabaseFixture: SupabaseFixture;
  let branches: NeonBranchState;
  let orgId: string;
  let userId: string;
  let projectId: string;
  /** Wraps a handler so a test can crash it after its provider call. */
  let crashAfterCreate = false;

  const ref = () => ({ orgId, projectId });

  function inTenant<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
    return transactions.runInTenantTransaction(orgId, fn);
  }

  function event(operationId: string): Envelope<'connector.op.requested'> {
    return {
      aggregate: 'connector-operation',
      aggregateId: operationId,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      orgId,
      payload: { operationId, orgId },
      traceId: null,
      type: 'connector.op.requested',
    };
  }

  async function run(operationId: string, attempt = 1): Promise<void> {
    const job = await inTenant((tx) => consumer.handle(event(operationId), tx));

    await consumer.effect(event(operationId), job, attempt);
  }

  function operations() {
    return inTenant((tx) =>
      tx
        .select()
        .from(schema.connectorOperations)
        .where(eq(schema.connectorOperations.orgId, orgId))
        .orderBy(schema.connectorOperations.createdAt),
    );
  }

  const latest = async () => (await operations()).at(-1)!;

  function resources() {
    return inTenant((tx) =>
      tx
        .select()
        .from(schema.connectorResources)
        .where(eq(schema.connectorResources.orgId, orgId))
        .orderBy(schema.connectorResources.createdAt),
    );
  }

  function connection(provider: 'neon' | 'supabase') {
    return inTenant((tx) =>
      tx
        .select()
        .from(schema.connections)
        .where(and(eq(schema.connections.orgId, orgId), eq(schema.connections.provider, provider)))
        .then((rows) => rows[0]),
    );
  }

  async function openValue(secretId: string, kind: 'neon_branch' | 'supabase_publishable_key') {
    const value = await inTenant((tx) =>
      moduleRef.get(ResourceSecrets, { strict: false }).open(tx, orgId, kind, secretId),
    );

    return revealPlaintext(value!).toString('utf8');
  }

  beforeAll(async () => {
    neonFixture = await startNeonFixture();
    supabaseFixture = await startSupabaseFixture();

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
      .useValue(new Map([['neon', verifier]]))
      .compile();
    await moduleRef.init();

    database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
    transactions = moduleRef.get(TenantTransactionRunner);
    bindings = moduleRef.get(BindingService, { strict: false });

    const neon = new NeonClient({ get: () => neonFixture.url } as unknown as ConfigService<
      Environment,
      true
    >);
    neon.awaitTimings = { budgetMs: 200, intervalMs: 5 };
    const supabase = new SupabaseClient({
      get: (key: string) => (key === 'SUPABASE_API_URL' ? supabaseFixture.url : undefined),
    } as unknown as ConfigService<Environment, true>);
    const connections = moduleRef.get(ConnectionService, { strict: false });
    const resourceRepo = moduleRef.get(ResourceRepository, { strict: false });
    const secrets = moduleRef.get(ResourceSecrets, { strict: false });
    const audit = moduleRef.get(AuditService, { strict: false });
    const clock = moduleRef.get<ClockPort>(CLOCK);
    const releasers: ResourceReleasers = new Map<ConnectorResource['kind'], ResourceReleaser>([
      ['neon_branch', new NeonBranchReleaser(neon)],
      ['supabase_publishable_key', new SupabaseKeyReleaser()],
    ]);
    const neonHandler = new NeonBranchHandler(neon, resourceRepo, secrets, audit, clock);
    const crashing: OperationHandler = {
      async run(context) {
        if (crashAfterCreate) {
          crashAfterCreate = false;
          await neon.createBranch(
            context.credential,
            NEON_PROJECT,
            'br-main',
            previewBranchName(projectId),
          );
          throw new Error('worker crashed');
        }

        await neonHandler.run(context);
      },
    };
    const handlers: OperationHandlers = new Map<
      Parameters<OperationHandlers['get']>[0],
      OperationHandler
    >([
      ['neon_branch_create', crashing],
      ['neon_branch_reset', neonHandler],
      [
        'supabase_key_fetch',
        new SupabaseKeyHandler(supabase, connections, resourceRepo, secrets, audit, clock),
      ],
      [
        'resource_release',
        new BindingReleaseHandler(
          new ResourceReleaseHandler(resourceRepo, clock, releasers),
          resourceRepo,
          secrets,
          new BindingRepository(),
        ),
      ],
      [
        'connection_remove',
        new ConnectionRemoveHandler(connections, resourceRepo, clock, releasers),
      ],
    ]);

    consumer = new ConnectorOpsConsumer(
      new OperationRepository(),
      connections,
      transactions,
      clock,
      handlers,
      moduleRef.get(OutboxWriter, { strict: false }),
    );

    const [user] = await database
      .insert(schema.users)
      .values({ email: `030h-${randomUUID()}@example.test`, passwordHash: 'x' })
      .returning({ id: schema.users.id });

    userId = user!.id;
    orgId = (
      await moduleRef
        .get(OrgService)
        .create(userId, { name: 'Handlers', slug: `030h-${randomUUID().slice(0, 8)}` })
    ).id;

    const [workspace] = await inTenant((tx) =>
      tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
    );

    projectId = (
      await transactions.runInTenantScope({ orgId, userId }, () =>
        moduleRef.get(ProjectService).create({
          actorId: userId,
          name: 'Handlers',
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
    await neonFixture?.close();
    await supabaseFixture?.close();
  });

  beforeEach(async () => {
    neonFixture.reset();
    supabaseFixture.reset();
    branches = installNeonBranches(neonFixture);
    crashAfterCreate = false;

    await inTenant(async (tx) => {
      await tx
        .delete(schema.connectorOperations)
        .where(eq(schema.connectorOperations.orgId, orgId));
      await tx.delete(schema.connectorResources).where(eq(schema.connectorResources.orgId, orgId));
      await tx.delete(schema.connectorBindings).where(eq(schema.connectorBindings.orgId, orgId));
      await tx.delete(schema.connections).where(eq(schema.connections.orgId, orgId));
      await tx.delete(schema.secrets).where(eq(schema.secrets.orgId, orgId));
    });
    await inTenant((tx) =>
      moduleRef
        .get(ConnectionService, { strict: false })
        .connectWithToken(tx, orgId, userId, 'neon', NEON_KEY),
    );
    // A Supabase grant whose access token the fixture accepts, fresh for an hour.
    await inTenant(async (tx) => {
      const purpose = credentialPurpose('supabase');
      const sealed = await moduleRef
        .get(DekService)
        .sealSecret(
          tx,
          orgId,
          purpose,
          plaintext(JSON.stringify({ accessToken: supabaseFixture.token, refreshToken: 'r' })),
        );
      const secretId = await moduleRef
        .get(ConnectionRepository, { strict: false })
        .insertSecret(tx, orgId, purpose, sealed);

      await tx.insert(schema.connections).values({
        accountLogin: 'Acme',
        accountRef: 'sb-org-1',
        authType: 'oauth',
        connectedBy: userId,
        grantedScopes: [],
        health: 'healthy',
        orgId,
        provider: 'supabase',
        secretId,
        tokenExpiresAt: new Date(Date.now() + 3_600_000),
      });
    });
  });

  async function bindNeon(): Promise<string> {
    await inTenant((tx) => bindings.bind(tx, ref(), userId, 'neon', NEON));

    return (await latest()).id;
  }

  const ours = () => branches.branches.filter((row) => row.name === previewBranchName(projectId));

  it('neon_branch_create makes the branch, seals its pooled URI and goes live', async () => {
    const id = await bindNeon();

    await run(id);

    expect(await latest()).toMatchObject({ id, state: 'succeeded' });
    const [row] = await resources();
    expect(row).toMatchObject({ externalId: 'br-new-1', kind: 'neon_branch', state: 'live' });
    expect(await openValue(row!.secretId!, 'neon_branch')).toContain('br-new-1-pooler');
  });

  it('a crash after the create, re-run: one branch, adopted', async () => {
    const id = await bindNeon();

    crashAfterCreate = true;
    await expect(run(id)).rejects.toThrow('worker crashed');
    // The consumer closed it; the retry is a fresh request of the same work.
    await inTenant((tx) =>
      tx
        .update(schema.connectorOperations)
        .set({ finishedAt: null, reason: null, state: 'queued' })
        .where(eq(schema.connectorOperations.id, id)),
    );
    await run(id, 2);

    expect(ours()).toHaveLength(1);
    expect(branches.created).toBe(1);
    expect((await resources())[0]).toMatchObject({ externalId: ours()[0]!.id, state: 'live' });
  });

  it('neon_branch_reset: same name, new id, the same row live → provisioning → live', async () => {
    await run(await bindNeon());
    const [before] = await resources();

    const reset = await inTenant((tx) => bindings.requestNeonReset(tx, ref(), userId));

    await run(reset.id);

    const after = await resources();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: before!.id, name: before!.name, state: 'live' });
    expect(after[0]!.externalId).not.toBe(before!.externalId);
    expect(ours()).toHaveLength(1);
  });

  it('a 403 on create fails missing-scope and the connection becomes needs_reauth (FR-003)', async () => {
    const id = await bindNeon();

    branches.next = { answer: { body: { message: 'forbidden' }, status: 403 }, method: 'POST' };
    await run(id);

    expect(await latest()).toMatchObject({ reason: 'missing-scope', state: 'failed' });
    expect((await connection('neon'))!.health).toBe('needs_reauth');
    expect((await resources())[0]).toMatchObject({ state: 'failed' });
  });

  it('supabase_key_fetch seals the publishable key', async () => {
    supabaseFixture.route('GET', '/v1/projects/:ref/api-keys', () => ({
      body: [
        { api_key: 'eyJanon', name: 'anon', type: 'legacy' },
        { api_key: 'sb_publishable_live', name: 'default', type: 'publishable' },
      ],
      status: 200,
    }));
    await inTenant((tx) => bindings.bind(tx, ref(), userId, 'supabase', { projectRef: 'abcref' }));

    await run((await latest()).id);

    expect(await latest()).toMatchObject({ state: 'succeeded' });
    const [row] = await resources();
    expect(row).toMatchObject({ kind: 'supabase_publishable_key', state: 'live' });
    expect(await openValue(row!.secretId!, 'supabase_publishable_key')).toBe('sb_publishable_live');
  });

  it('resource_release on unbind deletes the Neon branch and releases the Supabase key', async () => {
    supabaseFixture.route('GET', '/v1/projects/:ref/api-keys', () => ({
      body: [{ api_key: 'sb_publishable_live', name: 'default', type: 'publishable' }],
      status: 200,
    }));
    await run(await bindNeon());
    await inTenant((tx) => bindings.bind(tx, ref(), userId, 'supabase', { projectRef: 'abcref' }));
    await run((await latest()).id);

    const neonRelease = await inTenant((tx) => bindings.unbind(tx, ref(), userId, 'neon'));
    await run(neonRelease.id);
    const supabaseRelease = await inTenant((tx) => bindings.unbind(tx, ref(), userId, 'supabase'));
    await run(supabaseRelease.id);

    expect(ours()).toHaveLength(0);
    expect((await resources()).map((row) => [row.state, row.secretId])).toEqual([
      ['released', null],
      ['released', null],
    ]);
    // The row goes when its release completes (contracts/bindings.md § 2).
    expect(await inTenant((tx) => bindings.list(tx, ref()))).toEqual([]);
  });

  it('a removal requested while a create runs releases what the create made', async () => {
    const id = await bindNeon();

    await run(id);
    const neon = (await connection('neon'))!;
    const removal = (
      await inTenant((tx) =>
        moduleRef
          .get(ConnectionService, { strict: false })
          .requestRemoval(tx, orgId, userId, neon.id),
      )
    ).id;

    await run(removal);

    expect(ours()).toHaveLength(0);
    expect((await resources())[0]).toMatchObject({ secretId: null, state: 'released' });
    // T076: the branch URI's sealed value went with the connection.
    const purposes = await inTenant((tx) =>
      tx.select({ purpose: schema.secrets.purpose }).from(schema.secrets),
    );
    expect(purposes.map((row) => row.purpose)).not.toContain('connector:neon:branch-uri');
  });

  it('an operation still queued when its connection is removed fails disconnected without a provider call', async () => {
    const id = await bindNeon();
    const neon = (await connection('neon'))!;
    const removal = (
      await inTenant((tx) =>
        moduleRef
          .get(ConnectionService, { strict: false })
          .requestRemoval(tx, orgId, userId, neon.id),
      )
    ).id;

    await run(removal);
    const calls = neonFixture.requests.length;
    await run(id);

    expect(neonFixture.requests.length).toBe(calls);
    expect((await operations()).find((row) => row.id === id)).toMatchObject({
      reason: 'disconnected',
      state: 'failed',
    });
  });
});
