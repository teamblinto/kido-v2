import { ConfigModule } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { and, asc, eq, gt } from 'drizzle-orm';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from 'vitest';

import { ClockModule } from '../../common/clock/clock.module';
import { revealPlaintext } from '../../common/crypto/branded';
import { CryptoModule } from '../../common/crypto/crypto.module';
import { DekService } from '../../common/crypto/dek.service';
import { SecretDecryptionError } from '../../common/crypto/envelope';
import { RedisModule } from '../../common/redis/redis.module';
import { RunProfilesModule } from '../../common/run-profiles/run-profiles.module';
import { validateEnvironment } from '../../config/environment';
import { APP_DATABASE } from '../../database/database.constants';
import { DatabaseModule } from '../../database/database.module';
import type { ForgeDatabase, TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { MailModule } from '../mail/mail.module';
import { PreviewModule } from '../preview/preview.module';
import { OrgService } from '../tenancy/services/org.service';
import { ProjectService } from '../tenancy/services/project.service';
import { TenancyModule } from '../tenancy/tenancy.module';
import { ConnectionRepository } from './connection.repository';
import { ConnectionService, credentialPurpose, TOKEN_PURPOSE } from './connection.service';
import { ConnectorsModule } from './connectors.module';
import { GITHUB_APP_CLIENT, type GithubAppClient } from './github-app.client';
import { GithubApiError } from './github-fetch';
import { InstallStateStore } from './install-state';
import { PROVIDER_VERIFIERS, type ProviderVerifier, type VerifyResult } from './providers/provider';
import { type GithubFixture, startGithubFixture } from '../../../test/fixtures/github-fixture';
import {
  startSupabaseFixture,
  SUPABASE_CLIENT_ID,
  SUPABASE_CLIENT_SECRET,
  type SupabaseFixture,
} from '../../../test/fixtures/provider-fixtures';
import { RESOURCE_RELEASERS, type ResourceReleaser } from './connection-remove.handler';
import { ProviderFailure } from './providers/provider';
import { SUPABASE_CLIENT, type SupabaseClient } from './providers/supabase/supabase.client';
import { removeConnection } from '../../../test/support/connector-removal';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

if (!postgres || !redis) {
  console.warn(
    'SKIPPING connection.service.spec.ts: Postgres or the session Redis is not reachable',
  );
}

/**
 * Spec 030: the provider-generic path is exercised through a scripted verifier — the adapters
 * themselves are proved against `node:http` fixtures in their own specs (plan § Constitution III);
 * here the unit is the service's paste → verify → seal → upsert, against the real `DekService`.
 */
class ScriptedVerifier implements ProviderVerifier {
  next: VerifyResult = {
    accountName: 'Acme',
    accountRef: 'org-acme',
    kind: 'verified',
    scopes: ['projects:read'],
  };
  seen: string[] = [];

  verify(credential: Parameters<ProviderVerifier['verify']>[0]): Promise<VerifyResult> {
    this.seen.push(revealPlaintext(credential).toString('utf8'));

    return Promise.resolve(this.next);
  }
}

const verifier = new ScriptedVerifier();
const PASTED = ['netlify', 'neon', 'resend', 'cloudflare'] as const;

const INSTALLATION_ID = 7001;
const ACCOUNT = { id: 9001, login: 'acme', type: 'Organization' as const };

/**
 * Spec 018 US1 through a real `DekService` against Postgres and Redis, with the real client at
 * the fixture GitHub: the seal/open round trip, the AAD probe (SC-003), the token that never leaves
 * (SC-002) and the single-flight re-mint (R15) are all `where` clauses and ciphertexts a fake
 * would only prove about the fake.
 */
describe('ConnectionService', () => {
  describe.skipIf(!postgres || !redis)('against Postgres, Redis and the fixture GitHub', () => {
    let fixture: GithubFixture;
    let supabaseFixture: SupabaseFixture;
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let service: ConnectionService;
    let states: InstallStateStore;
    let repository: ConnectionRepository;
    let dek: DekService;
    let transactions: TenantTransactionRunner;
    let orgId: string;
    let otherOrgId: string;
    let userId: string;
    let projectId: string;

    function inTenant<T>(org: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantTransaction(org, fn);
    }

    async function connect(installationId = INSTALLATION_ID) {
      const state = await states.issue(orgId, userId);

      return inTenant(orgId, (tx) =>
        service.completeInstall(tx, orgId, userId, { installationId, state }),
      );
    }

    /** Every tenant table is behind RLS: reads and writes go through the tenant transaction. */
    function secretsOf(org: string) {
      return inTenant(org, (tx) =>
        tx.select().from(schema.secrets).where(eq(schema.secrets.orgId, org)),
      );
    }

    function connectionsOf(org: string) {
      return inTenant(org, (tx) =>
        tx.select().from(schema.connections).where(eq(schema.connections.orgId, org)),
      );
    }

    function setConnection(values: Partial<typeof schema.connections.$inferInsert>) {
      return inTenant(orgId, (tx) =>
        tx.update(schema.connections).set(values).where(eq(schema.connections.orgId, orgId)),
      );
    }

    let auditSince = new Date();

    /** The trail is append-only (no DELETE grant), so each test reads only what it wrote. */
    function auditActions(org: string) {
      return inTenant(org, (tx) =>
        tx
          .select({ action: schema.auditLog.action })
          .from(schema.auditLog)
          .where(and(eq(schema.auditLog.orgId, org), gt(schema.auditLog.createdAt, auditSince)))
          .orderBy(asc(schema.auditLog.createdAt)),
      ).then((rows) => rows.map((row) => row.action));
    }

    function mintRequests(): number {
      return fixture.requests.filter((request) => request.path.endsWith('/access_tokens')).length;
    }

    beforeAll(async () => {
      fixture = await startGithubFixture();
      supabaseFixture = await startSupabaseFixture();

      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

      // `ConfigModule.forRoot` reads `process.env` when it is called, so the module is assembled here,
      // after the fixture has a port, rather than imported ready-made from `app.module.ts`.
      Object.assign(process.env, {
        GITHUB_API_URL: fixture.url,
        GITHUB_APP_CLIENT_ID: 'Iv1.test',
        GITHUB_APP_ID: '4242',
        GITHUB_APP_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs1' }),
        GITHUB_APP_SLUG: 'forge-test',
        GITHUB_INSTALL_URL: 'https://github.example',
        SUPABASE_API_URL: supabaseFixture.url,
        SUPABASE_OAUTH_CLIENT_ID: SUPABASE_CLIENT_ID,
        SUPABASE_OAUTH_CLIENT_SECRET: SUPABASE_CLIENT_SECRET,
      });

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
        .useValue(new Map(PASTED.map((provider) => [provider, verifier])))
        .compile();
      await moduleRef.init();

      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      service = moduleRef.get(ConnectionService, { strict: false });
      states = moduleRef.get(InstallStateStore, { strict: false });
      repository = moduleRef.get(ConnectionRepository, { strict: false });
      dek = moduleRef.get(DekService, { strict: false });
      transactions = moduleRef.get(TenantTransactionRunner);

      const [user] = await database
        .insert(schema.users)
        .values({ email: `018c-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });

      userId = user!.id;

      const orgs = moduleRef.get(OrgService);

      orgId = (
        await orgs.create(userId, {
          name: 'Connector fixture',
          slug: `018c-${randomUUID().slice(0, 8)}`,
        })
      ).id;
      otherOrgId = (
        await orgs.create(userId, {
          name: 'Other tenant',
          slug: `018o-${randomUUID().slice(0, 8)}`,
        })
      ).id;

      const [workspace] = await inTenant(orgId, (tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      );

      projectId = (
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
    }, 60_000);

    afterAll(async () => {
      for (const org of [orgId, otherOrgId]) {
        await database.delete(schema.orgs).where(eq(schema.orgs.id, org));
      }
      await database.delete(schema.users).where(eq(schema.users.id, userId));
      await moduleRef?.close();
      await fixture.close();
      await supabaseFixture.close();
    });

    beforeEach(async () => {
      fixture.installations.clear();
      fixture.tokens.clear();
      fixture.requests.length = 0;
      fixture.installations.set(INSTALLATION_ID, { account: ACCOUNT, id: INSTALLATION_ID });
      await inTenant(orgId, async (tx) => {
        await tx.delete(schema.repoLinks).where(eq(schema.repoLinks.orgId, orgId));
        await tx
          .delete(schema.connectorResources)
          .where(eq(schema.connectorResources.orgId, orgId));
        await tx.delete(schema.connectorBindings).where(eq(schema.connectorBindings.orgId, orgId));
        await tx.delete(schema.connections).where(eq(schema.connections.orgId, orgId));
        await tx.delete(schema.secrets).where(eq(schema.secrets.orgId, orgId));
      });
      auditSince = new Date();
    });

    it('beginInstall answers the App’s install URL carrying a fresh state', async () => {
      const { installUrl } = await service.beginInstall(orgId, userId);
      const url = new URL(installUrl);

      expect(`${url.origin}${url.pathname}`).toBe(
        'https://github.example/apps/forge-test/installations/new',
      );
      await expect(
        states.consume(url.searchParams.get('state') ?? '', { orgId, provider: 'github', userId }),
      ).resolves.toEqual({ orgId, provider: 'github', userId });
    });

    it('completeInstall refuses a state minted for another org or user as oauth-state-invalid', async () => {
      const forOtherOrg = await states.issue(otherOrgId, userId);
      const forOtherUser = await states.issue(orgId, randomUUID());

      for (const state of [forOtherOrg, forOtherUser, 'never-issued']) {
        await expect(
          inTenant(orgId, (tx) =>
            service.completeInstall(tx, orgId, userId, { installationId: INSTALLATION_ID, state }),
          ),
        ).rejects.toMatchObject({ type: 'oauth-state-invalid' });
      }
      expect(fixture.requests).toHaveLength(0);
    });

    it('completeInstall answers oauth-exchange-failed when GitHub does not know the installation', async () => {
      await expect(connect(INSTALLATION_ID + 1)).rejects.toMatchObject({
        type: 'oauth-exchange-failed',
      });
      await expect(connectionsOf(orgId)).resolves.toEqual([]);
    });

    it('completeInstall seals the first token into secrets and audits connector.connected', async () => {
      const row = await connect();

      expect(row).toMatchObject({
        accountId: ACCOUNT.id,
        accountLogin: 'acme',
        accountType: 'organization',
        connectedBy: userId,
        health: 'healthy',
        installationId: INSTALLATION_ID,
        orgId,
        provider: 'github',
      });
      expect(row.tokenExpiresAt?.getTime()).toBeGreaterThan(Date.now());

      const secrets = await secretsOf(orgId);

      expect(secrets).toHaveLength(1);
      expect(secrets[0]).toMatchObject({
        alg: 'AES-256-GCM',
        id: row.secretId,
        purpose: TOKEN_PURPOSE,
      });

      const [minted] = [...fixture.tokens.keys()];
      const opened = await inTenant(orgId, (tx) =>
        dek.openSecret(tx, orgId, TOKEN_PURPOSE, secrets[0]!),
      );

      expect(revealPlaintext(opened).toString('utf8')).toBe(minted);
      await expect(auditActions(orgId)).resolves.toEqual(['connector.connected']);
    });

    /** SC-003: the same bytes under another tenant do not open — the org id is bound into the seal. */
    it('refuses the ciphertext copied into a second org’s secrets row (AAD probe)', async () => {
      await connect();

      const [sealed] = await secretsOf(orgId);
      const copied = await inTenant(otherOrgId, async (tx) => {
        const { dekId } = await dek.ensureDek(tx, otherOrgId);
        const [row] = await tx
          .insert(schema.secrets)
          .values({ ...sealed!, dekId, id: undefined, orgId: otherOrgId })
          .returning();

        return row!;
      });

      await expect(
        inTenant(otherOrgId, (tx) => dek.openSecret(tx, otherOrgId, TOKEN_PURPOSE, copied)),
      ).rejects.toBeInstanceOf(SecretDecryptionError);
      await expect(
        inTenant(orgId, (tx) => dek.openSecret(tx, orgId, TOKEN_PURPOSE, sealed!)),
      ).resolves.toBeDefined();

      await inTenant(otherOrgId, (tx) =>
        tx.delete(schema.secrets).where(eq(schema.secrets.orgId, otherOrgId)),
      );
    });

    it('completeInstall again for the same account replaces the installation and the secret, audits connector.reconnected', async () => {
      const first = await connect();

      fixture.installations.set(INSTALLATION_ID + 5, { account: ACCOUNT, id: INSTALLATION_ID + 5 });

      const second = await connect(INSTALLATION_ID + 5);

      expect(second.id).toBe(first.id);
      expect(second.installationId).toBe(INSTALLATION_ID + 5);
      expect(second.secretId).not.toBe(first.secretId);

      const secrets = await secretsOf(orgId);

      expect(secrets).toHaveLength(1);
      expect(secrets[0]!.id).toBe(second.secretId);
      await expect(auditActions(orgId)).resolves.toEqual([
        'connector.connected',
        'connector.reconnected',
      ]);
    });

    function link(connectionId: string) {
      return inTenant(orgId, (tx) =>
        tx.insert(schema.repoLinks).values({
          branch: 'main',
          connectionId,
          linkedBy: userId,
          name: 'site',
          orgId,
          owner: 'acme',
          projectId,
          repoId: 1,
          state: 'linked',
        }),
      );
    }

    it('remove deletes the installation at GitHub, the secret and the row, and audits connector.removed', async () => {
      const row = await connect();

      await removeConnection(moduleRef, orgId, userId, row.id);

      expect(fixture.requests.at(-1)).toMatchObject({
        method: 'DELETE',
        path: `/app/installations/${String(INSTALLATION_ID)}`,
      });
      expect(fixture.installations.has(INSTALLATION_ID)).toBe(false);
      await expect(secretsOf(orgId)).resolves.toEqual([]);
      await expect(connectionsOf(orgId)).resolves.toEqual([]);
      await expect(auditActions(orgId)).resolves.toEqual([
        'connector.connected',
        'connector.removed',
      ]);
    });

    /** R13 / FR-007: a disconnected link outlives its connection (schema corrected at T017). */
    it('remove leaves the links disconnected and unpointed, with the row, the secret gone and connector.removed audited', async () => {
      const row = await connect();

      await link(row.id);
      await removeConnection(moduleRef, orgId, userId, row.id);

      const links = await inTenant(orgId, (tx) =>
        tx.select().from(schema.repoLinks).where(eq(schema.repoLinks.orgId, orgId)),
      );

      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({ connectionId: null, projectId, state: 'disconnected' });
      await expect(connectionsOf(orgId)).resolves.toEqual([]);
      await expect(secretsOf(orgId)).resolves.toEqual([]);
      await expect(auditActions(orgId)).resolves.toEqual([
        'connector.connected',
        'connector.removed',
      ]);
    });

    it('currentToken opens the sealed row and re-mints under the row lock once when it is about to expire (R15)', async () => {
      await connect();

      const [minted] = [...fixture.tokens.keys()];
      const fresh = await inTenant(orgId, (tx) => service.currentToken(tx, orgId));

      expect(revealPlaintext(fresh).toString('utf8')).toBe(minted);
      expect(mintRequests()).toBe(1);

      // Four minutes left: under the five-minute floor, so the next read re-mints.
      await setConnection({ tokenExpiresAt: new Date(Date.now() + 4 * 60_000) });

      const [a, b] = await Promise.all([
        inTenant(orgId, (tx) => service.currentToken(tx, orgId)),
        inTenant(orgId, (tx) => service.currentToken(tx, orgId)),
      ]);

      expect(mintRequests()).toBe(2);
      expect(revealPlaintext(a).toString('utf8')).toBe(revealPlaintext(b).toString('utf8'));
      expect(revealPlaintext(a).toString('utf8')).not.toBe(minted);
      expect(await secretsOf(orgId)).toHaveLength(1);
    });

    /** SC-002: the contract carries the fingerprint and nothing the token could be recovered from. */
    it('toContract carries credentialFingerprint and no token', async () => {
      const row = await connect();
      const [record] = await inTenant(orgId, (tx) => service.list(tx, orgId));
      const contract = service.toContract(record!);

      expect(contract).toMatchObject({
        account: { id: ACCOUNT.id, login: 'acme', type: 'organization' },
        canCreateRepositories: true,
        connectedBy: { id: userId },
        health: 'healthy',
        id: row.id,
        provider: 'github',
      });
      expect(contract.credentialFingerprint).toMatch(/^sha256:[0-9a-f]{16,}$/u);

      const json = JSON.stringify(contract);

      for (const token of fixture.tokens.keys()) {
        expect(json).not.toContain(token);
      }
      expect(json).not.toContain('secretId');
    });

    it('ensureUsable answers the row while healthy and refuses needs_reauth as conflict/needs-reauth', async () => {
      const row = await connect();

      await expect(inTenant(orgId, (tx) => service.ensureUsable(tx, orgId))).resolves.toMatchObject(
        { id: row.id },
      );

      await setConnection({ health: 'needs_reauth' });
      await expect(inTenant(orgId, (tx) => service.ensureUsable(tx, orgId))).rejects.toMatchObject({
        extensions: { reason: 'needs-reauth' },
        type: 'conflict',
      });
    });

    it('SC-010: while the provider circuit is open, ensureUsable refuses in under 1 second from a single row read, with Retry-After the seconds left', async () => {
      await connect();
      await setConnection({
        circuitOpenUntil: new Date(Date.now() + 5 * 60_000),
        health: 'unavailable',
      });
      const requestsBefore = fixture.requests.length;
      const started = Date.now();

      await expect(inTenant(orgId, (tx) => service.ensureUsable(tx, orgId))).rejects.toMatchObject({
        extensions: { reason: 'provider-unavailable', retryAfter: expect.any(Number) as number },
        retryAfterSeconds: expect.toSatisfy((s: number) => s > 290 && s <= 300) as number,
        type: 'service-unavailable',
      });

      expect(Date.now() - started).toBeLessThan(1_000);
      expect(fixture.requests.length).toBe(requestsBefore);
    });

    it('recordFailure counts to the threshold and opens the circuit as unavailable; recordSuccess closes it healthy; needs_reauth outranks both', async () => {
      const { id } = await connect();
      const now = new Date();
      const fail = () => inTenant(orgId, (tx) => repository.recordFailure(tx, orgId, id, now));

      for (let n = 0; n < 4; n += 1) {
        await fail();
      }
      expect(await connectionsOf(orgId)).toMatchObject([
        { circuitOpenUntil: null, failureCount: 4, health: 'healthy' },
      ]);

      await fail();
      expect(await connectionsOf(orgId)).toMatchObject([
        {
          circuitOpenUntil: new Date(now.getTime() + 10 * 60_000),
          failureCount: 5,
          health: 'unavailable',
        },
      ]);

      await inTenant(orgId, (tx) => repository.recordSuccess(tx, orgId, id, now));
      expect(await connectionsOf(orgId)).toMatchObject([
        { circuitOpenUntil: null, failureCount: 0, health: 'healthy', lastVerifiedAt: now },
      ]);

      await setConnection({ failureCount: 4, health: 'needs_reauth' });
      await fail();
      expect(await connectionsOf(orgId)).toMatchObject([
        { failureCount: 5, health: 'needs_reauth' },
      ]);
      await inTenant(orgId, (tx) => repository.recordSuccess(tx, orgId, id, now));
      expect(await connectionsOf(orgId)).toMatchObject([
        { failureCount: 0, health: 'needs_reauth' },
      ]);
    });

    it('listRepositories answers one GitHub page filtered by name, a page-number cursor, and refuses a bad one', async () => {
      await connect();
      fixture.repositories.clear();
      for (let index = 0; index < 101; index++) {
        const name = index === 3 ? 'Forge-Web' : `repo-${String(index).padStart(3, '0')}`;

        fixture.repositories.set(index + 1, {
          branches: {},
          default_branch: 'main',
          full_name: `acme/${name}`,
          id: index + 1,
          name,
          owner: { login: 'acme' },
          private: true,
        });
      }

      const first = await inTenant(orgId, (tx) => service.listRepositories(tx, orgId, {}));

      expect(first.repositories).toHaveLength(100);
      expect(first.nextCursor).toBe('2');
      expect(first.repositories[0]).toEqual({
        defaultBranch: 'main',
        fullName: 'acme/repo-000',
        id: 1,
        name: 'repo-000',
        owner: 'acme',
        private: true,
      });

      const second = await inTenant(orgId, (tx) =>
        service.listRepositories(tx, orgId, { cursor: first.nextCursor }),
      );

      expect(second.repositories.map((repository) => repository.id)).toEqual([101]);
      expect(second.nextCursor).toBeUndefined();

      const filtered = await inTenant(orgId, (tx) =>
        service.listRepositories(tx, orgId, { query: 'forge' }),
      );

      expect(filtered.repositories.map((repository) => repository.name)).toEqual(['Forge-Web']);

      await expect(
        inTenant(orgId, (tx) => service.listRepositories(tx, orgId, { cursor: 'x' })),
      ).rejects.toMatchObject({ type: 'bad-request' });

      expect(
        fixture.requests.filter((request) => request.path === '/installation/repositories'),
      ).toHaveLength(3);
      expect(JSON.stringify([first, second, filtered])).not.toMatch(/ghs_/u);
    });

    /** T039 (US4, R9/R10): verify-on-use through the one-repository mint, and the breaker it feeds. */
    describe('verify-on-use', () => {
      /**
       * As the push consumer does (R9): the refusal is caught inside the transaction so the
       * health write it made commits; the refusal itself is answered, not thrown.
       */
      const mintRepoToken = () =>
        inTenant(orgId, async (tx) => {
          try {
            await service.repositoryToken(tx, orgId, 1);

            return undefined;
          } catch (error) {
            return error;
          }
        });

      it('five transient failures at the mint open the circuit; the sixth request is refused fast from the row; a success closes it — each transition audited once', async () => {
        const { id } = await connect();

        for (let n = 0; n < 5; n += 1) {
          fixture.override.status = 503;
          expect(await mintRepoToken()).toMatchObject({
            extensions: { reason: 'provider-unavailable' },
            type: 'service-unavailable',
          });
        }
        expect(await connectionsOf(orgId)).toMatchObject([
          { failureCount: 5, health: 'unavailable', id },
        ]);

        const requestsBefore = fixture.requests.length;
        const started = Date.now();

        expect(await mintRepoToken()).toMatchObject({
          extensions: { reason: 'provider-unavailable' },
          retryAfterSeconds: expect.toSatisfy((s: number) => s > 590 && s <= 600) as number,
          type: 'service-unavailable',
        });
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(fixture.requests.length).toBe(requestsBefore);

        // The window elapsed: the next use reaches GitHub, and its success closes the circuit.
        await setConnection({ circuitOpenUntil: new Date(Date.now() - 1_000) });
        expect(await mintRepoToken()).toBeUndefined();
        expect(await connectionsOf(orgId)).toMatchObject([
          { circuitOpenUntil: null, failureCount: 0, health: 'healthy' },
        ]);
        await expect(auditActions(orgId)).resolves.toEqual([
          'connector.connected',
          'connector.health-changed',
          'connector.health-changed',
        ]);
      });

      it('SC-009: a mint refused because the installation is gone moves the row to needs_reauth at once, audited once', async () => {
        await connect();
        fixture.installations.delete(INSTALLATION_ID);

        expect(await mintRepoToken()).toMatchObject({
          extensions: { reason: 'needs-reauth' },
          type: 'conflict',
        });
        expect(await connectionsOf(orgId)).toMatchObject([{ health: 'needs_reauth' }]);

        // The gate refuses before any mint: no second transition, no second audit entry.
        expect(await mintRepoToken()).toMatchObject({
          extensions: { reason: 'needs-reauth' },
        });
        await expect(auditActions(orgId)).resolves.toEqual([
          'connector.connected',
          'connector.health-changed',
        ]);
      });

      it('verify answers the row: revoked → needs_reauth (audited once across two checks); a 5xx counts a failure; restored → healthy again with a fresh token', async () => {
        const { id, secretId } = await connect();
        const check = () => inTenant(orgId, (tx) => service.verify(tx, orgId, id, userId));

        fixture.override.status = 503;
        await expect(check()).resolves.toMatchObject({ failureCount: 1, health: 'healthy' });

        fixture.installations.delete(INSTALLATION_ID);
        await expect(check()).resolves.toMatchObject({ health: 'needs_reauth' });
        await expect(check()).resolves.toMatchObject({ health: 'needs_reauth' });

        fixture.installations.set(INSTALLATION_ID, { account: ACCOUNT, id: INSTALLATION_ID });
        const restored = await check();

        expect(restored).toMatchObject({
          circuitOpenUntil: null,
          failureCount: 0,
          health: 'healthy',
        });
        // The token GitHub minted at install expires within the day: the check re-minted it.
        expect(restored.secretId).not.toBe(secretId);
        expect(await secretsOf(orgId)).toHaveLength(1);
        await expect(auditActions(orgId)).resolves.toEqual([
          'connector.connected',
          'connector.health-changed',
          'connector.health-changed',
        ]);
      });

      it('a re-mint that fails after a 200 installation check answers the row instead of throwing', async () => {
        const { id } = await connect();
        const github = moduleRef.get<GithubAppClient>(GITHUB_APP_CLIENT, { strict: false });
        vi.spyOn(github, 'mintToken').mockRejectedValueOnce(new GithubApiError('unavailable', 503));

        try {
          await expect(
            inTenant(orgId, (tx) => service.verify(tx, orgId, id, userId)),
          ).resolves.toMatchObject({ failureCount: 1, health: 'healthy', id });
        } finally {
          vi.restoreAllMocks();
        }
      });
    });

    /** T040 (US4 scenario 3, R13): a reconnect restores the links a removal left disconnected. */
    describe('reconnect restores links', () => {
      const linksOf = () =>
        inTenant(orgId, (tx) =>
          tx.select().from(schema.repoLinks).where(eq(schema.repoLinks.orgId, orgId)),
        );

      it('the same account: the disconnected links point at the new row and are linked again, audited as connector.reconnected', async () => {
        const first = await connect();

        await link(first.id);
        await removeConnection(moduleRef, orgId, userId, first.id);
        expect(await linksOf()).toMatchObject([{ connectionId: null, state: 'disconnected' }]);

        fixture.installations.set(INSTALLATION_ID, { account: ACCOUNT, id: INSTALLATION_ID });
        const second = await connect();

        expect(await linksOf()).toMatchObject([{ connectionId: second.id, state: 'linked' }]);
        await expect(auditActions(orgId)).resolves.toEqual([
          'connector.connected',
          'connector.removed',
          'connector.reconnected',
        ]);
      });

      it('a different account leaves them disconnected', async () => {
        const first = await connect();

        await link(first.id);
        await removeConnection(moduleRef, orgId, userId, first.id);

        fixture.installations.set(INSTALLATION_ID, {
          account: { id: 9002, login: 'jane', type: 'User' },
          id: INSTALLATION_ID,
        });
        await connect();

        expect(await linksOf()).toMatchObject([{ connectionId: null, state: 'disconnected' }]);
        await expect(auditActions(orgId)).resolves.toEqual([
          'connector.connected',
          'connector.removed',
          'connector.connected',
        ]);
      });
    });

    describe('the provider-generic path (spec 030)', () => {
      const TOKEN = 'napi_k3m9x2q7w4p8r1t6v5n0b3l7c2y9z4d8f1g6h5j0';

      function paste(provider: (typeof PASTED)[number] = 'neon', token = TOKEN) {
        return inTenant(orgId, (tx) =>
          service.connectWithToken(tx, orgId, userId, provider, token),
        );
      }

      beforeEach(() => {
        verifier.seen = [];
        verifier.next = {
          accountName: 'Acme',
          accountRef: 'org-acme',
          kind: 'verified',
          scopes: ['projects:read'],
        };
      });

      it('paste → verify → seal under connector:<provider>:<kind> → upsert with account_ref and granted_scopes, audited with the provider', async () => {
        const row = await paste();

        expect(verifier.seen).toEqual([TOKEN]);
        expect(row).toMatchObject({
          accountId: null,
          accountLogin: 'Acme',
          accountRef: 'org-acme',
          authType: 'token',
          grantedScopes: ['projects:read'],
          health: 'healthy',
          installationId: null,
          provider: 'neon',
          removalRequestedAt: null,
        });

        const secrets = await secretsOf(orgId);

        expect(secrets).toHaveLength(1);
        expect(secrets[0]).toMatchObject({ id: row.secretId, purpose: 'connector:neon:api-key' });

        const opened = await inTenant(orgId, (tx) =>
          dek.openSecret(tx, orgId, 'connector:neon:api-key', secrets[0]!),
        );

        expect(revealPlaintext(opened).toString('utf8')).toBe(TOKEN);
        await expect(auditActions(orgId)).resolves.toEqual(['connector.connected']);

        const [audit] = await inTenant(orgId, (tx) =>
          tx
            .select({ metadata: schema.auditLog.metadata })
            .from(schema.auditLog)
            .where(
              and(eq(schema.auditLog.orgId, orgId), gt(schema.auditLog.createdAt, auditSince)),
            ),
        );

        expect(audit?.metadata).toMatchObject({ accountRef: 'org-acme', provider: 'neon' });
        expect(JSON.stringify(audit?.metadata)).not.toContain(TOKEN);
      });

      it('names the purpose of each provider credential (data-model § 6)', () => {
        expect(PASTED.map((provider) => credentialPurpose(provider))).toEqual([
          'connector:netlify:token',
          'connector:neon:api-key',
          'connector:resend:api-key',
          'connector:cloudflare:api-token',
        ]);
        expect(credentialPurpose('supabase')).toBe('connector:supabase:oauth-grant');
      });

      it('missing-scope is refused naming what is missing, and stores nothing', async () => {
        verifier.next = { kind: 'missing-scope', missing: ['full_access'] };

        await expect(paste('resend', 're_4kQz9Xw2Lm7Pv3Rt8Ny5Bc1D')).rejects.toMatchObject({
          extensions: { missing: ['full_access'], reason: 'missing-scope' },
          type: 'validation-failed',
        });
        await expect(connectionsOf(orgId)).resolves.toEqual([]);
        await expect(secretsOf(orgId)).resolves.toEqual([]);
        await expect(auditActions(orgId)).resolves.toEqual([]);
      });

      it('a revoked token is refused as provider-refused, and stores nothing', async () => {
        verifier.next = { kind: 'revoked' };

        await expect(paste()).rejects.toMatchObject({
          extensions: { reason: 'provider-refused' },
          type: 'validation-failed',
        });
        await expect(connectionsOf(orgId)).resolves.toEqual([]);
        await expect(secretsOf(orgId)).resolves.toEqual([]);
      });

      it('a provider that does not answer refuses the connect as provider-unavailable, storing nothing', async () => {
        verifier.next = { category: 'unavailable', kind: 'failed' };

        await expect(paste()).rejects.toMatchObject({
          extensions: { reason: 'provider-unavailable' },
          type: 'service-unavailable',
        });
        await expect(connectionsOf(orgId)).resolves.toEqual([]);
      });

      it('a second paste replaces the row and the secret, and audits connector.reconnected', async () => {
        const first = await paste();

        verifier.next = {
          accountName: 'Acme 2',
          accountRef: 'org-acme-2',
          kind: 'verified',
          scopes: ['projects:read', 'branches:write'],
        };

        const second = await paste('neon', `${TOKEN}x`);

        expect(second.id).toBe(first.id);
        expect(second.secretId).not.toBe(first.secretId);
        expect(second).toMatchObject({
          accountRef: 'org-acme-2',
          grantedScopes: ['projects:read', 'branches:write'],
        });

        const secrets = await secretsOf(orgId);

        expect(secrets.map((secret) => secret.id)).toEqual([second.secretId]);
        await expect(auditActions(orgId)).resolves.toEqual([
          'connector.connected',
          'connector.reconnected',
        ]);
      });

      /** SC-002's sibling, 018 SC-003: `{ orgId, purpose }` is bound into every seal. */
      it('each new purpose fails to open under another purpose or another org (AAD probe)', async () => {
        for (const provider of PASTED) {
          await paste(provider, `${provider}-${TOKEN}`);
        }

        const secrets = await secretsOf(orgId);

        expect(secrets.map((secret) => secret.purpose).sort()).toEqual(
          PASTED.map((provider) => credentialPurpose(provider)).sort(),
        );

        for (const sealed of secrets) {
          for (const provider of [...PASTED, 'supabase' as const]) {
            const purpose = credentialPurpose(provider);

            if (purpose === sealed.purpose) continue;

            await expect(
              inTenant(orgId, (tx) => dek.openSecret(tx, orgId, purpose, sealed)),
            ).rejects.toBeInstanceOf(SecretDecryptionError);
          }

          const copied = await inTenant(otherOrgId, async (tx) => {
            const { dekId } = await dek.ensureDek(tx, otherOrgId);
            const [row] = await tx
              .insert(schema.secrets)
              .values({ ...sealed, dekId, id: undefined, orgId: otherOrgId })
              .returning();

            return row!;
          });

          await expect(
            inTenant(otherOrgId, (tx) => dek.openSecret(tx, otherOrgId, sealed.purpose, copied)),
          ).rejects.toBeInstanceOf(SecretDecryptionError);
        }

        await inTenant(otherOrgId, (tx) =>
          tx.delete(schema.secrets).where(eq(schema.secrets.orgId, otherOrgId)),
        );
      });

      it('ensureUsable takes the provider: disconnected with no row, removing while a removal runs', async () => {
        await expect(
          inTenant(orgId, (tx) => service.ensureUsable(tx, orgId, 'neon')),
        ).rejects.toMatchObject({ extensions: { reason: 'disconnected' }, type: 'conflict' });

        const row = await paste();

        await expect(
          inTenant(orgId, (tx) => service.ensureUsable(tx, orgId, 'neon')),
        ).resolves.toMatchObject({ id: row.id });

        await setConnection({ removalRequestedAt: new Date() });
        await expect(
          inTenant(orgId, (tx) => service.ensureUsable(tx, orgId, 'neon')),
        ).rejects.toMatchObject({ extensions: { reason: 'removing' }, type: 'conflict' });
      });

      it('toContract answers the provider arm with scopes and never the token', async () => {
        await paste();

        const [record] = await inTenant(orgId, (tx) => service.list(tx, orgId));
        const contract = service.toContract(record!);

        expect(contract).toMatchObject({
          account: { name: 'Acme', ref: 'org-acme' },
          authType: 'token',
          failedResources: [],
          provider: 'neon',
          removalRequestedAt: null,
          scopes: ['projects:read'],
        });
        expect(JSON.stringify(contract)).not.toContain(TOKEN);
      });

      it('verify dispatches through the provider verifier: revoked → needs_reauth, audited once', async () => {
        const row = await paste();

        verifier.next = { kind: 'revoked' };

        const checked = await inTenant(orgId, (tx) => service.verify(tx, orgId, row.id, userId));

        expect(checked.health).toBe('needs_reauth');
        expect(verifier.seen).toEqual([TOKEN, TOKEN]);
        await expect(auditActions(orgId)).resolves.toEqual([
          'connector.connected',
          'connector.health-changed',
        ]);
      });

      it('lists a GitHub row whose removal is requested nowhere', async () => {
        await connect();
        await setConnection({ removalRequestedAt: new Date() });

        await expect(inTenant(orgId, (tx) => service.list(tx, orgId))).resolves.toEqual([]);
      });
    });

    /** Spec 030 T039 / T040 (TDD, crypto boundary): Supabase OAuth with PKCE and its refresh. */
    describe('Supabase (spec 030 R1, R10)', () => {
      beforeEach(() => supabaseFixture.reset());

      async function install(): Promise<{ code: string; state: string }> {
        const { url } = await service.beginSupabaseInstall(orgId, userId);
        const response = await fetch(url, { redirect: 'manual' });
        const back = new URL(response.headers.get('location')!);

        return { code: back.searchParams.get('code')!, state: back.searchParams.get('state')! };
      }

      function complete(body: { code: string; state: string }) {
        return inTenant(orgId, (tx) => service.completeSupabaseInstall(tx, orgId, userId, body));
      }

      it('install answers an authorize URL with state and an S256 challenge; the verifier stays server-side', async () => {
        const { url } = await service.beginSupabaseInstall(orgId, userId);
        const params = new URL(url).searchParams;

        expect(params.get('code_challenge_method')).toBe('S256');
        expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect(params.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect(url).not.toMatch(/verifier/u);
      });

      it('install is 501 oauth-provider-not-configured without the client pair', async () => {
        const client = moduleRef.get<SupabaseClient>(SUPABASE_CLIENT, { strict: false });
        const spy = vi.spyOn(client, 'isConfigured').mockReturnValue(false);

        await expect(service.beginSupabaseInstall(orgId, userId)).rejects.toMatchObject({
          type: 'oauth-provider-not-configured',
        });
        spy.mockRestore();
      });

      it('complete seals the grant as JSON under connector:supabase:oauth-grant with its expiry, auth_type oauth', async () => {
        const before = Date.now();
        const row = await complete(await install());

        expect(row).toMatchObject({
          accountRef: 'sb-org-1',
          authType: 'oauth',
          grantedScopes: ['projects:read', 'secrets:read', 'database:write'],
          provider: 'supabase',
        });
        expect(row.tokenExpiresAt!.getTime()).toBeGreaterThanOrEqual(before + 3_590_000);

        const [secret] = await secretsOf(orgId);

        expect(secret?.purpose).toBe('connector:supabase:oauth-grant');

        const opened = await inTenant(orgId, (tx) =>
          dek.openSecret(tx, orgId, 'connector:supabase:oauth-grant', secret!),
        );
        const grant = JSON.parse(revealPlaintext(opened).toString('utf8')) as Record<
          string,
          string
        >;

        expect(Object.keys(grant).sort()).toEqual(['accessToken', 'refreshToken']);
        expect(supabaseFixture.accessTokens.has(grant.accessToken!)).toBe(true);
        expect(JSON.stringify(service.toContract(row))).not.toContain(grant.accessToken);
        await expect(auditActions(orgId)).resolves.toEqual(['connector.connected']);
      });

      it('a replayed state is oauth-state-invalid and stores nothing more', async () => {
        const first = await install();

        await complete(first);
        await expect(complete(first)).rejects.toMatchObject({ type: 'oauth-state-invalid' });
        await expect(connectionsOf(orgId)).resolves.toHaveLength(1);
      });

      it('a GitHub state is refused by the Supabase complete', async () => {
        const state = await states.issue(orgId, userId);

        await expect(complete({ code: 'x', state })).rejects.toMatchObject({
          type: 'oauth-state-invalid',
        });
      });

      it('ten concurrent callers near expiry cost one refresh at the fixture (single-flight)', async () => {
        await complete(await install());
        await setConnection({ tokenExpiresAt: new Date(Date.now() + 60_000) });

        const tokens = await Promise.all(
          Array.from({ length: 10 }, () =>
            inTenant(orgId, (tx) => service.currentToken(tx, orgId, 'supabase')),
          ),
        );

        expect(supabaseFixture.refreshCount).toBe(1);
        expect(new Set(tokens.map((t) => revealPlaintext(t).toString('utf8'))).size).toBe(1);
        expect(await secretsOf(orgId)).toHaveLength(1);

        const [row] = await connectionsOf(orgId);

        expect(row!.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 3_000_000);
      });

      it('a token far from expiry is opened, not refreshed', async () => {
        await complete(await install());
        await inTenant(orgId, (tx) => service.currentToken(tx, orgId, 'supabase'));

        expect(supabaseFixture.refreshCount).toBe(0);
      });

      it('a refused refresh grant moves the row to needs_reauth, audited once', async () => {
        await complete(await install());
        await setConnection({ tokenExpiresAt: new Date(Date.now() + 60_000) });
        supabaseFixture.refreshTokens.clear();

        const refused = await inTenant(orgId, (tx) =>
          service.currentToken(tx, orgId, 'supabase').catch((error: unknown) => error),
        );

        expect(refused).toMatchObject({ extensions: { reason: 'needs-reauth' } });
        await expect(connectionsOf(orgId)).resolves.toMatchObject([{ health: 'needs_reauth' }]);
        await expect(auditActions(orgId)).resolves.toEqual([
          'connector.connected',
          'connector.health-changed',
        ]);
      });
    });

    /** Spec 030 T041: removal is requested, then finished by `connection_remove` (§ 7). */
    describe('requestRemoval (spec 030 § 7)', () => {
      const releasers = () =>
        moduleRef.get<Map<string, ResourceReleaser>>(RESOURCE_RELEASERS, { strict: false });

      afterEach(() => releasers().clear());

      async function pasteNeon() {
        return inTenant(orgId, (tx) =>
          service.connectWithToken(tx, orgId, userId, 'neon', 'napi_removal0123456789abcdef'),
        );
      }

      async function branch(connectionId: string, name: string) {
        return inTenant(orgId, async (tx) => {
          const [binding] = await tx
            .insert(schema.connectorBindings)
            .values({
              boundBy: userId,
              config: {},
              connectionId,
              orgId,
              projectId,
              provider: 'neon',
              state: 'bound',
            })
            .onConflictDoUpdate({
              set: { connectionId, state: 'bound' },
              target: [
                schema.connectorBindings.orgId,
                schema.connectorBindings.projectId,
                schema.connectorBindings.provider,
              ],
            })
            .returning();
          const [resource] = await tx
            .insert(schema.connectorResources)
            .values({
              bindingId: binding!.id,
              connectionId,
              externalId: `br-${name}`,
              kind: 'neon_branch',
              name,
              orgId,
              state: 'live',
            })
            .returning();

          return { binding: binding!, resource: resource! };
        });
      }

      it('after the request new work is refused with removing, and one connection_remove is queued', async () => {
        const row = await pasteNeon();

        const operation = await inTenant(orgId, (tx) =>
          service.requestRemoval(tx, orgId, userId, row.id),
        );

        expect(operation).toMatchObject({
          externalRef: row.id,
          kind: 'connection_remove',
          requestedBy: userId,
          state: 'queued',
        });
        await expect(
          inTenant(orgId, (tx) => service.ensureUsable(tx, orgId, 'neon')),
        ).rejects.toMatchObject({ extensions: { reason: 'removing' }, type: 'conflict' });
        await expect(
          inTenant(orgId, (tx) => service.requestRemoval(tx, orgId, userId, row.id)),
        ).rejects.toMatchObject({ extensions: { reason: 'in-flight' } });
        await expect(secretsOf(orgId)).resolves.toHaveLength(1);
      });

      it('releases every live resource with the secret still sealed, then deletes the secret and the row, bindings disconnected', async () => {
        const row = await pasteNeon();
        const { binding, resource } = await branch(row.id, 'forge-preview-a');
        const secretsAtRelease: number[] = [];
        const released: string[] = [];

        releasers().set('neon_branch', {
          release: async (credential, target) => {
            released.push(`${target.externalId}:${revealPlaintext(credential).toString('utf8')}`);
            secretsAtRelease.push((await secretsOf(orgId)).length);
          },
        });

        await removeConnection(moduleRef, orgId, userId, row.id);

        expect(released).toEqual([`${resource.externalId}:napi_removal0123456789abcdef`]);
        expect(secretsAtRelease).toEqual([1]);
        await expect(secretsOf(orgId)).resolves.toEqual([]);
        await expect(connectionsOf(orgId)).resolves.toEqual([]);

        const [after] = await inTenant(orgId, (tx) =>
          tx
            .select()
            .from(schema.connectorResources)
            .where(eq(schema.connectorResources.id, resource.id)),
        );
        const [bindingAfter] = await inTenant(orgId, (tx) =>
          tx
            .select()
            .from(schema.connectorBindings)
            .where(eq(schema.connectorBindings.id, binding.id)),
        );

        expect(after).toMatchObject({ connectionId: null, state: 'released' });
        expect(after!.releasedAt).not.toBeNull();
        expect(bindingAfter).toMatchObject({ connectionId: null, state: 'disconnected' });
        await expect(auditActions(orgId)).resolves.toEqual([
          'connector.connected',
          'connector.removed',
        ]);
      });

      it('a terminal release failure leaves that resource failed, and the removal completes naming it', async () => {
        const row = await pasteNeon();

        await branch(row.id, 'forge-preview-b');
        releasers().set('neon_branch', {
          release: () => Promise.reject(new ProviderFailure('validation')),
        });

        await removeConnection(moduleRef, orgId, userId, row.id);

        await expect(connectionsOf(orgId)).resolves.toEqual([]);

        const [audit] = await inTenant(orgId, (tx) =>
          tx
            .select({ metadata: schema.auditLog.metadata })
            .from(schema.auditLog)
            .where(
              and(
                eq(schema.auditLog.orgId, orgId),
                eq(schema.auditLog.action, 'connector.removed'),
                gt(schema.auditLog.createdAt, auditSince),
              ),
            ),
        );

        expect(audit?.metadata).toMatchObject({
          failedResources: [{ kind: 'neon_branch', name: 'forge-preview-b' }],
          provider: 'neon',
        });
      });

      it('a Supabase removal revokes the grant at the provider', async () => {
        supabaseFixture.reset();
        const { url } = await service.beginSupabaseInstall(orgId, userId);
        const back = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location')!);
        const row = await inTenant(orgId, (tx) =>
          service.completeSupabaseInstall(tx, orgId, userId, {
            code: back.searchParams.get('code')!,
            state: back.searchParams.get('state')!,
          }),
        );

        expect(supabaseFixture.refreshTokens.size).toBe(1);
        await removeConnection(moduleRef, orgId, userId, row.id);

        expect(supabaseFixture.requests.at(-1)).toMatchObject({
          method: 'POST',
          path: '/v1/oauth/revoke',
        });
        expect(supabaseFixture.refreshTokens.size).toBe(0);
        await expect(connectionsOf(orgId)).resolves.toEqual([]);
      });
    });
  });
});
