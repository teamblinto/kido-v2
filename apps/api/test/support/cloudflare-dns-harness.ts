import { ConfigModule } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { and, asc, eq, gt } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { ClockModule } from '../../src/common/clock/clock.module';
import { CryptoModule } from '../../src/common/crypto/crypto.module';
import { RedisModule } from '../../src/common/redis/redis.module';
import { RunProfilesModule } from '../../src/common/run-profiles/run-profiles.module';
import { validateEnvironment } from '../../src/config/environment';
import { APP_DATABASE } from '../../src/database/database.constants';
import { DatabaseModule } from '../../src/database/database.module';
import type { ForgeDatabase, TenantTransaction } from '../../src/database/database.types';
import { TenantTransactionRunner } from '../../src/database/tenant-transaction';
import { ConnectionService } from '../../src/modules/connectors/connection.service';
import { ConnectorOpsConsumer } from '../../src/modules/connectors/connector-ops.consumer';
import { ConnectorsModule } from '../../src/modules/connectors/connectors.module';
import { ownershipToken } from '../../src/modules/deploy/domains/ownership-token';
import { MailModule } from '../../src/modules/mail/mail.module';
import type { Envelope } from '../../src/modules/outbox/envelope';
import { PreviewModule } from '../../src/modules/preview/preview.module';
import { OrgService } from '../../src/modules/tenancy/services/org.service';
import { ProjectService } from '../../src/modules/tenancy/services/project.service';
import { TenancyModule } from '../../src/modules/tenancy/tenancy.module';
import {
  CLOUDFLARE_TOKEN,
  type CloudflareFixture,
  startCloudflareFixture,
} from '../fixtures/provider-fixtures';

export const EDGE_TARGET = 'edge.forge.test';

/**
 * Spec 030 US2: `ConnectorsModule` against Postgres, Redis and the Cloudflare fixture, with one
 * organisation, one project and a helper to add a domain row in a state — what the DNS service,
 * the `dns_write` handler and the domain consumer specs share.
 */
export interface CloudflareDnsHarness {
  readonly fixture: CloudflareFixture;
  readonly moduleRef: TestingModule;
  readonly database: ForgeDatabase;
  readonly orgId: string;
  readonly userId: string;
  readonly projectId: string;
  inTenant<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T>;
  /** Pastes the fixture token; the connection row. The verify probe's requests are cleared. */
  connect(): Promise<{ id: string }>;
  addDomain(
    hostname: string,
    state?: 'active' | 'pending' | 'removing',
  ): Promise<{ id: string; ownershipToken: string }>;
  auditActions(): Promise<string[]>;
  /** A fresh hostname under `zone`: the live-hostname key is global, and suites run side by side. */
  host(zone?: string): string;
  /** One `connector.op.requested` through the ops consumer, on its last attempt by default. */
  runOperation(operationId: string, attempt?: number): Promise<void>;
  /** Fresh fixture, no connection, resources, operations or domains; the audit read starts now. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function startCloudflareDnsHarness(): Promise<CloudflareDnsHarness> {
  const fixture = await startCloudflareFixture();

  // Read by `ConfigModule.forRoot` when it is called: settled before the module is assembled.
  Object.assign(process.env, {
    CLOUDFLARE_API_TOKEN: 'platform-token-not-the-tenants',
    CLOUDFLARE_API_URL: fixture.url,
    CLOUDFLARE_ZONE_ID: 'platform-zone',
    CUSTOM_HOSTNAME_TARGET: EDGE_TARGET,
  });

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true, validate: validateEnvironment }),
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

  const database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
  const transactions = moduleRef.get(TenantTransactionRunner);
  const [user] = await database
    .insert(schema.users)
    .values({ email: `030dns-${randomUUID()}@example.test`, passwordHash: 'x' })
    .returning({ id: schema.users.id });
  const userId = user!.id;
  const orgId = (
    await moduleRef.get(OrgService).create(userId, {
      name: 'DNS fixture',
      slug: `030dns-${randomUUID().slice(0, 8)}`,
    })
  ).id;
  const inTenant = <T>(fn: (tx: TenantTransaction) => Promise<T>) =>
    transactions.runInTenantTransaction(orgId, fn);
  const [workspace] = await inTenant((tx) =>
    tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
  );
  const projectId = (
    await transactions.runInTenantScope({ orgId, userId }, () =>
      moduleRef.get(ProjectService).create({
        actorId: userId,
        name: 'Domains',
        orgId,
        ownerId: userId,
        workspaceId: workspace!.id,
      }),
    )
  ).id;
  let auditSince = new Date();

  return {
    addDomain: (hostname, state = 'pending') =>
      inTenant(async (tx) => {
        const now = new Date();
        const [row] = await tx
          .insert(schema.domains)
          .values({
            addedBy: userId,
            hostname,
            nextCheckAt: now,
            orgId,
            ownershipToken: ownershipToken(),
            projectId,
            state,
            windowStartedAt: now,
            ...(state === 'removing' ? { removalRequestedAt: now } : {}),
            ...(state === 'active'
              ? {
                  activatedAt: now,
                  certificateActiveAt: now,
                  edgeId: `edge-${randomUUID()}`,
                  ownershipVerifiedAt: now,
                }
              : {}),
          })
          .returning({ id: schema.domains.id, ownershipToken: schema.domains.ownershipToken });

        return row!;
      }),
    auditActions: () =>
      inTenant((tx) =>
        tx
          .select({ action: schema.auditLog.action })
          .from(schema.auditLog)
          .where(and(eq(schema.auditLog.orgId, orgId), gt(schema.auditLog.createdAt, auditSince)))
          .orderBy(asc(schema.auditLog.createdAt)),
      ).then((rows) => rows.map((row) => row.action)),
    close: async () => {
      await database.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
      await database.delete(schema.users).where(eq(schema.users.id, userId));
      await moduleRef.close();
      await fixture.close();
    },
    connect: async () => {
      const row = await inTenant((tx) =>
        moduleRef
          .get(ConnectionService, { strict: false })
          .connectWithToken(tx, orgId, userId, 'cloudflare', CLOUDFLARE_TOKEN),
      );
      // The verify probe's calls are the connect's, not the subject's.
      fixture.requests.length = 0;

      return row;
    },
    database,
    fixture,
    host: (zone = 'acme.test') => `w${randomUUID().slice(0, 8)}.${zone}`,
    runOperation: async (operationId, attempt = 5) => {
      const consumer = moduleRef.get(ConnectorOpsConsumer, { strict: false });
      const event: Envelope<'connector.op.requested'> = {
        aggregate: 'connector-operation',
        aggregateId: operationId,
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        orgId,
        payload: { operationId, orgId },
        traceId: null,
        type: 'connector.op.requested',
      };
      const job = await inTenant((tx) => consumer.handle(event, tx));

      await consumer.effect(event, job, attempt);
    },
    inTenant,
    moduleRef,
    orgId,
    projectId,
    reset: async () => {
      await inTenant(async (tx) => {
        await tx
          .delete(schema.connectorOperations)
          .where(eq(schema.connectorOperations.orgId, orgId));
        await tx
          .delete(schema.connectorResources)
          .where(eq(schema.connectorResources.orgId, orgId));
        await tx.delete(schema.connections).where(eq(schema.connections.orgId, orgId));
        await tx.delete(schema.secrets).where(eq(schema.secrets.orgId, orgId));
        // No DELETE grant on `domains`: an earlier test's rows are retired, freeing the hostnames.
        await tx
          .update(schema.domains)
          .set({ driftedAt: null, edgeId: null, state: 'removed' })
          .where(eq(schema.domains.orgId, orgId));
      });
      fixture.reset();
      auditSince = new Date();
    },
    userId,
  };
}
