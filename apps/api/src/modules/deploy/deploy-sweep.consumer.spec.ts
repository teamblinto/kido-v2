import { Test, type TestingModule } from '@nestjs/testing';
import { type Deployment, schema } from '@repo/db';
import { eq, inArray, sql } from 'drizzle-orm';
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
import { APP_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import type { Envelope } from '../outbox/envelope';
import { OrgService } from '../tenancy/services/org.service';
import { ProjectService } from '../tenancy/services/project.service';
import { DEPLOY_SWEEP_QUEUE, QUEUED_STALE_AFTER_MS, STALE_AFTER_MS } from './deploy.constants';
import { DeploySweepConsumer } from './deploy-sweep.consumer';
import { DeploymentRepository } from './deployment.repository';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const MINUTE = 60_000;

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
 * Spec 027 US4 (T074, research R8): the `deploy.sweep` arm of `maintenance.due`. A job that died
 * past its DLQ leaves its row `building` or `uploading`, holding the project's one in-flight slot;
 * the sweep fails it `platform` once its `started_at` is 30 minutes old, with the audit row and
 * `deploy.failed`, one tenant transaction per organisation.
 */
describe('DeploySweepConsumer', () => {
  it('declares its own queue on the events profile, the ConnectorHealthConsumer shape', () => {
    const declared = new (
      DeploySweepConsumer as unknown as new (...args: unknown[]) => DeploySweepConsumer
    )();

    expect(declared).toMatchObject({
      name: 'deploy-sweep',
      profile: 'events',
      queue: DEPLOY_SWEEP_QUEUE,
      types: ['maintenance.due'],
    });
    expect(DEPLOY_SWEEP_QUEUE).toBe('deploy.sweep');
    const event = due('deploy.sweep');
    expect(declared.jobId(event)).toBe(
      `deploy.sweep.${String(Date.parse(event.payload.periodStart))}.deploy`,
    );
  });

  it('takes deploy.sweep and leaves every other maintenance job to its owner', async () => {
    const declared = new (
      DeploySweepConsumer as unknown as new (...args: unknown[]) => DeploySweepConsumer
    )();

    await expect(declared.handle(due('deploy.sweep'))).resolves.toBe(true);
    for (const job of ['connector.verify', 'sandbox.sweep', 'webhook.retention'] as const) {
      await expect(declared.handle(due(job))).resolves.toBe(false);
    }
  });

  describe.skipIf(!postgres || !redis)('against Postgres', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    let consumer: DeploySweepConsumer;
    let repository: DeploymentRepository;
    let userId: string;
    const orgIds: string[] = [];
    /**
     * The sweep is fleet-wide; suites running beside this one keep rows with fixed, older clocks.
     * Only this suite's organisations reach the real `failStale` — every org is still visited.
     */
    let failStale: MockInstance<DeploymentRepository['failStale']>;
    const realFailStale: DeploymentRepository['failStale'] = (...args) =>
      DeploymentRepository.prototype.failStale.apply(repository, args);

    async function tick(job: Envelope<'maintenance.due'>['payload']['job'] = 'deploy.sweep') {
      const event = due(job);
      await consumer.effect(event, await consumer.handle(event));
    }

    async function org(): Promise<string> {
      const created = await moduleRef.get(OrgService).create(userId, {
        name: 'Deploy sweep fixture',
        slug: `027s-${randomUUID().slice(0, 8)}`,
      });
      orgIds.push(created.id);
      return created.id;
    }

    /** A project of its own (one in flight per project) with one deployment in `state`. */
    async function deployment(
      orgId: string,
      state: 'queued' | 'building' | 'uploading' | 'succeeded',
      startedAgoMs: number,
    ): Promise<Deployment> {
      const [workspace] = await transactions.runInTenantTransaction(orgId, (tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      );
      const project = await transactions.runInTenantScope({ orgId, userId }, () =>
        moduleRef.get(ProjectService).create({
          actorId: userId,
          name: `Swept ${state}`,
          orgId,
          ownerId: userId,
          workspaceId: workspace!.id,
        }),
      );
      const startedAt = new Date(Date.now() - startedAgoMs);

      return transactions.runInTenantTransaction(orgId, async (tx) => {
        const [checkpoint] = await tx
          .insert(schema.checkpoints)
          .values({
            files: [],
            gitSha: 'c'.repeat(40),
            kind: 'baseline',
            label: 'Baseline: workspace as found',
            orgId,
            projectId: project.id,
          })
          .returning({ id: schema.checkpoints.id });
        const row = (await repository.insertQueued(tx, {
          checkpointId: checkpoint!.id,
          orgId,
          projectId: project.id,
          requestedBy: userId,
          template: 'vite-react',
        }))!;
        if (state === 'queued') return row;

        const claimed = (await repository.claim(tx, orgId, row.id, startedAt))!;
        if (state === 'building') return claimed;
        await repository.markUploading(tx, orgId, row.id, claimed.leaseEpoch, startedAt);
        if (state === 'succeeded') {
          await repository.succeed(tx, orgId, row.id, claimed.leaseEpoch, {
            artifactSha: 'a'.repeat(64),
            fileCount: 1,
            finishedAt: startedAt,
            logTail: '',
            totalBytes: 1,
          });
        }
        return claimed;
      });
    }

    async function read(orgId: string, id: string) {
      return transactions.runInTenantTransaction(orgId, async (tx) => ({
        audits: await tx
          .select({
            action: schema.auditLog.action,
            actorId: schema.auditLog.actorId,
            metadata: schema.auditLog.metadata,
          })
          .from(schema.auditLog)
          .where(eq(schema.auditLog.target, id)),
        events: await database
          .select({ payload: schema.outbox.payload, type: schema.outbox.type })
          .from(schema.outbox)
          .where(eq(schema.outbox.aggregateId, id)),
        row: (await tx.select().from(schema.deployments).where(eq(schema.deployments.id, id)))[0]!,
      }));
    }

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await moduleRef.init();
      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      transactions = moduleRef.get(TenantTransactionRunner);
      consumer = moduleRef.get(DeploySweepConsumer, { strict: false });
      repository = moduleRef.get(DeploymentRepository, { strict: false });

      const [user] = await database
        .insert(schema.users)
        .values({ email: `027s-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });
      userId = user!.id;
    }, 60_000);

    beforeEach(() => {
      failStale = vi
        .spyOn(repository, 'failStale')
        .mockImplementation((tx, orgId, olderThan, now) =>
          orgIds.includes(orgId) ? realFailStale(tx, orgId, olderThan, now) : Promise.resolve([]),
        );
    });

    afterAll(async () => {
      if (orgIds.length > 0) {
        await database.delete(schema.orgs).where(inArray(schema.orgs.id, orgIds));
      }
      if (userId !== undefined) {
        await database.delete(schema.users).where(eq(schema.users.id, userId));
      }
      await moduleRef?.close();
    });

    it('fails stale building and uploading rows as platform, with the trail, and leaves the rest', async () => {
      const a = await org();
      const b = await org();
      const staleBuilding = await deployment(a, 'building', STALE_AFTER_MS + MINUTE);
      const staleUploading = await deployment(a, 'uploading', 45 * MINUTE);
      const young = await deployment(a, 'building', STALE_AFTER_MS - 5 * MINUTE);
      const youngUploading = await deployment(a, 'uploading', 10 * MINUTE);
      const queued = await deployment(a, 'queued', 0);
      const succeeded = await deployment(a, 'succeeded', 2 * STALE_AFTER_MS);
      const otherOrg = await deployment(b, 'building', 3 * STALE_AFTER_MS);

      const before = Date.now();
      await tick();

      for (const [orgId, stale] of [
        [a, staleBuilding],
        [a, staleUploading],
        [b, otherOrg],
      ] as const) {
        const { audits, events, row } = await read(orgId, stale.id);
        expect(row).toMatchObject({
          failureReason: 'platform',
          leaseEpoch: stale.leaseEpoch + 1,
          state: 'failed',
        });
        expect(row.finishedAt!.getTime()).toBeGreaterThanOrEqual(before - 1_000);
        const metadata = {
          checkpointId: stale.checkpointId,
          deploymentId: stale.id,
          projectId: stale.projectId,
          reason: 'platform',
        };
        expect(audits).toEqual([{ action: 'deploy.failed', actorId: null, metadata }]);
        expect(events).toEqual([
          {
            payload: {
              deploymentId: stale.id,
              orgId,
              projectId: stale.projectId,
              reason: 'platform',
            },
            type: 'deploy.failed',
          },
        ]);
      }

      for (const [kept, state] of [
        [young, 'building'],
        [youngUploading, 'uploading'],
        [queued, 'queued'],
        [succeeded, 'succeeded'],
      ] as const) {
        const { audits, events, row } = await read(a, kept.id);
        expect(row).toMatchObject({ failureReason: null, state });
        expect(audits).toEqual([]);
        expect(events.filter((event) => event.type === 'deploy.failed')).toEqual([]);
      }

      // A second tick finds nothing left to settle and writes no second trail.
      await tick();
      expect((await read(a, staleBuilding.id)).events).toHaveLength(1);
    });

    it('runs one tenant transaction per organisation, and one failing org does not stop the rest', async () => {
      const a = await org();
      const b = await org();
      const inA = await deployment(a, 'building', STALE_AFTER_MS + MINUTE);
      const inB = await deployment(b, 'uploading', STALE_AFTER_MS + MINUTE);

      const opened = vi.spyOn(transactions, 'runInTenantTransaction');
      const fleet = failStale.getMockImplementation()!;
      failStale.mockImplementation(async (tx, orgId, olderThan, now) => {
        if (orgId === a) throw new Error('org a is unwell');
        return fleet(tx, orgId, olderThan, now);
      });

      await tick();

      const perOrg = (orgId: string) => opened.mock.calls.filter(([id]) => id === orgId).length;
      expect(perOrg(a)).toBe(1);
      expect(perOrg(b)).toBe(1);
      const threshold = failStale.mock.calls.find(([, orgId]) => orgId === b)!;
      expect(threshold[3].getTime() - threshold[2].getTime()).toBe(STALE_AFTER_MS);

      opened.mockRestore();
      expect((await read(a, inA.id)).row.state).toBe('building');
      expect((await read(b, inB.id)).row).toMatchObject({
        failureReason: 'platform',
        state: 'failed',
      });
    });

    it('does not sweep a retry claimed recently, however long ago the first attempt began', async () => {
      const a = await org();
      const first = await deployment(a, 'building', STALE_AFTER_MS + 15 * MINUTE);
      // The retry's claim, a minute ago: the attempt that is running is young.
      const retried = (await transactions.runInTenantTransaction(a, (tx) =>
        repository.claim(tx, a, first.id, new Date(Date.now() - MINUTE)),
      ))!;
      expect(retried).toMatchObject({ attempts: 2, state: 'building' });

      await tick();

      expect((await read(a, first.id)).row).toMatchObject({
        failureReason: null,
        leaseEpoch: retried.leaseEpoch,
        state: 'building',
      });
    });

    it('fails a queued row nobody claimed once it is older than the queued threshold', async () => {
      const a = await org();
      const stuck = await deployment(a, 'queued', 0);
      const waiting = await deployment(a, 'queued', 0);
      // `created_at` is the database's clock, so the age is set there.
      const age = async (id: string, ms: number) =>
        transactions.runInTenantTransaction(a, (tx) =>
          tx.execute(
            sql`update deployments set created_at = now() - make_interval(secs => ${ms / 1000}) where id = ${id}`,
          ),
        );
      await age(stuck.id, QUEUED_STALE_AFTER_MS + MINUTE);
      await age(waiting.id, QUEUED_STALE_AFTER_MS - 5 * MINUTE);

      await tick();

      const { audits, events, row } = await read(a, stuck.id);
      expect(row).toMatchObject({
        failureReason: 'platform',
        leaseEpoch: stuck.leaseEpoch + 1,
        state: 'failed',
      });
      expect(row.finishedAt).toBeInstanceOf(Date);
      expect(audits).toEqual([
        {
          action: 'deploy.failed',
          actorId: null,
          metadata: {
            checkpointId: stuck.checkpointId,
            deploymentId: stuck.id,
            projectId: stuck.projectId,
            reason: 'platform',
          },
        },
      ]);
      expect(events).toEqual([
        {
          payload: {
            deploymentId: stuck.id,
            orgId: a,
            projectId: stuck.projectId,
            reason: 'platform',
          },
          type: 'deploy.failed',
        },
      ]);
      expect((await read(a, waiting.id)).row).toMatchObject({
        failureReason: null,
        state: 'queued',
      });
    });

    it('does nothing on another maintenance job', async () => {
      const a = await org();
      const stale = await deployment(a, 'building', 2 * STALE_AFTER_MS);

      await tick('connector.verify');

      expect((await read(a, stale.id)).row.state).toBe('building');
    });
  });
});
