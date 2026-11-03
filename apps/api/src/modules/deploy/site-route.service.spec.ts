import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { eq } from 'drizzle-orm';
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
import { SiteRouteService } from './site-route.service';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const ARTIFACT = 'e'.repeat(64);

/**
 * Spec 027 T036 against real Postgres: a live label resolves to what the broker signs, and every
 * other case — unknown, never live, offline, archived — is the same `undefined` (contract
 * site-serving.md § 2).
 */
describe('SiteRouteService', () => {
  describe.skipIf(!postgres || !redis)('against Postgres', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    let service: SiteRouteService;
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
          name: 'Site route',
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

    function queued(projectId: string, checkpointId: string): Promise<string> {
      return inTenant(
        async (tx) =>
          (await deployments.insertQueued(tx, {
            checkpointId,
            orgId,
            projectId,
            requestedBy: userId,
            template: 'vite-react',
          }))!.id,
      );
    }

    /** A project gone live under a fresh label, through the repositories' own paths. */
    async function live(): Promise<{ deploymentId: string; label: string; projectId: string }> {
      const { checkpointId, projectId } = await newProject();
      const deploymentId = await queued(projectId, checkpointId);
      const label = `site-${randomUUID().slice(0, 8)}`;
      await inTenant(async (tx) => {
        const { leaseEpoch } = (await deployments.claim(tx, orgId, deploymentId, now))!;
        await deployments.markUploading(tx, orgId, deploymentId, leaseEpoch, now);
        await deployments.succeed(tx, orgId, deploymentId, leaseEpoch, {
          artifactSha: ARTIFACT,
          fileCount: 1,
          finishedAt: now,
          totalBytes: 1,
        });
        await sites.upsertOnGoLive(tx, {
          deploymentId,
          label,
          orgId,
          projectId,
          updatedBy: userId,
        });
      });

      return { deploymentId, label, projectId };
    }

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await moduleRef.init();

      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      transactions = moduleRef.get(TenantTransactionRunner);
      service = new SiteRouteService(
        moduleRef.get<ForgeDatabase>(BYPASS_DATABASE),
        transactions,
        sites,
      );

      const [user] = await database
        .insert(schema.users)
        .values({ email: `027r-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });

      userId = user!.id;
      orgId = (
        await moduleRef.get(OrgService).create(userId, {
          name: 'Site route fixture',
          slug: `027r-${randomUUID().slice(0, 8)}`,
        })
      ).id;
    }, 60_000);

    afterAll(async () => {
      if (orgId !== undefined) await database.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
      if (userId !== undefined)
        await database.delete(schema.users).where(eq(schema.users.id, userId));
      await moduleRef?.close();
    });

    it('resolves a live label to its org, project, current deployment and artifact', async () => {
      const { deploymentId, label, projectId } = await live();

      await expect(service.resolve(label)).resolves.toEqual({
        artifact: ARTIFACT,
        deployment: deploymentId,
        org: orgId,
        project: projectId,
      });
      // Resolving is available through the module the broker imports.
      expect(moduleRef.get(SiteRouteService)).toBeInstanceOf(SiteRouteService);
    });

    it('answers undefined for an unknown or malformed label, with no tenant in scope', async () => {
      for (const label of [
        'no-such-site-label',
        'UPPER',
        '-leading',
        '../escape',
        'a'.repeat(64),
        '',
      ]) {
        await expect(service.resolve(label)).resolves.toBeUndefined();
      }
    });

    it('answers undefined for a label whose project never went live', async () => {
      const { checkpointId, projectId } = await newProject();
      const deploymentId = await queued(projectId, checkpointId);
      const label = `site-${randomUUID().slice(0, 8)}`;
      // Only the go-live transaction writes the pointer; a row naming an unfinished deployment is
      // what "never went live" looks like if that invariant ever slipped.
      await inTenant((tx) =>
        tx.insert(schema.projectSites).values({
          currentDeploymentId: deploymentId,
          orgId,
          projectId,
          siteLabel: label,
        }),
      );

      await expect(service.resolve(label)).resolves.toBeUndefined();
    });

    it('answers undefined for an offline site', async () => {
      const { label, projectId } = await live();
      await inTenant((tx) =>
        tx
          .update(schema.projectSites)
          .set({ offlineAt: now })
          .where(eq(schema.projectSites.projectId, projectId)),
      );

      await expect(service.resolve(label)).resolves.toBeUndefined();
    });

    it('answers undefined for an archived project', async () => {
      const { label, projectId } = await live();
      await inTenant((tx) =>
        tx.update(schema.projects).set({ deletedAt: now }).where(eq(schema.projects.id, projectId)),
      );

      await expect(service.resolve(label)).resolves.toBeUndefined();
    });
  });
});
