import { ConfigModule } from '@nestjs/config';
import type { TestingModule, TestingModuleBuilder } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { and, asc, eq, gt, notExists, sql } from 'drizzle-orm';
import { generateKeyPairSync, randomUUID } from 'node:crypto';

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
import { ConnectorsModule } from '../../src/modules/connectors/connectors.module';
import { InstallStateStore } from '../../src/modules/connectors/install-state';
import { MailModule } from '../../src/modules/mail/mail.module';
import { PreviewModule } from '../../src/modules/preview/preview.module';
import { OrgService } from '../../src/modules/tenancy/services/org.service';
import { ProjectService } from '../../src/modules/tenancy/services/project.service';
import { TenancyModule } from '../../src/modules/tenancy/tenancy.module';
import { holdOutboxSuiteLock } from '../support/outbox-suite-lock';
import { type FixtureAccount, type GithubFixture, startGithubFixture } from './github-fixture';

export const INSTALLATION_ID = 7001;
export const ORG_ACCOUNT: FixtureAccount = { id: 9001, login: 'acme', type: 'Organization' };
export const USER_ACCOUNT: FixtureAccount = { id: 9002, login: 'jane', type: 'User' };

/**
 * The connectors module booted against Postgres, Redis and the fixture GitHub, with one org, one
 * user and one project — what every 018 service spec needs before its first `it`.
 */
export interface ConnectorsHarness {
  readonly database: ForgeDatabase;
  readonly fixture: GithubFixture;
  readonly moduleRef: TestingModule;
  readonly orgId: string;
  readonly projectId: string;
  readonly userId: string;
  /** The org's default workspace — where an imported project is created (spec 026). */
  readonly workspaceId: string;
  /** Completes an install of `INSTALLATION_ID` for the org; the fixture must know the installation. */
  connect(): Promise<{ id: string }>;
  /** Audit actions written since the last `reset`, oldest first. */
  auditActions(): Promise<string[]>;
  close(): Promise<void>;
  inTenant<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T>;
  /** As {@link inTenant}, but with `TenantContext` populated for the harness's user — what an HTTP
   * request has, and what `ProjectService` reads its transaction from (spec 026). */
  inTenantScope<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T>;
  /** Fixture and tenant rows back to nothing, the installation registered under `account`. */
  reset(account?: FixtureAccount): Promise<void>;
}

export interface HarnessOptions {
  /** The fixture also serves git over HTTP, and `GITHUB_INSTALL_URL` points at it (the clone origin). */
  readonly git?: boolean;
  /** Provider overrides on the testing module, before it compiles. */
  readonly override?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

export async function startConnectorsHarness(
  options: HarnessOptions = {},
): Promise<ConnectorsHarness> {
  // `request` writes `sync.requested` to the shared outbox; a relay in a concurrent suite would
  // dispatch it to that suite's `connector.sync` worker, which then pulls or pushes the same rows
  // the spec is driving by hand. Held for the suite, like every suite that writes the outbox.
  const suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
  const fixture = await startGithubFixture({ git: options.git });
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

  // `ConfigModule.forRoot` reads `process.env` when it is called, so the module is assembled here,
  // after the fixture has a port.
  Object.assign(process.env, {
    GITHUB_API_URL: fixture.url,
    GITHUB_APP_CLIENT_ID: 'Iv1.test',
    GITHUB_APP_ID: '4242',
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs1' }),
    GITHUB_APP_SLUG: 'forge-test',
    GITHUB_INSTALL_URL: options.git === true ? fixture.url : 'https://github.example',
  });

  const builder = Test.createTestingModule({
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
  });
  const moduleRef = await (options.override?.(builder) ?? builder).compile();
  await moduleRef.init();

  const database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
  const transactions = moduleRef.get(TenantTransactionRunner);
  const connections = moduleRef.get(ConnectionService, { strict: false });
  const states = moduleRef.get(InstallStateStore, { strict: false });

  const [user] = await database
    .insert(schema.users)
    .values({ email: `018h-${randomUUID()}@example.test`, passwordHash: 'x' })
    .returning({ id: schema.users.id });
  const userId = user!.id;
  const orgId = (
    await moduleRef
      .get(OrgService)
      .create(userId, { name: 'Connector harness', slug: `018h-${randomUUID().slice(0, 8)}` })
  ).id;

  function inTenant<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
    return transactions.runInTenantTransaction(orgId, fn);
  }

  const [workspace] = await inTenant((tx) =>
    tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
  );
  const projectId = (
    await transactions.runInTenantScope({ orgId, userId }, () =>
      moduleRef.get(ProjectService).create({
        actorId: userId,
        name: 'Linked',
        orgId,
        ownerId: userId,
        workspaceId: workspace!.id,
      }),
    )
  ).id;

  let auditSince = new Date();

  return {
    async auditActions() {
      const rows = await inTenant((tx) =>
        tx
          .select({ action: schema.auditLog.action })
          .from(schema.auditLog)
          .where(and(eq(schema.auditLog.orgId, orgId), gt(schema.auditLog.createdAt, auditSince)))
          .orderBy(asc(schema.auditLog.createdAt)),
      );

      return rows.map((row) => row.action);
    },
    async close() {
      await database.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
      await database.delete(schema.users).where(eq(schema.users.id, userId));
      await moduleRef.close();
      await fixture.close();
      await suiteLock.release();
    },
    async connect() {
      const state = await states.issue(orgId, userId);

      return inTenant((tx) =>
        connections.completeInstall(tx, orgId, userId, { installationId: INSTALLATION_ID, state }),
      );
    },
    database,
    fixture,
    inTenant,
    inTenantScope<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantScope({ orgId, userId }, fn);
    },
    moduleRef,
    orgId,
    projectId,
    async reset(account = ORG_ACCOUNT) {
      fixture.installations.clear();
      fixture.repositories.clear();
      fixture.tokens.clear();
      fixture.requests.length = 0;
      fixture.installations.set(INSTALLATION_ID, { account, id: INSTALLATION_ID });
      await inTenant(async (tx) => {
        await tx.delete(schema.agentRuns).where(eq(schema.agentRuns.orgId, orgId));
        // A pulled checkpoint keeps its operation (checkpoints are append-only): those rows stay.
        await tx.delete(schema.syncOperations).where(
          and(
            eq(schema.syncOperations.orgId, orgId),
            notExists(
              tx
                .select({ one: sql`1` })
                .from(schema.checkpoints)
                .where(eq(schema.checkpoints.syncOperationId, schema.syncOperations.id)),
            ),
          ),
        );
        await tx.delete(schema.repoLinks).where(eq(schema.repoLinks.orgId, orgId));
        await tx.delete(schema.connections).where(eq(schema.connections.orgId, orgId));
        await tx.delete(schema.secrets).where(eq(schema.secrets.orgId, orgId));
        await tx
          .update(schema.projects)
          .set({ deletedAt: null })
          .where(eq(schema.projects.id, projectId));
      });
      auditSince = new Date();
    },
    userId,
    workspaceId: workspace!.id,
  };
}
