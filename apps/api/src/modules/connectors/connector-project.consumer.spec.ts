import { ConfigModule } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { eq } from 'drizzle-orm';
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
import type { Envelope } from '../outbox/envelope';
import { PreviewModule } from '../preview/preview.module';
import { OrgService } from '../tenancy/services/org.service';
import { ProjectService } from '../tenancy/services/project.service';
import { TenancyModule } from '../tenancy/tenancy.module';
import { BindingService } from './binding.service';
import { ConnectionService } from './connection.service';
import { CONNECTOR_OPS_QUEUE } from './connector-ops.consumer';
import { ConnectorProjectConsumer } from './connector-project.consumer';
import { ConnectorsModule } from './connectors.module';
import { PROVIDER_VERIFIERS, type ProviderVerifier } from './providers/provider';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

if (!postgres || !redis) {
  console.warn(
    'SKIPPING connector-project.consumer.spec.ts: Postgres or the session Redis is not reachable',
  );
}

const verifier: ProviderVerifier = {
  verify: () =>
    Promise.resolve({ accountName: 'Acme', accountRef: 'org', kind: 'verified', scopes: [] }),
};

const NEON = { databaseName: 'app', parentBranchId: 'br-main', projectId: 'np-1', roleName: 'app' };

/** Spec 030 T075: an archived project's bindings are released as unbinds by the platform. */
describe('ConnectorProjectConsumer', () => {
  it('runs on connector.ops, eight at a time, for project.archived', () => {
    const consumer = new ConnectorProjectConsumer({} as BindingService);

    expect(consumer.queue).toBe(CONNECTOR_OPS_QUEUE);
    expect(consumer.concurrency).toBe(8);
    expect(consumer.types).toEqual(['project.archived']);
  });

  describe.skipIf(!postgres || !redis)('against Postgres', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    let consumer: ConnectorProjectConsumer;
    let orgId: string;
    let userId: string;
    let projectId: string;

    function inTenant<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantTransaction(orgId, fn);
    }

    const event = (): Envelope<'project.archived'> => ({
      aggregate: 'project',
      aggregateId: projectId,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      orgId,
      payload: { actorId: userId, orgId, projectId, workspaceId: randomUUID() },
      traceId: null,
      type: 'project.archived',
    });

    const operations = () =>
      inTenant((tx) =>
        tx
          .select()
          .from(schema.connectorOperations)
          .where(eq(schema.connectorOperations.orgId, orgId)),
      );

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
        .useValue(new Map([['neon', verifier]]))
        .compile();
      await moduleRef.init();

      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      transactions = moduleRef.get(TenantTransactionRunner);
      consumer = moduleRef.get(ConnectorProjectConsumer, { strict: false });

      const [user] = await database
        .insert(schema.users)
        .values({ email: `030a-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });

      userId = user!.id;
      orgId = (
        await moduleRef
          .get(OrgService)
          .create(userId, { name: 'Archive', slug: `030a-${randomUUID().slice(0, 8)}` })
      ).id;

      const [workspace] = await inTenant((tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      );

      projectId = (
        await transactions.runInTenantScope({ orgId, userId }, () =>
          moduleRef.get(ProjectService).create({
            actorId: userId,
            name: 'Archive',
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
        await tx
          .delete(schema.connectorOperations)
          .where(eq(schema.connectorOperations.orgId, orgId));
        await tx.delete(schema.connectorBindings).where(eq(schema.connectorBindings.orgId, orgId));
        await tx.delete(schema.connections).where(eq(schema.connections.orgId, orgId));
      });
      await inTenant((tx) =>
        moduleRef
          .get(ConnectionService, { strict: false })
          .connectWithToken(tx, orgId, userId, 'neon', 'napi_archive0123456789'),
      );
      await inTenant((tx) =>
        moduleRef
          .get(BindingService, { strict: false })
          .bind(tx, { orgId, projectId }, userId, 'neon', NEON),
      );
      await inTenant((tx) =>
        tx
          .update(schema.connectorOperations)
          .set({ finishedAt: new Date(), state: 'succeeded' })
          .where(eq(schema.connectorOperations.orgId, orgId)),
      );
    });

    it('queues one resource_release per binding with requestedBy null, and none on redelivery', async () => {
      await inTenant((tx) => consumer.handle(event(), tx));
      await inTenant((tx) => consumer.handle(event(), tx));

      const releases = (await operations()).filter((row) => row.kind === 'resource_release');

      expect(releases).toHaveLength(1);
      expect(releases[0]).toMatchObject({ projectId, requestedBy: null, state: 'queued' });
    });

    it('a disconnected binding has nothing to release through and goes at once', async () => {
      await inTenant((tx) =>
        tx
          .update(schema.connectorBindings)
          .set({ connectionId: null, state: 'disconnected' })
          .where(eq(schema.connectorBindings.orgId, orgId)),
      );

      await inTenant((tx) => consumer.handle(event(), tx));

      expect(
        await inTenant((tx) =>
          tx
            .select()
            .from(schema.connectorBindings)
            .where(eq(schema.connectorBindings.orgId, orgId)),
        ),
      ).toEqual([]);
      expect((await operations()).filter((row) => row.kind === 'resource_release')).toEqual([]);
    });
  });
});
