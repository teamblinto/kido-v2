import { Test, type TestingModule } from '@nestjs/testing';
import { type Deployment, schema } from '@repo/db';
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  type MockInstance,
  vi,
} from 'vitest';

import { AppModule } from '../../app.module';
import { CLOCK } from '../../common/clock/clock.port';
import { FakeClock } from '../../common/clock/fake-clock';
import { MemoryObjectStore } from '../../common/object-store/memory-object-store';
import { APP_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import type { Envelope } from '../outbox/envelope';
import { OrgService } from '../tenancy/services/org.service';
import { ProjectService } from '../tenancy/services/project.service';
import { BuildDeployConsumer } from './build-deploy.consumer';
import { type BuildInput, type BuildOutcome, BuildRunner } from './build-runner';
import { ARTIFACT_STORE, DEPLOY_LIFECYCLE_QUEUE } from './deploy.constants';
import { DeployProjectConsumer } from './deploy-project.consumer';
import { DeploymentRepository } from './deployment.repository';
import { DomainRepository } from './domains/domain.repository';
import { ownershipToken } from './domains/ownership-token';
import { SiteRepository } from './site.repository';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const START = '2026-09-22T10:00:00.000Z';

/**
 * Spec 027 US5 (T089, research R13): `project.archived` takes the site offline with no author
 * (`updated_by` null) and cancels the in-flight deployment with an epoch bump. The build worker
 * that held the old epoch then writes nothing — neither the upload boundary nor go-live lands —
 * which is the cancelled fence in `BuildDeployConsumer`, proved here against the real consumer
 * with `BuildRunner` stubbed and a `MemoryObjectStore` bucket.
 */
describe('DeployProjectConsumer', () => {
  it('declares the deploy.lifecycle queue on the events profile, attempts 5, no effect (R13)', () => {
    const declared = new (
      DeployProjectConsumer as unknown as new (...args: unknown[]) => DeployProjectConsumer
    )();

    expect(declared).toMatchObject({
      attempts: 5,
      name: 'deploy-project',
      profile: 'events',
      queue: DEPLOY_LIFECYCLE_QUEUE,
      types: ['project.archived'],
    });
    expect(DEPLOY_LIFECYCLE_QUEUE).toBe('deploy.lifecycle');
    expect('effect' in declared).toBe(false);
  });

  describe.skipIf(!postgres || !redis)('against Postgres', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    let consumer: DeployProjectConsumer;
    let builder: BuildDeployConsumer;
    let repository: DeploymentRepository;
    let clock: FakeClock;
    let orgId: string;
    let userId: string;
    let workspaceId: string;
    let projectId: string;
    let checkpointId: string;
    const store = new MemoryObjectStore();
    let put: MockInstance<MemoryObjectStore['put']>;
    const run = vi.fn<(input: BuildInput) => Promise<BuildOutcome>>();
    const built = (): Promise<BuildOutcome> =>
      Promise.resolve({
        dropped: 0,
        files: [{ body: Buffer.from('<!doctype html>'), path: 'index.html' }],
        kind: 'built',
        log: 'ok\n',
        totalBytes: 15,
      });

    function inTenant<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantTransaction(orgId, fn);
    }

    async function row(id: string): Promise<Deployment> {
      return (await inTenant((tx) => repository.byId(tx, orgId, projectId, id)))!;
    }

    function site() {
      return inTenant((tx) =>
        tx
          .select()
          .from(schema.projectSites)
          .where(eq(schema.projectSites.projectId, projectId))
          .then((rows) => rows[0]),
      );
    }

    /** The audit rows and events the archive wrote about the project (its target / aggregate). */
    function projectTrail() {
      return inTenant(async (tx) => ({
        audits: await tx
          .select({
            action: schema.auditLog.action,
            actorId: schema.auditLog.actorId,
            metadata: schema.auditLog.metadata,
          })
          .from(schema.auditLog)
          .where(
            and(eq(schema.auditLog.target, projectId), eq(schema.auditLog.action, 'site.offline')),
          ),
        events: await database
          .select({ payload: schema.outbox.payload, type: schema.outbox.type })
          .from(schema.outbox)
          .where(
            and(eq(schema.outbox.aggregateId, projectId), eq(schema.outbox.type, 'site.offline')),
          ),
      }));
    }

    function deploymentEvents(deploymentId: string) {
      return database
        .select({ type: schema.outbox.type })
        .from(schema.outbox)
        .where(
          and(
            eq(schema.outbox.aggregateId, deploymentId),
            inArray(schema.outbox.type, ['deploy.succeeded', 'deploy.failed']),
          ),
        );
    }

    async function queue(): Promise<Deployment> {
      return (await inTenant((tx) =>
        repository.insertQueued(tx, {
          checkpointId,
          orgId,
          projectId,
          requestedBy: userId,
          template: 'vite-react',
        }),
      ))!;
    }

    function requested(deploymentId: string): Envelope<'deploy.requested'> {
      return {
        aggregate: 'deployment',
        aggregateId: deploymentId,
        eventId: randomUUID(),
        occurredAt: clock.now().toISOString(),
        orgId,
        payload: { deploymentId, orgId, projectId },
        traceId: null,
        type: 'deploy.requested',
      };
    }

    function archived(project = projectId): Envelope<'project.archived'> {
      return {
        aggregateId: project,
        eventId: randomUUID(),
        occurredAt: clock.now().toISOString(),
        orgId,
        payload: { actorId: userId, orgId, projectId: project, workspaceId },
        traceId: null,
        type: 'project.archived',
      } as Envelope<'project.archived'>;
    }

    /** One build delivery as the base runs it: `handle` on a committed transaction, then `effect`. */
    async function build(deploymentId: string): Promise<void> {
      const event = requested(deploymentId);
      const job = await database.transaction((tx) => builder.handle(event, tx));
      await builder.effect(event, job, 1);
    }

    /** One archive delivery; the base hands a platform transaction and the consumer scopes it. */
    function archive(): Promise<void> {
      return database.transaction((tx) => consumer.handle(archived(), tx));
    }

    type DomainState = (typeof schema.domains.$inferSelect)['state'];

    /**
     * A domain of `project` put straight into `state` with the columns its CHECKs ask for
     * (migration 0036); `removing` was requested an hour before the clock.
     */
    async function domainIn(state: DomainState, project = projectId): Promise<string> {
      const at = clock.now();
      const inserted = await inTenant((tx) =>
        new DomainRepository().insert(tx, {
          addedBy: userId,
          hostname: `a-${randomUUID().slice(0, 8)}.example.test`,
          now: at,
          orgId,
          ownershipToken: ownershipToken(),
          projectId: project,
        }),
      );
      const registered = {
        activatedAt: at,
        certificateActiveAt: at,
        edgeId: `edge-${inserted.id}`,
        ownershipVerifiedAt: at,
      };
      const columns = {
        active: registered,
        drifted: { ...registered, driftedAt: at },
        failed: { failureReason: 'verification-timeout' as const },
        pending: {},
        removed: {},
        removing: { ...registered, removalRequestedAt: new Date(at.getTime() - 3_600_000) },
      }[state];
      if (state !== 'pending') {
        await inTenant((tx) =>
          tx
            .update(schema.domains)
            .set({ ...columns, state })
            .where(eq(schema.domains.id, inserted.id)),
        );
      }
      return inserted.id;
    }

    function domainRows(ids: string[]) {
      return inTenant((tx) =>
        tx
          .select({
            id: schema.domains.id,
            nextCheckAt: schema.domains.nextCheckAt,
            removalRequestedAt: schema.domains.removalRequestedAt,
            state: schema.domains.state,
          })
          .from(schema.domains)
          .where(inArray(schema.domains.id, ids)),
      ).then((rows) => new Map(rows.map((domain) => [domain.id, domain])));
    }

    /** The removal trail the archive wrote about `ids` (their audit target / event aggregate). */
    function domainTrail(ids: string[]) {
      return inTenant(async (tx) => ({
        audits: await tx
          .select({
            action: schema.auditLog.action,
            actorId: schema.auditLog.actorId,
            metadata: schema.auditLog.metadata,
            target: schema.auditLog.target,
          })
          .from(schema.auditLog)
          .where(
            and(
              inArray(schema.auditLog.target, ids),
              eq(schema.auditLog.action, 'domain.removal-requested'),
            ),
          ),
        events: await database
          .select({ payload: schema.outbox.payload, type: schema.outbox.type })
          .from(schema.outbox)
          .where(
            and(inArray(schema.outbox.aggregateId, ids), eq(schema.outbox.type, 'domain.removing')),
          ),
      }));
    }

    beforeAll(async () => {
      clock = new FakeClock(START);
      moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(CLOCK)
        .useValue(clock)
        .overrideProvider(BuildRunner)
        .useValue({ run })
        .overrideProvider(ARTIFACT_STORE)
        .useValue(store)
        .compile();
      await moduleRef.init();

      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      transactions = moduleRef.get(TenantTransactionRunner);
      consumer = moduleRef.get(DeployProjectConsumer, { strict: false });
      builder = moduleRef.get(BuildDeployConsumer, { strict: false });
      repository = moduleRef.get(DeploymentRepository, { strict: false });

      const [user] = await database
        .insert(schema.users)
        .values({ email: `027a-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });
      userId = user!.id;
      const org = await moduleRef.get(OrgService).create(userId, {
        name: 'Deploy archive fixture',
        slug: `027a-${randomUUID().slice(0, 8)}`,
      });
      orgId = org.id;
      const [workspace] = await inTenant((tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      );
      workspaceId = workspace!.id;
    }, 60_000);

    afterAll(async () => {
      if (orgId !== undefined) await database.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
      if (userId !== undefined) {
        await database.delete(schema.users).where(eq(schema.users.id, userId));
      }
      await moduleRef?.close();
    });

    beforeEach(async () => {
      run.mockReset();
      put = vi.spyOn(store, 'put');
      store.objects.clear();

      const project = await transactions.runInTenantScope({ orgId, userId }, () =>
        moduleRef.get(ProjectService).create({
          actorId: userId,
          name: 'Archive Site',
          orgId,
          ownerId: userId,
          workspaceId,
        }),
      );
      projectId = project.id;

      const [checkpoint] = await inTenant((tx) =>
        tx
          .insert(schema.checkpoints)
          .values({
            files: [],
            gitSha: 'c'.repeat(40),
            kind: 'baseline',
            label: 'Baseline: workspace as found',
            orgId,
            projectId,
          })
          .returning({ id: schema.checkpoints.id }),
      );
      checkpointId = checkpoint!.id;
    });

    it('takes a live site offline with no author, and writes site.offline in the same transaction', async () => {
      run.mockImplementation(built);
      const live = await queue();
      await build(live.id);
      const before = (await site())!;
      expect(before).toMatchObject({ currentDeploymentId: live.id, offlineAt: null });

      clock.advance(1_000);
      await archive();

      const after = await site();
      expect(after).toMatchObject({
        currentDeploymentId: live.id,
        siteLabel: before.siteLabel,
        updatedBy: null,
      });
      expect(after!.offlineAt).toBeInstanceOf(Date);
      // The database's clock, as `created_at` is — not the app clock, which stands at START here.
      expect(after!.offlineAt!.getTime()).toBeGreaterThan((await row(live.id)).createdAt.getTime());
      expect(await projectTrail()).toEqual({
        audits: [{ action: 'site.offline', actorId: null, metadata: { projectId } }],
        events: [{ payload: { orgId, projectId }, type: 'site.offline' }],
      });
      // The live deployment is terminal and stays as it was.
      expect(await row(live.id)).toMatchObject({ state: 'succeeded' });
    });

    it('cancels the in-flight deployment with an epoch bump', async () => {
      const deployment = await queue();
      await inTenant((tx) => repository.claim(tx, orgId, deployment.id, clock.now()));

      await archive();

      expect(await row(deployment.id)).toMatchObject({
        finishedAt: clock.now(),
        leaseEpoch: 2,
        state: 'cancelled',
      });
      // No site row: nothing to take offline, and no site.offline without one.
      expect(await site()).toBeUndefined();
      expect(await projectTrail()).toEqual({ audits: [], events: [] });
      expect(await deploymentEvents(deployment.id)).toEqual([]);
    });

    it('is idempotent on re-delivery', async () => {
      run.mockImplementation(built);
      await build((await queue()).id);
      await archive();
      const first = (await site())!;

      clock.advance(60_000);
      await archive();

      expect((await site())!.offlineAt).toEqual(first.offlineAt);
      const { audits, events } = await projectTrail();
      expect(audits).toHaveLength(1);
      expect(events).toHaveLength(1);
    });

    it('does nothing for a project that never deployed', async () => {
      await archive();

      expect(await site()).toBeUndefined();
      expect(await projectTrail()).toEqual({ audits: [], events: [] });
    });

    /** Spec 028 T073 (FR-026, research R1/R10): archive sends every live domain to `removing`. */
    it('moves every live domain of the project to removing, with no author, and leaves other projects alone', async () => {
      const live = {
        active: await domainIn('active'),
        drifted: await domainIn('drifted'),
        pending: await domainIn('pending'),
      };
      const already = await domainIn('removing');
      const failed = await domainIn('failed');
      const otherProject = (
        await transactions.runInTenantScope({ orgId, userId }, () =>
          moduleRef.get(ProjectService).create({
            actorId: userId,
            name: 'Other Site',
            orgId,
            ownerId: userId,
            workspaceId,
          }),
        )
      ).id;
      const elsewhere = await domainIn('active', otherProject);
      const all = [...Object.values(live), already, failed, elsewhere];
      const before = await domainRows(all);

      clock.advance(5_000);
      await archive();

      const after = await domainRows(all);
      for (const id of Object.values(live)) {
        expect(after.get(id)).toEqual({
          id,
          nextCheckAt: clock.now(),
          removalRequestedAt: clock.now(),
          state: 'removing',
        });
      }
      // Already removing, failed, or another project's: as they were.
      for (const id of [already, failed, elsewhere]) expect(after.get(id)).toEqual(before.get(id));

      const hostnames = await inTenant((tx) =>
        tx
          .select({ hostname: schema.domains.hostname, id: schema.domains.id })
          .from(schema.domains)
          .where(inArray(schema.domains.id, all)),
      ).then((rows) => new Map(rows.map((domain) => [domain.id, domain.hostname])));
      const trail = await domainTrail(all);
      expect(trail.audits).toHaveLength(3);
      expect(trail.audits).toEqual(
        expect.arrayContaining(
          Object.values(live).map((id) => ({
            action: 'domain.removal-requested',
            actorId: null,
            metadata: { hostname: hostnames.get(id), projectId },
            target: id,
          })),
        ),
      );
      expect(trail.events).toHaveLength(3);
      expect(trail.events).toEqual(
        expect.arrayContaining(
          Object.values(live).map((domainId) => ({
            payload: { domainId, orgId, projectId, reason: null },
            type: 'domain.removing',
          })),
        ),
      );

      // Re-delivery: nothing live is left, so no second trail.
      clock.advance(60_000);
      await archive();
      expect(await domainRows(all)).toEqual(after);
      expect(await domainTrail(all)).toEqual(trail);
    });

    it('moves the domains in the same transaction as the site offline', async () => {
      run.mockImplementation(built);
      await build((await queue()).id);
      const domain = await domainIn('active');
      const sites = moduleRef.get(SiteRepository, { strict: false });
      vi.spyOn(sites, 'setOffline').mockRejectedValueOnce(new Error('offline write failed'));

      await expect(archive()).rejects.toThrow('offline write failed');

      expect((await domainRows([domain])).get(domain)).toMatchObject({
        removalRequestedAt: null,
        state: 'active',
      });
      expect(await domainTrail([domain])).toEqual({ audits: [], events: [] });
      expect((await site())!.offlineAt).toBeNull();

      await archive();
      expect((await domainRows([domain])).get(domain)).toMatchObject({ state: 'removing' });
      expect((await site())!.offlineAt).toBeInstanceOf(Date);
    });

    it('fences out a worker archived during its build: no upload, no go-live', async () => {
      const deployment = await queue();
      run.mockImplementation(async () => {
        await archive();
        return built();
      });

      await build(deployment.id);

      expect(await row(deployment.id)).toMatchObject({
        leaseEpoch: 2,
        state: 'cancelled',
        uploadStartedAt: null,
      });
      expect(put).not.toHaveBeenCalled();
      expect(await site()).toBeUndefined();
      expect(await deploymentEvents(deployment.id)).toEqual([]);
    });

    it('fences out a worker archived during its upload: the pointer is not moved and stays offline', async () => {
      run.mockImplementation(built);
      const live = await queue();
      await build(live.id);
      const before = (await site())!;

      const deployment = await queue();
      // Different output, so its objects are not already in the bucket and the upload PUTs.
      run.mockResolvedValueOnce({
        dropped: 0,
        files: [{ body: Buffer.from('<!doctype html><p>v2</p>'), path: 'index.html' }],
        kind: 'built',
        log: 'ok\n',
        totalBytes: 24,
      });
      put.mockImplementationOnce(async (key, body, meta) => {
        await archive();
        return MemoryObjectStore.prototype.put.call(store, key, body, meta);
      });

      await build(deployment.id);

      const cancelled = await row(deployment.id);
      expect(cancelled).toMatchObject({ artifactSha: null, leaseEpoch: 2, state: 'cancelled' });
      expect(cancelled.uploadStartedAt).toBeInstanceOf(Date);
      const pointer = await site();
      expect(pointer).toMatchObject({
        currentDeploymentId: live.id,
        siteLabel: before.siteLabel,
        updatedBy: null,
      });
      expect(pointer!.offlineAt).toBeInstanceOf(Date);
      expect(put).toHaveBeenCalled();
      expect(await deploymentEvents(deployment.id)).toEqual([]);
    });
  });
});
