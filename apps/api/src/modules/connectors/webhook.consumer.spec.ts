import { schema } from '@repo/db';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
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

import {
  type ConnectorsHarness,
  INSTALLATION_ID,
  ORG_ACCOUNT,
  startConnectorsHarness,
} from '../../../test/fixtures/connectors-harness';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { RetryableFailure } from '../outbox/consumer';
import { OrgService } from '../tenancy/services/org.service';
import { ProjectService } from '../tenancy/services/project.service';
import { ConnectionService } from './connection.service';
import { InstallStateStore } from './install-state';
import { RepoLinkRepository } from './repo-link.repository';
import { position } from './sync-guards';
import { WebhookDeliveryConsumer } from './webhook.consumer';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

if (!postgres || !redis) {
  console.warn('SKIPPING webhook.consumer.spec.ts: Postgres or Redis is not reachable');
}

/** The repository the fixture links, and the one nothing names. */
const REPO_ID = 8_800_001;
const OTHER_REPO_ID = 8_800_002;
const HEAD = '9a7c2d1e5b3f4086a2c1d0e9f8b7a6c5d4e3f201';
const DELETED = '0'.repeat(40);

/**
 * US3 (contracts/webhook.md § 5): the consumer driven by hand against Postgres and the fixture
 * GitHub, one delivery at a time.
 *
 * The queue is not involved — `process` is the same entry point `effect` calls, and driving it
 * directly is what lets a spec assert the *state* a delivery leaves behind rather than the timing
 * of a worker. Every assertion here is about the one column a delivery may write and about the five
 * ways it must write nothing at all.
 */
describe('WebhookDeliveryConsumer', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and the fixture GitHub', () => {
    let harness: ConnectorsHarness;
    let consumer: WebhookDeliveryConsumer;
    let links: RepoLinkRepository;
    let transactions: TenantTransactionRunner;
    /** Organisations this test made, torn down after it. */
    const extras: string[] = [];

    beforeAll(async () => {
      harness = await startConnectorsHarness();
      consumer = harness.moduleRef.get(WebhookDeliveryConsumer, { strict: false });
      links = harness.moduleRef.get(RepoLinkRepository, { strict: false });
      transactions = harness.moduleRef.get(TenantTransactionRunner, { strict: false });
      // Ten minutes: the harness waits for the outbox suite lock behind every suite that relays.
    }, 600_000);

    afterAll(async () => {
      await harness?.close();
    });

    beforeEach(() => harness.reset());

    afterEach(async () => {
      vi.restoreAllMocks();

      for (const orgId of extras.splice(0)) {
        await harness.database.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
      }
    });

    /** A delivery as the request would have written it, straight into the platform table. */
    async function received(
      body: Record<string, unknown>,
      eventType = 'push',
      installationId: number | null = INSTALLATION_ID,
    ): Promise<string> {
      const [row] = await harness.database
        .insert(schema.webhookDeliveries)
        .values({
          body,
          deliveryId: randomUUID(),
          eventType,
          installationId,
          provider: 'github',
          receivedAt: new Date(),
          state: 'received',
        })
        .returning({ id: schema.webhookDeliveries.id });

      return row!.id;
    }

    function pushBody(ref = 'refs/heads/main', after = HEAD, repoId = REPO_ID) {
      return {
        after,
        installation: { id: INSTALLATION_ID },
        ref,
        repository: { id: repoId },
        zen: 'Design for failure.',
      };
    }

    async function deliveryRow(id: string) {
      const [row] = await harness.database
        .select()
        .from(schema.webhookDeliveries)
        .where(eq(schema.webhookDeliveries.id, id));

      return row!;
    }

    /** The harness's own organisation, connected and linked to {@link REPO_ID} on `main`. */
    async function linkHarness(branch = 'main'): Promise<string> {
      const connection = await harness.connect();
      const [row] = await harness.inTenant((tx) =>
        tx
          .insert(schema.repoLinks)
          .values({
            branch,
            connectionId: connection.id,
            linkedBy: harness.userId,
            name: 'site',
            orgId: harness.orgId,
            owner: ORG_ACCOUNT.login,
            projectId: harness.projectId,
            repoId: REPO_ID,
            state: 'linked',
          })
          .returning({ id: schema.repoLinks.id }),
      );

      return row!.id;
    }

    async function harnessLink() {
      return harness.inTenant((tx) => links.forProject(tx, harness.orgId, harness.projectId));
    }

    /**
     * A whole second tenant: its own organisation, project and `github` connection. `installation`
     * is what decides whether a delivery is this organisation's — SC-013 is precisely the claim
     * that an organisation whose connection names a different one is left alone.
     */
    async function otherOrg(options: { installation?: number; repoId?: number } = {}) {
      const orgs = harness.moduleRef.get(OrgService, { strict: false });
      const projects = harness.moduleRef.get(ProjectService, { strict: false });
      const connections = harness.moduleRef.get(ConnectionService, { strict: false });
      const states = harness.moduleRef.get(InstallStateStore, { strict: false });
      const installation = options.installation ?? INSTALLATION_ID;

      if (installation !== INSTALLATION_ID) {
        harness.fixture.installations.set(installation, {
          account: ORG_ACCOUNT,
          id: installation,
        });
      }

      const org = await orgs.create(harness.userId, {
        name: 'Another tenant',
        slug: `026w-${randomUUID().slice(0, 8)}`,
      });

      extras.push(org.id);

      const [workspace] = await transactions.runInTenantTransaction(org.id, (tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      );
      const project = await transactions.runInTenantScope(
        { orgId: org.id, userId: harness.userId },
        () =>
          projects.create({
            actorId: harness.userId,
            name: 'Linked elsewhere',
            orgId: org.id,
            ownerId: harness.userId,
            workspaceId: workspace!.id,
          }),
      );
      const state = await states.issue(org.id, harness.userId);
      const connection = await transactions.runInTenantTransaction(org.id, (tx) =>
        connections.completeInstall(tx, org.id, harness.userId, {
          installationId: installation,
          state,
        }),
      );

      await transactions.runInTenantTransaction(org.id, (tx) =>
        tx.insert(schema.repoLinks).values({
          branch: 'main',
          connectionId: connection.id,
          linkedBy: harness.userId,
          name: 'site',
          orgId: org.id,
          owner: ORG_ACCOUNT.login,
          projectId: project.id,
          repoId: options.repoId ?? REPO_ID,
          state: 'linked',
        }),
      );

      return {
        head: () =>
          transactions
            .runInTenantTransaction(org.id, (tx) => links.forProject(tx, org.id, project.id))
            .then((row) => row?.remoteHeadSha ?? null),
        orgId: org.id,
        projectId: project.id,
      };
    }

    // ---- T060 ----------------------------------------------------------------------------------

    it('a matching push advances remote_head_sha, and touches nothing else', async () => {
      await linkHarness();
      const before = await harnessLink();
      const id = await received(pushBody());

      await consumer.process(id);

      const after = await harnessLink();

      expect(after?.remoteHeadSha).toBe(HEAD);
      // FR-005/FR-038: one column. Everything else about spec 018's link is byte-identical, and
      // nothing was pulled, pushed or checkpointed (FR-034).
      expect({ ...after, remoteHeadSha: null, updatedAt: null }).toEqual({
        ...before,
        remoteHeadSha: null,
        updatedAt: null,
      });
      await expect(
        harness.inTenant((tx) =>
          tx
            .select()
            .from(schema.syncOperations)
            .where(eq(schema.syncOperations.orgId, harness.orgId)),
        ),
      ).resolves.toEqual([]);
      await expect(
        harness.inTenant((tx) =>
          tx
            .select()
            .from(schema.checkpoints)
            .where(eq(schema.checkpoints.projectId, harness.projectId)),
        ),
      ).resolves.toEqual([]);
      expect(await deliveryRow(id)).toMatchObject({ failure: null, state: 'processed' });
    });

    it.each([
      ['a non-push event', () => received(pushBody(), 'pull_request')],
      ['a tag ref', () => received(pushBody('refs/tags/v1.0.0'))],
      ['an unmatched repository', () => received(pushBody('refs/heads/main', HEAD, OTHER_REPO_ID))],
      ['an unmatched branch', () => received(pushBody('refs/heads/release'))],
      ['an unknown installation', () => received({ ...pushBody() }, 'push', 999_999)],
    ])('ends %s as ignored, with the link untouched', async (_case, make) => {
      await linkHarness();
      const id = await make();

      await consumer.process(id);

      expect(await deliveryRow(id)).toMatchObject({ failure: null, state: 'ignored' });
      await expect(harnessLink()).resolves.toMatchObject({ remoteHeadSha: null });
    });

    it('a deleted branch clears the head to null, and the project reads unknown rather than level', async () => {
      await linkHarness();
      await consumer.process(await received(pushBody()));
      await expect(harnessLink()).resolves.toMatchObject({ remoteHeadSha: HEAD });

      const id = await received(pushBody('refs/heads/main', DELETED));

      await consumer.process(id);

      const row = await harnessLink();

      expect(row?.remoteHeadSha).toBeNull();
      expect(await deliveryRow(id)).toMatchObject({ state: 'processed' });
      // The distinction the contract insists on: a branch that is gone is *unknown*, and `position`
      // is where that would otherwise have read as `level`.
      expect(
        position({ lastPushedSha: row!.lastPushedSha, remoteHeadSha: row!.remoteHeadSha }, HEAD),
      ).toBe('unknown');
    });

    // ---- T061 ----------------------------------------------------------------------------------

    it('R14: an in-flight operation defers the delivery with backoff rather than writing', async () => {
      const linkId = await linkHarness();

      await harness.inTenant((tx) =>
        tx.insert(schema.syncOperations).values({
          kind: 'push',
          linkId,
          orgId: harness.orgId,
          projectId: harness.projectId,
          requestedBy: harness.userId,
          state: 'running',
        }),
      );

      const id = await received(pushBody());

      await expect(consumer.process(id)).rejects.toBeInstanceOf(RetryableFailure);

      // Nothing written, and the record is still the one the next attempt retries from (FR-029).
      await expect(harnessLink()).resolves.toMatchObject({ remoteHeadSha: null });
      expect(await deliveryRow(id)).toMatchObject({ attempts: 1, state: 'received' });

      // The budget spent with the operation still in flight: parked, visibly, with a category.
      await expect(consumer.process(id, consumer.attempts)).rejects.toThrow();
      expect(await deliveryRow(id)).toMatchObject({
        attempts: consumer.attempts,
        failure: 'in-flight',
        state: 'failed',
      });
      await expect(harnessLink()).resolves.toMatchObject({ remoteHeadSha: null });
    });

    it('SC-013: two organisations holding the installation advance independently; a third is untouched', async () => {
      await linkHarness();
      const sharing = await otherOrg();
      const stranger = await otherOrg({ installation: INSTALLATION_ID + 1 });
      const id = await received(pushBody());

      await consumer.process(id);

      await expect(harnessLink()).resolves.toMatchObject({ remoteHeadSha: HEAD });
      await expect(sharing.head()).resolves.toBe(HEAD);
      await expect(stranger.head()).resolves.toBeNull();
      expect(await deliveryRow(id)).toMatchObject({ state: 'processed' });
    });

    it('one organisation failing is caught and logged, and the others still advance', async () => {
      await linkHarness();
      const sharing = await otherOrg();
      const real = links.setRemoteHeadByRepo.bind(links);

      vi.spyOn(links, 'setRemoteHeadByRepo').mockImplementation((tx, orgId, repoId, branch, sha) =>
        orgId === sharing.orgId
          ? Promise.reject(new Error(`org ${orgId} is broken`))
          : real(tx, orgId, repoId, branch, sha),
      );

      const id = await received(pushBody());

      await consumer.process(id);

      await expect(harnessLink()).resolves.toMatchObject({ remoteHeadSha: HEAD });
      await expect(sharing.head()).resolves.toBeNull();
      // The delivery is not failed: one organisation's transaction rolled back, and the others'
      // work stands (contracts § 5 step 5).
      expect(await deliveryRow(id)).toMatchObject({ failure: null, state: 'processed' });
    });
  });
});
