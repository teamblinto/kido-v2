import { syncOperationSchema } from '@repo/contracts';
import { schema } from '@repo/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import {
  type ConnectorsHarness,
  startConnectorsHarness,
} from '../../../test/fixtures/connectors-harness';
import { RepoLinkService } from './repo-link.service';
import { SyncRepository } from './sync.repository';
import { SyncService } from './sync.service';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

if (!postgres || !redis) {
  console.warn('SKIPPING sync.service.spec.ts: Postgres or the session Redis is not reachable');
}

const SHA = 'c'.repeat(40);

/**
 * Contracts § 4, every row, against Postgres: each refusal answers its `reason` and leaves no
 * `sync_operations` row (SC-011); what passes is one `queued` row and its `sync.requested`.
 * `checkpoints` is append-only, so the `nothing-to-push` case runs before the first row lands.
 */
describe('SyncService', () => {
  describe.skipIf(!postgres || !redis)('against Postgres, Redis and the fixture GitHub', () => {
    let harness: ConnectorsHarness;
    let service: SyncService;
    let links: RepoLinkService;

    const ref = () => ({ orgId: harness.orgId, projectId: harness.projectId });

    function request(kind: 'push' | 'pull') {
      return harness.inTenant((tx) => service.request(tx, ref(), harness.userId, kind));
    }

    function operations() {
      return harness.inTenant((tx) =>
        tx
          .select()
          .from(schema.syncOperations)
          .where(eq(schema.syncOperations.orgId, harness.orgId)),
      );
    }

    async function linked() {
      await harness.connect();
      harness.fixture.repositories.set(501, {
        branches: {},
        default_branch: 'main',
        full_name: 'acme/site',
        id: 501,
        name: 'site',
        owner: { login: 'acme' },
        private: false,
      });
      await harness.inTenant((tx) =>
        links.link(tx, ref(), harness.userId, { existing: { repoId: 501 } }),
      );
    }

    function setConnection(values: Partial<typeof schema.connections.$inferInsert>) {
      return harness.inTenant((tx) =>
        tx
          .update(schema.connections)
          .set(values)
          .where(eq(schema.connections.orgId, harness.orgId)),
      );
    }

    // Spec 044's first automatic push on link has its own suite; these drive operations by hand.
    // In `beforeEach`: the config's `restoreMocks` undoes a spy set once.
    beforeEach(() => {
      vi.spyOn(
        harness.moduleRef.get(SyncService, { strict: false }),
        'requestAuto',
      ).mockResolvedValue(null);
    });

    beforeAll(async () => {
      harness = await startConnectorsHarness();
      service = harness.moduleRef.get(SyncService, { strict: false });
      links = harness.moduleRef.get(RepoLinkService, { strict: false });
      // Ten minutes: the harness waits for the outbox suite lock behind every suite that relays.
    }, 600_000);

    afterAll(() => harness.close());

    beforeEach(() => harness.reset());

    it('no such project is not-found', async () => {
      await expect(
        harness.inTenant((tx) =>
          service.request(
            tx,
            { orgId: harness.orgId, projectId: '00000000-0000-4000-8000-000000000000' },
            harness.userId,
            'push',
          ),
        ),
      ).rejects.toMatchObject({ type: 'not-found' });
    });

    it('no link, or a disconnected link, is conflict/not-linked', async () => {
      await expect(request('push')).rejects.toMatchObject({
        extensions: { reason: 'not-linked' },
        type: 'conflict',
      });

      await linked();
      await harness.inTenant((tx) =>
        tx
          .update(schema.repoLinks)
          .set({ connectionId: null, state: 'disconnected' })
          .where(eq(schema.repoLinks.orgId, harness.orgId)),
      );
      await expect(request('pull')).rejects.toMatchObject({
        extensions: { reason: 'not-linked' },
        type: 'conflict',
      });
      await expect(operations()).resolves.toEqual([]);
    });

    it('needs_reauth is conflict/needs-reauth; an open circuit is service-unavailable/provider-unavailable', async () => {
      await linked();
      await setConnection({ health: 'needs_reauth' });
      await expect(request('push')).rejects.toMatchObject({
        extensions: { reason: 'needs-reauth' },
        type: 'conflict',
      });

      await setConnection({
        circuitOpenUntil: new Date(Date.now() + 60_000),
        health: 'unavailable',
      });
      await expect(request('pull')).rejects.toMatchObject({
        extensions: { reason: 'provider-unavailable' },
        retryAfterSeconds: 60,
        type: 'service-unavailable',
      });
      await expect(operations()).resolves.toEqual([]);
    });

    it('push with no checkpoint is conflict/nothing-to-push', async () => {
      await linked();
      await expect(request('push')).rejects.toMatchObject({
        extensions: { reason: 'nothing-to-push' },
        type: 'conflict',
      });
      await expect(operations()).resolves.toEqual([]);
    });

    it('pull while a run is active is conflict/run-active; on an archived project a plain conflict', async () => {
      await linked();
      await harness.inTenant((tx) =>
        tx.insert(schema.agentRuns).values({
          model: 'test',
          orgId: harness.orgId,
          projectId: harness.projectId,
          status: 'running',
          userId: harness.userId,
        }),
      );
      await expect(request('pull')).rejects.toMatchObject({
        extensions: { reason: 'run-active' },
        type: 'conflict',
      });

      await harness.inTenant((tx) =>
        tx
          .update(schema.projects)
          .set({ deletedAt: new Date() })
          .where(eq(schema.projects.id, harness.projectId)),
      );
      const refused = request('pull');

      await expect(refused).rejects.toMatchObject({ type: 'conflict' });
      await expect(refused).rejects.not.toHaveProperty('extensions.reason');
      await expect(operations()).resolves.toEqual([]);
    });

    it('a request that passes leaves one queued row and sync.requested on the same transaction', async () => {
      await linked();
      await harness.inTenant((tx) =>
        tx.insert(schema.checkpoints).values({
          files: [],
          gitSha: SHA,
          kind: 'baseline',
          label: 'baseline',
          orgId: harness.orgId,
          projectId: harness.projectId,
        }),
      );

      const operation = await request('push');

      expect(syncOperationSchema.parse(operation)).toEqual(operation);
      expect(operation).toMatchObject({
        commits: 0,
        finishedAt: null,
        kind: 'push',
        reason: null,
        requestedBy: { id: harness.userId },
        startedAt: null,
        state: 'queued',
      });

      const rows = await operations();

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: operation.id, projectId: harness.projectId });

      const events = await harness.database
        .select()
        .from(schema.outbox)
        .where(eq(schema.outbox.aggregateId, operation.id));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        payload: {
          orgId: harness.orgId,
          projectId: harness.projectId,
          syncOperationId: operation.id,
        },
        type: 'sync.requested',
      });

      await expect(request('pull')).rejects.toMatchObject({
        extensions: { reason: 'operation-in-flight' },
        type: 'conflict',
      });
      await expect(
        harness.inTenant((tx) => service.byId(tx, ref(), operation.id)),
      ).resolves.toEqual(operation);
      await expect(
        harness.inTenant((tx) => service.list(tx, ref(), { limit: 10 })),
      ).resolves.toMatchObject({
        items: [{ id: operation.id }],
        nextCursor: null,
      });
    });

    it('the partial unique index is the second net: a race past inFlightExists is operation-in-flight and leaves one row (R7, SC-011)', async () => {
      await linked();

      const first = await request('push');
      const repository = harness.moduleRef.get(SyncRepository, { strict: false });

      vi.spyOn(repository, 'inFlightExists').mockResolvedValueOnce(false);

      await expect(request('push')).rejects.toMatchObject({
        extensions: { reason: 'operation-in-flight' },
        type: 'conflict',
      });

      const rows = await operations();

      expect(rows.map((row) => row.id)).toEqual([first.id]);
    });

    it('spec 044: requestPush on a taken slot is null, and the transaction lives on', async () => {
      await linked();

      const first = await request('push');
      const [second, after] = await harness.inTenant(async (tx) => [
        await service.requestPush(tx, ref(), { actorId: harness.userId, trigger: 'auto' }),
        await service.byId(tx, ref(), first.id),
      ]);

      expect(second).toBeNull();
      expect(after).toMatchObject({ id: first.id, trigger: 'manual' });
      expect((await operations()).map((row) => row.id)).toEqual([first.id]);
    });

    it('byId of another project’s operation is not-found; list refuses a foreign cursor', async () => {
      await linked();

      const operation = await request('pull');

      await expect(
        harness.inTenant((tx) =>
          service.byId(
            tx,
            { orgId: harness.orgId, projectId: '00000000-0000-4000-8000-000000000000' },
            operation.id,
          ),
        ),
      ).rejects.toMatchObject({ type: 'not-found' });
      await expect(
        harness.inTenant((tx) => service.list(tx, ref(), { cursor: 'nope', limit: 10 })),
      ).rejects.toMatchObject({ type: 'bad-request' });
    });
  });
});
