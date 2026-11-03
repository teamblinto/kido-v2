import { schema } from '@repo/db';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import {
  type ConnectorsHarness,
  INSTALLATION_ID,
  ORG_ACCOUNT,
  startConnectorsHarness,
} from '../../../test/fixtures/connectors-harness';
import type { TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import type { Envelope } from '../outbox/envelope';
import { OrgService } from '../tenancy/services/org.service';
import { ConnectionService } from './connection.service';
import {
  ConnectorHealthConsumer,
  RESEND_DOMAIN_READER,
  type ResendDomainReader,
  STALE_OPERATION_MS,
  STALE_RUNNING_MS,
  staleAfter,
  VERIFIED_WITHIN_MS,
} from './connector-health.consumer';
import { PROVIDER_VERIFIERS, type ProviderVerifier, type VerifyResult } from './providers/provider';
import { SyncRepository } from './sync.repository';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

if (!postgres || !redis) {
  console.warn('SKIPPING connector-health.consumer.spec.ts: Postgres or Redis is not reachable');
}

function due(job: Envelope<'maintenance.due'>['payload']['job']): Envelope<'maintenance.due'> {
  const periodStart = new Date().toISOString();

  return {
    aggregate: 'maintenance',
    aggregateId: `${job}:${periodStart}`,
    eventId: randomUUID(),
    occurredAt: periodStart,
    orgId: null,
    payload: { job, periodStart },
    traceId: null,
    type: 'maintenance.due',
  };
}

/**
 * Spec 018 US4 (R9, SC-009): the daily sweep driven by hand against Postgres and the fixture
 * GitHub — the row it moves, the one audit entry per transition, and the stuck operation it
 * closes (R7).
 */
describe('ConnectorHealthConsumer', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and the fixture GitHub', () => {
    let harness: ConnectorsHarness;
    let consumer: ConnectorHealthConsumer;
    let operations: SyncRepository;

    const tick = async (
      job: Envelope<'maintenance.due'>['payload']['job'] = 'connector.verify',
    ) => {
      const event = due(job);
      const handled = await consumer.handle(event);
      await consumer.effect(event, handled);
    };
    const connections = () =>
      harness.inTenant((tx) =>
        tx.select().from(schema.connections).where(eq(schema.connections.orgId, harness.orgId)),
      );

    beforeAll(async () => {
      harness = await startConnectorsHarness();
      consumer = harness.moduleRef.get(ConnectorHealthConsumer, { strict: false });
      operations = harness.moduleRef.get(SyncRepository, { strict: false });
      // Ten minutes: the harness waits for the outbox suite lock behind every suite that relays.
    }, 600_000);

    afterAll(async () => {
      await harness?.close();
    });

    beforeEach(() => harness.reset());

    /** Installs, then ages the row past the sweep's skip window (a fresh install was just verified). */
    async function connectAged() {
      const row = await harness.connect();
      await harness.inTenant((tx) =>
        tx
          .update(schema.connections)
          .set({ lastVerifiedAt: new Date(Date.now() - VERIFIED_WITHIN_MS - 60_000) })
          .where(eq(schema.connections.orgId, harness.orgId)),
      );

      return row;
    }

    it('SC-009: a credential revoked at GitHub reads needs_reauth after one tick, and the transition is audited once across two ticks', async () => {
      await connectAged();
      harness.fixture.installations.delete(INSTALLATION_ID);

      await tick();
      expect(await connections()).toMatchObject([{ health: 'needs_reauth' }]);

      await tick();
      expect(await connections()).toMatchObject([{ health: 'needs_reauth' }]);
      await expect(harness.auditActions()).resolves.toEqual([
        'connector.connected',
        'connector.health-changed',
      ]);
    });

    it('a row verified within the hour is left alone; a transient failure counts toward the breaker; a 200 clears it and re-mints the token', async () => {
      const { id } = await harness.connect();
      const [before] = await connections();

      harness.fixture.override.status = 503;
      await tick();
      expect(await connections()).toMatchObject([{ failureCount: 0, health: 'healthy', id }]);
      expect(harness.fixture.override.status).toBe(503);

      await harness.inTenant((tx) =>
        tx
          .update(schema.connections)
          .set({ lastVerifiedAt: new Date(Date.now() - VERIFIED_WITHIN_MS - 60_000) })
          .where(eq(schema.connections.orgId, harness.orgId)),
      );
      await tick();
      expect(await connections()).toMatchObject([{ failureCount: 1, health: 'healthy', id }]);

      await tick();
      const [after] = await connections();

      expect(after).toMatchObject({ circuitOpenUntil: null, failureCount: 0, health: 'healthy' });
      expect(after!.secretId).not.toBe(before!.secretId);
      await expect(harness.auditActions()).resolves.toEqual(['connector.connected']);
    });

    it('R7: a running operation older than fifteen minutes is closed as failed / timed-out; a fresh one is left alone', async () => {
      const { id } = await connectAged();
      const [link] = await harness.inTenant((tx) =>
        tx
          .insert(schema.repoLinks)
          .values({
            branch: 'main',
            connectionId: id,
            linkedBy: harness.userId,
            name: 'site',
            orgId: harness.orgId,
            owner: ORG_ACCOUNT.login,
            projectId: harness.projectId,
            repoId: 1,
            state: 'linked',
          })
          .returning({ id: schema.repoLinks.id }),
      );
      const insert = (startedAt: Date) =>
        harness.inTenant(async (tx) => {
          const [row] = await tx
            .insert(schema.syncOperations)
            .values({
              kind: 'push',
              linkId: link!.id,
              orgId: harness.orgId,
              projectId: harness.projectId,
              requestedBy: harness.userId,
              startedAt,
              state: 'running',
            })
            .returning({ id: schema.syncOperations.id });

          return row!.id;
        });
      const stale = await insert(new Date(Date.now() - STALE_RUNNING_MS - 60_000));

      await tick();

      const row = await harness.inTenant((tx) => operations.byId(tx, harness.orgId, stale));
      expect(row).toMatchObject({ reason: 'timed-out', state: 'failed' });

      const fresh = await insert(new Date());
      await tick();
      await expect(
        harness.inTenant((tx) => operations.byId(tx, harness.orgId, fresh)),
      ).resolves.toMatchObject({ state: 'running' });
    });

    it('one organisation throwing does not stop the next one being verified', async () => {
      await connectAged();
      harness.fixture.installations.delete(INSTALLATION_ID);
      const other = await harness.moduleRef
        .get(OrgService)
        .create(harness.userId, { name: 'Other', slug: `018o-${randomUUID().slice(0, 8)}` });
      const staleRunning = operations.staleRunning.bind(operations);
      vi.spyOn(operations, 'staleRunning').mockImplementation((tx, orgId, olderThan) =>
        orgId === harness.orgId
          ? staleRunning(tx, orgId, olderThan)
          : Promise.reject(new Error(`org ${orgId} is broken`)),
      );

      try {
        await tick();
      } finally {
        vi.restoreAllMocks();
        await harness.database.delete(schema.orgs).where(eq(schema.orgs.id, other.id));
      }

      expect(await connections()).toMatchObject([{ health: 'needs_reauth' }]);
    });

    it('leaves webhook.retention to the webhooks module (spec 029 T089)', async () => {
      await expect(consumer.handle(due('webhook.retention'))).resolves.toBeUndefined();
    });

    it('ignores every other maintenance job', async () => {
      await connectAged();
      harness.fixture.installations.delete(INSTALLATION_ID);
      const requests = harness.fixture.requests.length;

      await tick('sandbox.sweep');

      expect(harness.fixture.requests.length).toBe(requests);
      expect(await connections()).toMatchObject([{ health: 'healthy' }]);
    });
  });
});

/** A verifier scripted per test, standing in for every non-GitHub provider (spec 030 US6). */
let verdict: VerifyResult = {
  accountName: 'Acme',
  accountRef: 'acct-acme',
  kind: 'verified',
  scopes: ['full_access'],
};
const scriptedVerifier: ProviderVerifier = { verify: () => Promise.resolve(verdict) };
const PROVIDERS = ['netlify', 'neon', 'supabase', 'resend', 'cloudflare'] as const;

/** The Resend domain's status as the provider reports it, per test. */
let domainStatus = 'pending';
const domainReader: ResendDomainReader = {
  domainStatus: () => Promise.resolve(domainStatus),
};

/**
 * Spec 030 US6 (SC-007): the sweep over the five new providers through `PROVIDER_VERIFIERS`, the
 * `connector.ops-timeout` job, the pending-Resend-domain re-check and the deleted-org arm.
 */
describe('ConnectorHealthConsumer (spec 030)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres with scripted providers', () => {
    let harness: ConnectorsHarness;
    let consumer: ConnectorHealthConsumer;
    let connectionService: ConnectionService;

    const tick = async (job: Envelope<'maintenance.due'>['payload']['job']) => {
      const event = due(job);
      const handled = await consumer.handle(event);
      await consumer.effect(event, handled);
    };
    const aged = () => new Date(Date.now() - VERIFIED_WITHIN_MS - 60_000);

    async function connect(provider: (typeof PROVIDERS)[number], orgId = harness.orgId) {
      verdict = { accountName: 'Acme', accountRef: 'acct-acme', kind: 'verified', scopes: [] };
      const run = <T>(fn: (tx: TenantTransaction) => Promise<T>) =>
        orgId === harness.orgId
          ? harness.inTenant(fn)
          : harness.moduleRef.get(TenantTransactionRunner).runInTenantTransaction(orgId, fn);

      return run(async (tx) => {
        const row = await connectionService.connectWithToken(
          tx,
          orgId,
          harness.userId,
          provider,
          // Supabase's sealed secret is its OAuth grant, still fresh (no refresh call).
          provider === 'supabase'
            ? JSON.stringify({ accessToken: `sbp_${randomUUID()}`, refreshToken: 'r' })
            : `tok-${provider}-${randomUUID()}`,
        );
        await tx
          .update(schema.connections)
          .set({
            lastVerifiedAt: aged(),
            tokenExpiresAt: provider === 'supabase' ? new Date(Date.now() + 3_600_000) : null,
          })
          .where(eq(schema.connections.id, row.id));

        return row;
      });
    }

    const rows = () =>
      harness.inTenant((tx) =>
        tx.select().from(schema.connections).where(eq(schema.connections.orgId, harness.orgId)),
      );
    const age = () =>
      harness.inTenant((tx) =>
        tx
          .update(schema.connections)
          .set({ lastVerifiedAt: aged() })
          .where(eq(schema.connections.orgId, harness.orgId)),
      );
    const operationsOf = (orgId = harness.orgId) =>
      harness.moduleRef
        .get(TenantTransactionRunner)
        .runInTenantTransaction(orgId, (tx) =>
          tx
            .select()
            .from(schema.connectorOperations)
            .where(eq(schema.connectorOperations.orgId, orgId)),
        );

    beforeAll(async () => {
      harness = await startConnectorsHarness({
        override: (builder) =>
          builder
            .overrideProvider(PROVIDER_VERIFIERS)
            .useValue(new Map(PROVIDERS.map((provider) => [provider, scriptedVerifier])))
            .overrideProvider(RESEND_DOMAIN_READER)
            .useValue(domainReader),
      });
      consumer = harness.moduleRef.get(ConnectorHealthConsumer, { strict: false });
      connectionService = harness.moduleRef.get(ConnectionService, { strict: false });
    }, 600_000);

    afterAll(async () => {
      await harness?.close();
    });

    beforeEach(async () => {
      domainStatus = 'pending';
      await harness.inTenant(async (tx) => {
        await tx
          .delete(schema.connectorOperations)
          .where(eq(schema.connectorOperations.orgId, harness.orgId));
        await tx
          .delete(schema.connectorResources)
          .where(eq(schema.connectorResources.orgId, harness.orgId));
        await tx
          .delete(schema.connectorBindings)
          .where(eq(schema.connectorBindings.orgId, harness.orgId));
      });
      await harness.reset();
    });

    it('SC-007: each new provider is verified through PROVIDER_VERIFIERS; revoked → needs_reauth, audited once across two ticks', async () => {
      for (const provider of PROVIDERS) await connect(provider);

      verdict = { kind: 'revoked' };
      await tick('connector.verify');
      await age();
      await tick('connector.verify');

      const after = await rows();
      expect(after.map((row) => row.provider).sort()).toEqual([...PROVIDERS].sort());
      expect(after.map((row) => [row.provider, row.health])).toEqual(
        after.map((row) => [row.provider, 'needs_reauth']),
      );
      const changes = (await harness.auditActions()).filter(
        (action) => action === 'connector.health-changed',
      );
      expect(changes).toHaveLength(PROVIDERS.length);
    });

    it('five failures open the circuit; a success closes it', async () => {
      await connect('neon');
      verdict = { category: 'unavailable', kind: 'failed' };

      for (let i = 0; i < 5; i += 1) await tick('connector.verify');
      expect(await rows()).toMatchObject([{ health: 'unavailable' }]);
      expect((await rows())[0]!.circuitOpenUntil).not.toBeNull();

      verdict = { accountName: 'Acme', accountRef: 'acct-acme', kind: 'verified', scopes: [] };
      await tick('connector.verify');
      expect(await rows()).toMatchObject([
        { circuitOpenUntil: null, failureCount: 0, health: 'healthy' },
      ]);
    });

    it('a Resend binding on a pending domain gets its resend_key_mint once, when the domain is verified', async () => {
      const conn = await connect('resend');
      await harness.inTenant((tx) =>
        tx.insert(schema.connectorBindings).values({
          boundBy: harness.userId,
          config: { domainId: 'dom_1', domainName: 'mail.example.test' },
          connectionId: conn.id,
          orgId: harness.orgId,
          projectId: harness.projectId,
          provider: 'resend',
          state: 'bound',
        }),
      );

      await tick('connector.verify');
      expect(await operationsOf()).toEqual([]);

      domainStatus = 'verified';
      await age();
      await tick('connector.verify');
      await age();
      await tick('connector.verify');

      expect(await operationsOf()).toMatchObject([
        { kind: 'resend_key_mint', projectId: harness.projectId, state: 'queued' },
      ]);
    });

    it('connector.ops-timeout: a running operation past fifteen minutes → failed timed-out; a fresher one is left alone', async () => {
      const conn = await connect('neon');
      const [binding] = await harness.inTenant((tx) =>
        tx
          .insert(schema.connectorBindings)
          .values({
            boundBy: harness.userId,
            config: {},
            connectionId: conn.id,
            orgId: harness.orgId,
            projectId: harness.projectId,
            provider: 'neon',
            state: 'bound',
          })
          .returning(),
      );
      const insert = (kind: 'neon_branch_create' | 'resource_release', minutesAgo: number) =>
        harness.inTenant(async (tx) => {
          const [row] = await tx
            .insert(schema.connectorOperations)
            .values({
              bindingId: binding!.id,
              kind,
              orgId: harness.orgId,
              projectId: harness.projectId,
              startedAt: new Date(Date.now() - minutesAgo * 60_000),
              state: 'running',
            })
            .returning();

          return row!.id;
        });
      const stale = await insert('resource_release', 16);
      const fresh = await insert('neon_branch_create', 10);

      await tick('connector.verify');
      const byId = async (id: string) => (await operationsOf()).find((row) => row.id === id);
      expect(await byId(stale)).toMatchObject({ state: 'running' });

      await tick('connector.ops-timeout');
      expect(await byId(stale)).toMatchObject({ reason: 'timed-out', state: 'failed' });
      expect(await byId(fresh)).toMatchObject({ reason: null, state: 'running' });
    });

    it('a Netlify publish times out at thirty minutes, every other kind at fifteen', () => {
      expect(staleAfter('netlify_publish')).toBe(30 * 60_000);
      expect(STALE_OPERATION_MS.netlify_publish).toBe(30 * 60_000);
      for (const kind of ['neon_branch_create', 'resource_release', 'resend_key_mint'] as const) {
        expect(staleAfter(kind)).toBe(STALE_RUNNING_MS);
      }
    });

    it("a soft-deleted org's live resources are released, and its connection secrets deleted afterwards", async () => {
      const other = await harness.moduleRef
        .get(OrgService)
        .create(harness.userId, { name: 'Gone', slug: `030d-${randomUUID().slice(0, 8)}` });
      const runner = harness.moduleRef.get(TenantTransactionRunner);
      const inOther = <T>(fn: (tx: TenantTransaction) => Promise<T>) =>
        runner.runInTenantTransaction(other.id, fn);

      try {
        const conn = await connect('neon', other.id);
        const [resource] = await inOther((tx) =>
          tx
            .insert(schema.connectorResources)
            .values({
              connectionId: conn.id,
              externalId: 'br-1',
              kind: 'neon_branch',
              name: 'forge-preview-x',
              orgId: other.id,
              state: 'live',
            })
            .returning(),
        );
        await harness.database
          .update(schema.orgs)
          .set({ deletedAt: new Date() })
          .where(eq(schema.orgs.id, other.id));

        await tick('connector.verify');
        await tick('connector.verify');
        expect(await operationsOf(other.id)).toMatchObject([
          { kind: 'resource_release', resourceId: resource!.id, state: 'queued' },
        ]);
        // The release has not run: the credential it needs is still there.
        expect(
          await inOther((tx) =>
            tx.select().from(schema.secrets).where(eq(schema.secrets.orgId, other.id)),
          ),
        ).toHaveLength(1);

        await inOther(async (tx) => {
          await tx
            .update(schema.connectorResources)
            .set({ releasedAt: new Date(), state: 'released' })
            .where(eq(schema.connectorResources.id, resource!.id));
          await tx
            .update(schema.connectorOperations)
            .set({ finishedAt: new Date(), state: 'succeeded' })
            .where(eq(schema.connectorOperations.orgId, other.id));
        });
        await tick('connector.verify');

        expect(
          await inOther((tx) =>
            tx.select().from(schema.connections).where(eq(schema.connections.orgId, other.id)),
          ),
        ).toEqual([]);
        expect(
          await inOther((tx) =>
            tx.select().from(schema.secrets).where(eq(schema.secrets.orgId, other.id)),
          ),
        ).toEqual([]);
      } finally {
        await harness.database.delete(schema.orgs).where(eq(schema.orgs.id, other.id));
      }
    });
  });
});
