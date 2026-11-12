import { ConfigModule } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { and, asc, eq, gt } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { ClockModule } from '../../common/clock/clock.module';
import { plaintext, revealPlaintext } from '../../common/crypto/branded';
import { CryptoModule } from '../../common/crypto/crypto.module';
import { RedisModule } from '../../common/redis/redis.module';
import { RunProfilesModule } from '../../common/run-profiles/run-profiles.module';
import { validateEnvironment } from '../../config/environment';
import { APP_DATABASE } from '../../database/database.constants';
import { DatabaseModule } from '../../database/database.module';
import type { ForgeDatabase, TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { MemoryObjectStore } from '../../common/object-store/memory-object-store';
import type { Environment } from '../../config/environment';
import { upload } from '../deploy/artifact';
import { DeploymentRepository } from '../deploy/deployment.repository';
import { ReleaseReader } from '../deploy/release-reader';
import { MailModule } from '../mail/mail.module';
import { RetryableFailure } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import { OutboxWriter } from '../outbox/outbox-writer';
import { PreviewModule } from '../preview/preview.module';
import { OrgService } from '../tenancy/services/org.service';
import { ProjectService } from '../tenancy/services/project.service';
import { TenancyModule } from '../tenancy/tenancy.module';
import {
  NETLIFY_TOKEN,
  type NetlifyFixture,
  type ProviderFixture,
  RESEND_KEY,
  startNetlifyFixture,
  startResendFixture,
} from '../../../test/fixtures/provider-fixtures';
import {
  installResendState,
  RESEND_VERIFIED_DOMAIN,
  type ResendState,
} from '../../../test/fixtures/resend-state';
import { BindingService } from './binding.service';
import { ResourceSecrets } from './resource-secrets';
import { BindingRepository } from './binding.repository';
import { ConnectionService } from './connection.service';
import {
  CONNECTOR_OPS_QUEUE,
  ConnectorOpsConsumer,
  type OperationHandler,
  type OperationHandlers,
  OperationFailure,
} from './connector-ops.consumer';
import { ConnectorsModule } from './connectors.module';
import { NetlifyPublishHandler, publishTitle } from './netlify-publish.handler';
import { OperationRepository } from './operation.repository';
import { NetlifyClient } from './providers/netlify/netlify.client';
import type { ConfigService } from '@nestjs/config';
import { PROVIDER_VERIFIERS, ProviderFailure, type ProviderVerifier } from './providers/provider';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

if (!postgres || !redis) {
  console.warn(
    'SKIPPING connector-ops.consumer.spec.ts: Postgres or the session Redis is not reachable',
  );
}

const KEY = 'napi_ops0k3m9x2q7w4p8r1t6v5n0b3l7c2y9z4d8f1g6';

const verifier: ProviderVerifier = {
  verify: () =>
    Promise.resolve({
      accountName: 'Acme',
      accountRef: 'org-acme',
      kind: 'verified',
      scopes: ['projects:read'],
    }),
};

/** A handler scripted per test: what it saw, and what it does. */
const seen: { credential: string; operationId: string }[] = [];
let behaviour: () => Promise<void> = () => Promise.resolve();

const scripted: OperationHandler = {
  async run(context) {
    seen.push({
      credential: revealPlaintext(context.credential).toString('utf8'),
      operationId: context.operation.id,
    });
    await behaviour();
  },
};

/**
 * Spec 030 R5, R15, §10: the ops consumer against Postgres with a real `ConnectionService` and a
 * scripted handler — the dispatch by kind, the retry classification, the terminal mapping, and the
 * connection's health after every provider call (SC-007).
 */
describe('ConnectorOpsConsumer', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and a real ConnectionService', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    let connections: ConnectionService;
    let consumer: ConnectorOpsConsumer;
    let orgId: string;
    let userId: string;
    let projects: string[];
    let auditSince = new Date();
    /** One binding per project and provider: each test starts again from the first project. */
    let next = 0;
    let netlify: NetlifyFixture;
    const store = new MemoryObjectStore();
    const publishProgress: { externalRef?: string; providerState?: string }[] = [];
    /** Every blob key the publish read, in order. */
    const blobReads: string[] = [];

    function inTenant<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantTransaction(orgId, fn);
    }

    function connection() {
      return inTenant((tx) =>
        tx
          .select()
          .from(schema.connections)
          .where(and(eq(schema.connections.orgId, orgId), eq(schema.connections.provider, 'neon')))
          .then((rows) => rows[0]!),
      );
    }

    function operation(id: string) {
      return inTenant((tx) => new OperationRepository().byId(tx, orgId, id));
    }

    function auditActions() {
      return inTenant((tx) =>
        tx
          .select({ action: schema.auditLog.action })
          .from(schema.auditLog)
          .where(and(eq(schema.auditLog.orgId, orgId), gt(schema.auditLog.createdAt, auditSince)))
          .orderBy(asc(schema.auditLog.createdAt)),
      ).then((rows) => rows.map((row) => row.action));
    }

    /** One bound Neon project and a queued `neon_branch_create` on it, ids only on the event. */
    async function queued(
      kind: 'neon_branch_create' | 'supabase_key_fetch' = 'neon_branch_create',
    ) {
      const conn = await connection();

      return inTenant(async (tx) => {
        const [binding] = await tx
          .insert(schema.connectorBindings)
          .values({
            boundBy: userId,
            config: {},
            connectionId: conn.id,
            orgId,
            projectId: projects[next++]!,
            provider: 'neon',
            state: 'bound',
          })
          .returning();
        const row = await new OperationRepository().insertQueued(tx, {
          bindingId: binding!.id,
          kind,
          orgId,
          projectId: binding!.projectId,
          requestedBy: userId,
        });

        return row.id;
      });
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
        ],
      })
        .overrideProvider(PROVIDER_VERIFIERS)
        .useValue(
          new Map([
            ['neon', verifier],
            ['netlify', verifier],
          ]),
        )
        .compile();
      await moduleRef.init();

      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      transactions = moduleRef.get(TenantTransactionRunner);
      connections = moduleRef.get(ConnectionService, { strict: false });

      netlify = await startNetlifyFixture();
      const progressRows = new OperationRepository();
      const setProgress = progressRows.setProgress.bind(progressRows);
      progressRows.setProgress = (tx, org, id, progress) => {
        publishProgress.push(progress);
        return setProgress(tx, org, id, progress);
      };
      const get = store.get.bind(store);
      store.get = (key) => {
        if (key.includes('/blobs/')) blobReads.push(key);
        return get(key);
      };
      const publish = new NetlifyPublishHandler(
        new NetlifyClient({ get: () => netlify.url } as unknown as ConfigService<
          Environment,
          true
        >),
        new ReleaseReader(new DeploymentRepository(), store),
        new BindingRepository(),
        progressRows,
      );
      publish.pollTimings = { budgetMs: 5_000, intervalMs: 0 };

      const handlers: OperationHandlers = new Map<
        Parameters<OperationHandlers['get']>[0],
        OperationHandler
      >([
        ['neon_branch_create', scripted],
        ['netlify_publish', publish],
      ]);

      consumer = new ConnectorOpsConsumer(
        new OperationRepository(),
        connections,
        transactions,
        moduleRef.get<ClockPort>(CLOCK),
        handlers,
        moduleRef.get(OutboxWriter, { strict: false }),
      );

      const [user] = await database
        .insert(schema.users)
        .values({ email: `030o-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });

      userId = user!.id;
      orgId = (
        await moduleRef
          .get(OrgService)
          .create(userId, { name: 'Ops', slug: `030o-${randomUUID().slice(0, 8)}` })
      ).id;

      const [workspace] = await inTenant((tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      );

      projects = [];
      for (let n = 0; n < 8; n++) {
        projects.push(
          (
            await transactions.runInTenantScope({ orgId, userId }, () =>
              moduleRef.get(ProjectService).create({
                actorId: userId,
                name: `Ops ${String(n)}`,
                orgId,
                ownerId: userId,
                workspaceId: workspace!.id,
              }),
            )
          ).id,
        );
      }
    }, 60_000);

    afterAll(async () => {
      await netlify?.close();
      await database.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
      await database.delete(schema.users).where(eq(schema.users.id, userId));
      await moduleRef?.close();
    });

    beforeEach(async () => {
      seen.length = 0;
      next = 0;
      netlify.reset();
      publishProgress.length = 0;
      blobReads.length = 0;
      behaviour = () => Promise.resolve();
      await inTenant(async (tx) => {
        await tx.delete(schema.connectorBindings).where(eq(schema.connectorBindings.orgId, orgId));
        await tx.delete(schema.connections).where(eq(schema.connections.orgId, orgId));
        await tx.delete(schema.secrets).where(eq(schema.secrets.orgId, orgId));
      });
      await inTenant((tx) => connections.connectWithToken(tx, orgId, userId, 'neon', KEY));
      auditSince = new Date();
    });

    it('runs on connector.ops in the events profile, eight at a time', () => {
      expect(consumer.queue).toBe(CONNECTOR_OPS_QUEUE);
      expect(CONNECTOR_OPS_QUEUE).toBe('connector.ops');
      expect(consumer.profile).toBe('events');
      expect(consumer.concurrency).toBe(8);
      expect(consumer.types).toEqual(['connector.op.requested']);
    });

    it('dispatches by kind with the opened credential, and closes the operation succeeded', async () => {
      const id = await queued();

      await run(id);

      expect(seen).toEqual([{ credential: KEY, operationId: id }]);
      expect(await operation(id)).toMatchObject({ reason: null, state: 'succeeded' });
      expect((await connection()).health).toBe('healthy');
    });

    it('a succeeded value-changing kind tells the project to refresh its preview env, in the settle transaction', async () => {
      const envChanges = async (projectId: string) =>
        (
          await database
            .select({ payload: schema.outbox.payload })
            .from(schema.outbox)
            .where(
              and(
                eq(schema.outbox.type, 'project.env.changed'),
                eq(schema.outbox.aggregateId, projectId),
              ),
            )
        ).map((row) => row.payload);
      const ok = await queued();
      const okProject = (await operation(ok))!.projectId!;
      // The projects are shared across this suite's tests: count what this run adds.
      const before = (await envChanges(okProject)).length;

      await run(ok);
      const after = await envChanges(okProject);
      expect(after).toHaveLength(before + 1);
      expect(after.at(-1)).toEqual({ orgId, projectId: okProject });

      behaviour = () => Promise.reject(new OperationFailure('disconnected'));
      const refused = await queued();
      const refusedProject = (await operation(refused))!.projectId!;
      const refusedBefore = (await envChanges(refusedProject)).length;
      await run(refused);
      expect(await envChanges(refusedProject)).toHaveLength(refusedBefore);
    });

    it('a kind with no handler closes failed as provider-unavailable without calling anything', async () => {
      const id = await queued('supabase_key_fetch');

      await run(id);

      expect(seen).toEqual([]);
      expect(await operation(id)).toMatchObject({
        reason: 'provider-unavailable',
        state: 'failed',
      });
    });

    it('an operation already closed is left alone', async () => {
      const id = await queued();

      await run(id);
      await run(id);

      expect(seen).toHaveLength(1);
    });

    it('a retryable failure retries while attempts remain and closes as the reason on the last', async () => {
      const id = await queued();

      behaviour = () => Promise.reject(new ProviderFailure('rate-limited', 30));

      await expect(run(id, 1)).rejects.toBeInstanceOf(RetryableFailure);
      expect(await operation(id)).toMatchObject({ state: 'running' });

      await expect(run(id, consumer.attempts)).resolves.toBeUndefined();
      expect(await operation(id)).toMatchObject({ reason: 'rate-limited', state: 'failed' });
    });

    it.each([
      [new ProviderFailure('quota-exceeded'), 'quota-exceeded'],
      [new ProviderFailure('not-found'), 'not-found'],
      [new ProviderFailure('validation'), 'provider-refused'],
      [new ProviderFailure('conflict'), 'provider-refused'],
      [new OperationFailure('site-gone'), 'site-gone'],
    ] as const)(
      'a terminal %s closes the operation as %s on first sight',
      async (failure, reason) => {
        const id = await queued();

        behaviour = () => Promise.reject(failure);

        await expect(run(id, 1)).resolves.toBeUndefined();
        expect(await operation(id)).toMatchObject({ reason, state: 'failed' });
        expect((await connection()).health).toBe('healthy');
      },
    );

    it('a revoked credential during a Neon create turns the connection needs_reauth in that job, audited once', async () => {
      const id = await queued();

      behaviour = () => Promise.reject(new ProviderFailure('unauthorized'));

      await run(id);

      expect(await operation(id)).toMatchObject({ reason: 'needs-reauth', state: 'failed' });
      expect((await connection()).health).toBe('needs_reauth');
      await expect(auditActions()).resolves.toEqual(['connector.health-changed']);

      // The next operation is refused from the row without a provider call.
      const next = await queued();

      await run(next);
      expect(seen).toHaveLength(1);
      expect(await operation(next)).toMatchObject({ reason: 'needs-reauth', state: 'failed' });
    });

    it('a credential short of a permission turns the connection needs_reauth, the operation missing-scope', async () => {
      const id = await queued();

      behaviour = () => Promise.reject(new ProviderFailure('forbidden-scope'));

      await run(id);

      expect(await operation(id)).toMatchObject({ reason: 'missing-scope', state: 'failed' });
      expect((await connection()).health).toBe('needs_reauth');
    });

    it('SC-007: five consecutive 503s open the circuit, and the next use is refused at once', async () => {
      behaviour = () => Promise.reject(new ProviderFailure('unavailable'));

      for (let n = 0; n < 5; n++) {
        await run(await queued(), consumer.attempts);
      }

      const opened = await connection();

      expect(opened.health).toBe('unavailable');
      expect(opened.circuitOpenUntil?.getTime()).toBeGreaterThan(Date.now());
      await expect(auditActions()).resolves.toEqual(['connector.health-changed']);

      await expect(
        inTenant((tx) => connections.ensureUsable(tx, orgId, 'neon')),
      ).rejects.toMatchObject({
        extensions: { reason: 'provider-unavailable' },
        type: 'service-unavailable',
      });

      const next = await queued();

      await expect(run(next, 1)).rejects.toBeInstanceOf(RetryableFailure);
      expect(seen).toHaveLength(5);

      // A success after the window closes the circuit and marks the row healthy again.
      await inTenant((tx) =>
        tx
          .update(schema.connections)
          .set({ circuitOpenUntil: new Date(Date.now() - 1_000) })
          .where(eq(schema.connections.orgId, orgId)),
      );
      behaviour = () => Promise.resolve();
      await run(next, 2);

      expect(await connection()).toMatchObject({ failureCount: 0, health: 'healthy' });
    });

    // ─── netlify_publish (spec 030 T081, research R11) ─────────────────────────────────────────

    const RELEASE = [
      { body: Buffer.from('<h1>release</h1>'), path: 'index.html' },
      { body: Buffer.from('console.log("app")'), path: 'assets/app.js' },
      // The same bytes twice: one blob, hashed once.
      { body: Buffer.from('console.log("app")'), path: 'assets/copy.js' },
      { body: Buffer.from('body{}'), path: 'assets/style.css' },
    ];

    function sha1(body: Buffer): string {
      return createHash('sha1').update(body).digest('hex');
    }

    /** A succeeded release in the store, a bound Netlify site, and a queued publish of it. */
    async function queuedPublish(): Promise<string> {
      await inTenant((tx) =>
        connections.connectWithToken(tx, orgId, userId, 'netlify', NETLIFY_TOKEN),
      );
      const projectId = projects[next++]!;
      const { artifactSha } = await upload(store, orgId, projectId, RELEASE);

      return inTenant(async (tx) => {
        const [conn] = await tx
          .select()
          .from(schema.connections)
          .where(
            and(eq(schema.connections.orgId, orgId), eq(schema.connections.provider, 'netlify')),
          );
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
        const [deployment] = await tx
          .insert(schema.deployments)
          .values({
            artifactSha,
            checkpointId: checkpoint!.id,
            finishedAt: new Date(),
            orgId,
            projectId,
            requestedBy: userId,
            startedAt: new Date(),
            state: 'succeeded',
            template: 'vite-react',
          })
          .returning({ id: schema.deployments.id });
        const [binding] = await tx
          .insert(schema.connectorBindings)
          .values({
            boundBy: userId,
            config: {
              siteId: 'site-1',
              siteName: 'acme-site',
              siteUrl: 'https://acme-site.netlify.app',
            },
            connectionId: conn!.id,
            orgId,
            projectId,
            provider: 'netlify',
            state: 'bound',
          })
          .returning();
        const row = await new OperationRepository().insertQueued(tx, {
          bindingId: binding!.id,
          deploymentId: deployment!.id,
          kind: 'netlify_publish',
          orgId,
          projectId,
          requestedBy: userId,
        });

        return row.id;
      });
    }

    it('publishes a release: each blob hashed once, only required digests uploaded, ready → succeeded', async () => {
      // Netlify already holds the stylesheet from an earlier deploy of the site.
      netlify.stored.set('site-1', new Set([sha1(Buffer.from('body{}'))]));
      const id = await queuedPublish();

      await run(id);

      expect(await operation(id)).toMatchObject({
        externalRef: 'deploy-1',
        providerState: 'ready',
        reason: null,
        state: 'succeeded',
      });
      // Three distinct blobs: read once each to hash, and again only for the two uploaded.
      expect(new Set(blobReads).size).toBe(3);
      expect(blobReads).toHaveLength(5);
      expect(netlify.deploys).toHaveLength(1);
      expect(netlify.deploys[0]!.title).toBe(publishTitle(id));
      expect(netlify.deploys[0]!.files).toEqual(
        Object.fromEntries(RELEASE.map((file) => [`/${file.path}`, sha1(file.body)])),
      );
      const uploaded = netlify.uploads.get('deploy-1')!;
      expect([...uploaded.values()].sort()).toEqual(
        [sha1(RELEASE[0]!.body), sha1(RELEASE[1]!.body)].sort(),
      );
      expect(uploaded.has('/assets/style.css')).toBe(false);
    });

    it('records external_ref right after create, before any upload', async () => {
      const id = await queuedPublish();
      netlify.route('PUT', '/deploys/:deployId/files/*path', () => ({ status: 503 }));

      await expect(run(id)).rejects.toBeInstanceOf(RetryableFailure);

      expect(publishProgress[0]).toEqual({ externalRef: 'deploy-1', providerState: 'uploading' });
      expect(await operation(id)).toMatchObject({ externalRef: 'deploy-1', state: 'running' });
    });

    it('a retry after a crash before recording adopts the deploy by title: one deploy only', async () => {
      const id = await queuedPublish();
      // The first attempt created the deploy and died before writing its id.
      await new NetlifyClient({ get: () => netlify.url } as unknown as ConfigService<
        Environment,
        true
      >).createDeploy(
        plaintext(NETLIFY_TOKEN),
        'site-1',
        Object.fromEntries(RELEASE.map((file) => [file.path, sha1(file.body)])),
        publishTitle(id),
      );

      await run(id, 2);

      expect(netlify.deploys).toHaveLength(1);
      expect(await operation(id)).toMatchObject({ externalRef: 'deploy-1', state: 'succeeded' });
    });

    it('writes provider_state on every poll', async () => {
      const id = await queuedPublish();

      await run(id);

      expect(publishProgress.map((p) => p.providerState)).toEqual([
        'uploading',
        'processing',
        'processing',
        'ready',
      ]);
    });

    it('a deploy that ends in error closes the operation failed', async () => {
      netlify.failDeploys = true;
      const id = await queuedPublish();

      await run(id);

      expect(await operation(id)).toMatchObject({
        providerState: 'error',
        reason: 'provider-refused',
        state: 'failed',
      });
    });

    it('a bound site that answers 404 is site-gone, and the binding disconnected', async () => {
      netlify.sites = [];
      const id = await queuedPublish();

      await run(id);

      expect(await operation(id)).toMatchObject({ reason: 'site-gone', state: 'failed' });
      const [binding] = await inTenant((tx) =>
        tx
          .select({ state: schema.connectorBindings.state })
          .from(schema.connectorBindings)
          .where(
            and(
              eq(schema.connectorBindings.orgId, orgId),
              eq(schema.connectorBindings.provider, 'netlify'),
            ),
          ),
      );
      expect(binding!.state).toBe('disconnected');
      expect(netlify.deploys).toHaveLength(0);
      expect(blobReads).toHaveLength(0);
    });
  });
});

/**
 * Spec 030 T093 (US5): `resend_key_mint` and the sending key's release, dispatched by the module's
 * own `ConnectorOpsConsumer` and handlers against Postgres and the Resend `node:http` fixture.
 */
describe.skipIf(!postgres || !redis)('ConnectorOpsConsumer — Resend sending keys', () => {
  let moduleRef: TestingModule;
  let database: ForgeDatabase;
  let transactions: TenantTransactionRunner;
  let consumer: ConnectorOpsConsumer;
  let bindings: BindingService;
  let resend: ProviderFixture;
  let state: ResendState;
  let orgId: string;
  let userId: string;
  let projectId: string;
  const previousUrl = process.env.CONNECTOR_RESEND_API_URL;

  const ref = () => ({ orgId, projectId });
  const keyName = () => `forge-${projectId}`;

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

  async function run(operationId: string): Promise<void> {
    const job = await inTenant((tx) => consumer.handle(event(operationId), tx));

    await consumer.effect(event(operationId), job, 1);
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

  const latest = async () => (await operations()).at(-1)!;

  function resources() {
    return inTenant((tx) =>
      tx
        .select()
        .from(schema.connectorResources)
        .where(eq(schema.connectorResources.orgId, orgId))
        .orderBy(asc(schema.connectorResources.createdAt)),
    );
  }

  async function bindVerified(): Promise<string> {
    await inTenant((tx) =>
      bindings.bind(tx, ref(), userId, 'resend', { domainId: RESEND_VERIFIED_DOMAIN }),
    );

    return (await latest()).id;
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
    }).compile();
    await moduleRef.init();

    database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
    transactions = moduleRef.get(TenantTransactionRunner);
    consumer = moduleRef.get(ConnectorOpsConsumer, { strict: false });
    bindings = moduleRef.get(BindingService, { strict: false });

    const [user] = await database
      .insert(schema.users)
      .values({ email: `030r-${randomUUID()}@example.test`, passwordHash: 'x' })
      .returning({ id: schema.users.id });

    userId = user!.id;
    orgId = (
      await moduleRef
        .get(OrgService)
        .create(userId, { name: 'Resend', slug: `030r-${randomUUID().slice(0, 8)}` })
    ).id;

    const [workspace] = await inTenant((tx) =>
      tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
    );

    projectId = (
      await transactions.runInTenantScope({ orgId, userId }, () =>
        moduleRef.get(ProjectService).create({
          actorId: userId,
          name: 'Resend',
          orgId,
          ownerId: userId,
          workspaceId: workspace!.id,
        }),
      )
    ).id;
  }, 60_000);

  afterAll(async () => {
    process.env.CONNECTOR_RESEND_API_URL = previousUrl;
    await database?.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
    await database?.delete(schema.users).where(eq(schema.users.id, userId));
    await moduleRef?.close();
    await resend?.close();
  });

  beforeEach(async () => {
    resend.reset();
    state = installResendState(resend);

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
        .connectWithToken(tx, orgId, userId, 'resend', RESEND_KEY),
    );
  });

  it('resend_key_mint mints a sending key for the bound domain and seals it', async () => {
    const id = await bindVerified();

    await run(id);

    expect(await latest()).toMatchObject({ id, state: 'succeeded' });
    expect(state.keys).toEqual([
      expect.objectContaining({
        domainId: RESEND_VERIFIED_DOMAIN,
        name: keyName(),
        permission: 'sending_access',
      }),
    ]);
    const [row] = await resources();
    expect(row).toMatchObject({
      externalId: state.keys[0]!.id,
      kind: 'resend_sending_key',
      name: keyName(),
      scopeRef: RESEND_VERIFIED_DOMAIN,
      state: 'live',
    });
    const value = await inTenant((tx) =>
      moduleRef
        .get(ResourceSecrets, { strict: false })
        .open(tx, orgId, 'resend_sending_key', row!.secretId!),
    );
    expect(revealPlaintext(value!).toString('utf8')).toBe(state.keys[0]!.token);
    const [secret] = await inTenant((tx) =>
      tx
        .select({ purpose: schema.secrets.purpose })
        .from(schema.secrets)
        .where(eq(schema.secrets.id, row!.secretId!)),
    );
    expect(secret!.purpose).toBe('connector:resend:sending-key');
  });

  it('an existing forge-<projectId> key with no recorded id is deleted and minted again', async () => {
    // A crash after Resend made the key and before its id was recorded: the token is lost.
    state.keys.push({
      domainId: RESEND_VERIFIED_DOMAIN,
      id: 'key-orphan',
      name: keyName(),
      permission: 'sending_access',
      token: 're_lost',
    });
    const id = await bindVerified();

    await run(id);

    expect(await latest()).toMatchObject({ id, state: 'succeeded' });
    expect(state.keys.map((key) => key.id)).toEqual(['key-1']);
    expect(
      resend.requests.some(
        (request) => request.method === 'DELETE' && request.path === '/api-keys/key-orphan',
      ),
    ).toBe(true);
    expect((await resources())[0]).toMatchObject({ externalId: 'key-1', state: 'live' });
  });

  it('resource_release of a sending key deletes it at Resend, drops its value and the binding', async () => {
    await run(await bindVerified());

    const release = await inTenant((tx) => bindings.unbind(tx, ref(), userId, 'resend'));
    await run(release.id);

    expect(await latest()).toMatchObject({ kind: 'resource_release', state: 'succeeded' });
    expect(state.keys).toEqual([]);
    expect((await resources()).map((row) => [row.state, row.secretId])).toEqual([
      ['released', null],
    ]);
    expect(await inTenant((tx) => bindings.list(tx, ref()))).toEqual([]);
  });

  it('removing the connection deletes the sending key before the credential goes (T096)', async () => {
    await run(await bindVerified());
    const [connection] = await inTenant((tx) =>
      tx
        .select()
        .from(schema.connections)
        .where(and(eq(schema.connections.orgId, orgId), eq(schema.connections.provider, 'resend'))),
    );

    const removal = await inTenant((tx) =>
      moduleRef
        .get(ConnectionService, { strict: false })
        .requestRemoval(tx, orgId, userId, connection!.id),
    );
    await run(removal.id);

    expect(state.keys).toEqual([]);
    expect((await resources())[0]).toMatchObject({ state: 'released' });
    const purposes = await inTenant((tx) =>
      tx.select({ purpose: schema.secrets.purpose }).from(schema.secrets),
    );
    expect(purposes.map((row) => row.purpose)).not.toContain('connector:resend:sending-key');
  });
});
