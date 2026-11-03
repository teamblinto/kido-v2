import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { AppModule } from '../../app.module';
import { APP_DATABASE, BYPASS_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { OrgService } from '../tenancy/services/org.service';
import { ProjectService } from '../tenancy/services/project.service';
import { DeploymentRepository } from './deployment.repository';
import { SiteRepository } from './site.repository';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

/** Spec 027 T047 against real Postgres: the pointer upsert keeps the label, and the bypass probe. */
describe('SiteRepository', () => {
  describe.skipIf(!postgres || !redis)('against Postgres', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let bypass: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    const deployments = new DeploymentRepository();
    const sites = new SiteRepository();
    let orgId: string;
    let userId: string;
    const now = new Date('2026-09-22T12:00:00.000Z');

    function inTenant<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantTransaction(orgId, fn);
    }

    async function newProject(): Promise<{ checkpointId: string; projectId: string }> {
      const [workspace] = await inTenant((tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      );
      const project = await transactions.runInTenantScope({ orgId, userId }, () =>
        moduleRef.get(ProjectService).create({
          actorId: userId,
          name: 'Site',
          orgId,
          ownerId: userId,
          workspaceId: workspace!.id,
        }),
      );
      const [checkpoint] = await inTenant((tx) =>
        tx
          .insert(schema.checkpoints)
          .values({
            files: [],
            gitSha: 'a'.repeat(40),
            kind: 'baseline',
            label: 'Baseline',
            orgId,
            projectId: project.id,
          })
          .returning({ id: schema.checkpoints.id }),
      );

      return { checkpointId: checkpoint!.id, projectId: project.id };
    }

    /** A `succeeded` deployment, through the repository's own path. */
    async function succeeded(projectId: string, checkpointId: string): Promise<string> {
      return inTenant(async (tx) => {
        const row = (await deployments.insertQueued(tx, {
          checkpointId,
          orgId,
          projectId,
          requestedBy: userId,
          template: 'vite-react',
        }))!;
        const { leaseEpoch } = (await deployments.claim(tx, orgId, row.id, now))!;
        await deployments.markUploading(tx, orgId, row.id, leaseEpoch, now);
        await deployments.succeed(tx, orgId, row.id, leaseEpoch, {
          artifactSha: 'f'.repeat(64),
          fileCount: 1,
          finishedAt: now,
          totalBytes: 1,
        });

        return row.id;
      });
    }

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await moduleRef.init();

      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      bypass = moduleRef.get<ForgeDatabase>(BYPASS_DATABASE);
      transactions = moduleRef.get(TenantTransactionRunner);

      const [user] = await database
        .insert(schema.users)
        .values({ email: `027s-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });

      userId = user!.id;
      orgId = (
        await moduleRef.get(OrgService).create(userId, {
          name: 'Site repository fixture',
          slug: `027s-${randomUUID().slice(0, 8)}`,
        })
      ).id;
    }, 60_000);

    afterAll(async () => {
      if (orgId !== undefined) await database.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
      if (userId !== undefined)
        await database.delete(schema.users).where(eq(schema.users.id, userId));
      await moduleRef?.close();
    });

    it('assigns the label on the first go-live only, moves the pointer and clears offline on the next', async () => {
      const { checkpointId, projectId } = await newProject();
      const label = `site-${randomUUID().slice(0, 8)}`;
      const first = await succeeded(projectId, checkpointId);

      const created = await inTenant((tx) =>
        sites.upsertOnGoLive(tx, {
          deploymentId: first,
          label,
          orgId,
          projectId,
          updatedBy: userId,
        }),
      );
      expect(created).toMatchObject({
        currentDeploymentId: first,
        offlineAt: null,
        siteLabel: label,
      });

      await inTenant((tx) => sites.setOffline(tx, { orgId, projectId, updatedBy: userId }));

      // Requested after the offline action committed: its go-live brings the site back.
      const second = await succeeded(projectId, checkpointId);
      const moved = await inTenant((tx) =>
        sites.upsertOnGoLive(tx, {
          deploymentId: second,
          label: 'ignored-once-assigned',
          orgId,
          projectId,
          updatedBy: null,
        }),
      );
      expect(moved).toMatchObject({
        currentDeploymentId: second,
        id: created!.id,
        offlineAt: null,
        siteLabel: label,
        updatedBy: null,
      });
      expect(await inTenant((tx) => sites.byProject(tx, orgId, projectId))).toEqual(moved);
      expect(await inTenant((tx) => sites.byProject(tx, orgId, randomUUID()))).toBeUndefined();
    });

    it('keeps offline_at on a go-live requested before the site went offline, and moves the pointer', async () => {
      const { checkpointId, projectId } = await newProject();
      const label = `site-${randomUUID().slice(0, 8)}`;
      const first = await succeeded(projectId, checkpointId);
      const second = await succeeded(projectId, checkpointId);
      const goLive = (deploymentId: string) =>
        inTenant((tx) =>
          sites.upsertOnGoLive(tx, {
            deploymentId,
            label,
            orgId,
            projectId,
            updatedBy: userId,
          }),
        );

      await goLive(first);
      const offline = await inTenant((tx) =>
        sites.setOffline(tx, { orgId, projectId, updatedBy: null }),
      );
      expect(offline?.offlineAt).toBeInstanceOf(Date);

      expect(await goLive(second)).toMatchObject({
        currentDeploymentId: second,
        offlineAt: offline!.offlineAt,
        siteLabel: label,
      });
    });

    /**
     * `offline_at` and `deployments.created_at` are compared, so both come from one clock: the
     * database's. An app clock behind the database would otherwise date an offline action before
     * a deployment requested earlier, and that deployment's go-live would bring the site back.
     */
    it("stamps offline_at from the database clock, not the caller's", async () => {
      const { checkpointId, projectId } = await newProject();
      const first = await succeeded(projectId, checkpointId);
      await inTenant((tx) =>
        sites.upsertOnGoLive(tx, {
          deploymentId: first,
          label: `site-${randomUUID().slice(0, 8)}`,
          orgId,
          projectId,
          updatedBy: userId,
        }),
      );

      const { dbNow, row } = await inTenant(async (tx) => {
        const result = await tx.execute(sql`select now() as at`);
        const written = await sites.setOffline(tx, { orgId, projectId, updatedBy: userId });

        return { dbNow: new Date((result.rows[0] as { at: string | Date }).at), row: written };
      });

      expect(row?.offlineAt).toEqual(dbNow);
    });

    /**
     * The comparison runs in SQL against the stored `created_at`, to the microsecond: a timestamp
     * handed back through a JS `Date` loses its microseconds, which could date a deployment
     * requested just after an offline action before it.
     */
    it("compares offline_at with the deployment's own created_at, to the microsecond", async () => {
      const { checkpointId, projectId } = await newProject();
      const label = `site-${randomUUID().slice(0, 8)}`;
      const first = await succeeded(projectId, checkpointId);
      const second = await succeeded(projectId, checkpointId);
      const third = await succeeded(projectId, checkpointId);
      const goLive = (deploymentId: string) =>
        inTenant((tx) =>
          sites.upsertOnGoLive(tx, { deploymentId, label, orgId, projectId, updatedBy: userId }),
        );
      const setTimes = (deploymentId: string, createdAt: string, offlineAt: string) =>
        inTenant(async (tx) => {
          await tx.execute(
            sql`update deployments set created_at = ${createdAt}::timestamptz where id = ${deploymentId}`,
          );
          await tx.execute(
            sql`update project_sites set offline_at = ${offlineAt}::timestamptz where project_id = ${projectId}`,
          );
        });

      await goLive(first);

      // Taken offline 400 µs before the deployment was requested, within the same millisecond.
      await setTimes(second, '2026-09-22T12:00:00.000500Z', '2026-09-22T12:00:00.000100Z');
      expect(await goLive(second)).toMatchObject({ currentDeploymentId: second, offlineAt: null });

      // Taken offline 400 µs after the deployment was requested: offline wins.
      await setTimes(third, '2026-09-22T12:00:00.000100Z', '2026-09-22T12:00:00.000500Z');
      const kept = await goLive(third);
      expect(kept?.currentDeploymentId).toBe(third);
      expect(kept?.offlineAt).not.toBeNull();
    });

    it("answers undefined for another project's label and leaves the transaction usable", async () => {
      const a = await newProject();
      const b = await newProject();
      const label = `site-${randomUUID().slice(0, 8)}`;
      const deployA = await succeeded(a.projectId, a.checkpointId);
      const deployB = await succeeded(b.projectId, b.checkpointId);

      await inTenant((tx) =>
        sites.upsertOnGoLive(tx, {
          deploymentId: deployA,
          label,
          orgId,
          projectId: a.projectId,
          updatedBy: userId,
        }),
      );

      const retried = await inTenant(async (tx) => {
        const taken = await sites.upsertOnGoLive(tx, {
          deploymentId: deployB,
          label,
          orgId,
          projectId: b.projectId,
          updatedBy: userId,
        });
        expect(taken).toBeUndefined();

        return sites.upsertOnGoLive(tx, {
          deploymentId: deployB,
          label: `${label}-2`,
          orgId,
          projectId: b.projectId,
          updatedBy: userId,
        });
      });
      expect(retried?.siteLabel).toBe(`${label}-2`);
    });

    it('release moves the pointer and clears offline; setOffline keeps pointer and label (T062, T091)', async () => {
      const { checkpointId, projectId } = await newProject();
      const label = `site-${randomUUID().slice(0, 8)}`;
      const first = await succeeded(projectId, checkpointId);
      const second = await succeeded(projectId, checkpointId);

      expect(
        await inTenant((tx) =>
          sites.release(tx, { deploymentId: first, orgId, projectId, updatedBy: userId }),
        ),
      ).toBeUndefined();
      expect(
        await inTenant((tx) => sites.setOffline(tx, { orgId, projectId, updatedBy: null })),
      ).toBeUndefined();

      const created = await inTenant((tx) =>
        sites.upsertOnGoLive(tx, {
          deploymentId: second,
          label,
          orgId,
          projectId,
          updatedBy: null,
        }),
      );

      const offline = await inTenant((tx) =>
        sites.setOffline(tx, { orgId, projectId, updatedBy: null }),
      );
      expect(offline).toMatchObject({
        currentDeploymentId: second,
        id: created!.id,
        siteLabel: label,
        updatedBy: null,
      });
      expect(offline!.offlineAt).toBeInstanceOf(Date);

      const released = await inTenant((tx) =>
        sites.release(tx, { deploymentId: first, orgId, projectId, updatedBy: userId }),
      );
      expect(released).toMatchObject({
        currentDeploymentId: first,
        id: created!.id,
        offlineAt: null,
        siteLabel: label,
        updatedBy: userId,
      });
    });

    it('probes a label on the bypass handle, with no tenant in scope', async () => {
      const { checkpointId, projectId } = await newProject();
      const label = `site-${randomUUID().slice(0, 8)}`;
      const deploymentId = await succeeded(projectId, checkpointId);

      await inTenant((tx) =>
        sites.upsertOnGoLive(tx, {
          deploymentId,
          label,
          orgId,
          projectId,
          updatedBy: userId,
        }),
      );

      expect(await sites.probeLabel(bypass, label)).toEqual({ orgId, projectId });
      expect(await sites.probeLabel(bypass, 'no-such-label')).toBeUndefined();
    });
  });
});
