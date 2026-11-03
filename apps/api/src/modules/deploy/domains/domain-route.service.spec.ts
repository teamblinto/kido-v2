import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../../../app.module';
import { APP_DATABASE, BYPASS_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { OrgService } from '../../tenancy/services/org.service';
import { ProjectService } from '../../tenancy/services/project.service';
import { DeploymentRepository } from '../deployment.repository';
import { SiteRepository } from '../site.repository';
import { DomainRepository } from './domain.repository';
import { DomainRouteService } from './domain-route.service';
import { ownershipToken } from './ownership-token';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const ARTIFACT = 'd'.repeat(64);

type DomainState = (typeof schema.domainState.enumValues)[number];

/**
 * Spec 028 T033 against real Postgres: an `active` or `drifted` hostname on a live release
 * resolves to what the broker signs, and every other case is the same `undefined` (contract
 * domain-serving.md § 2).
 */
describe('DomainRouteService', () => {
  describe.skipIf(!postgres || !redis)('against Postgres', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let bypass: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    let service: DomainRouteService;
    const deployments = new DeploymentRepository();
    const sites = new SiteRepository();
    const domains = new DomainRepository();
    let orgId: string;
    let userId: string;
    const now = new Date('2026-09-23T12:00:00.000Z');

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
          name: 'Domain route',
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

    /** A project gone live under a fresh site label, through the repositories' own paths. */
    async function live(): Promise<{ deploymentId: string; projectId: string }> {
      const { checkpointId, projectId } = await newProject();
      const deploymentId = await queued(projectId, checkpointId);
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
          label: `site-${randomUUID().slice(0, 8)}`,
          orgId,
          projectId,
          updatedBy: userId,
        });
      });

      return { deploymentId, projectId };
    }

    /** The columns each state's CHECKs ask for (migration 0036), on top of a `pending` row. */
    function columnsFor(state: DomainState): Partial<typeof schema.domains.$inferInsert> {
      const proven = {
        activatedAt: now,
        certificateActiveAt: now,
        edgeId: `edge-${randomUUID()}`,
        ownershipVerifiedAt: now,
      };
      switch (state) {
        case 'pending':
          return {};
        case 'active':
          return proven;
        case 'drifted':
          return { ...proven, driftedAt: now };
        case 'removing':
          return { ...proven, removalRequestedAt: now };
        case 'failed':
          return { failureReason: 'ownership-not-found' };
        case 'removed':
          return { removalRequestedAt: now };
      }
    }

    function moveTo(domainId: string, state: DomainState): Promise<unknown> {
      return inTenant((tx) =>
        tx
          .update(schema.domains)
          .set({
            driftedAt: null,
            ...columnsFor(state),
            state,
          })
          .where(eq(schema.domains.id, domainId)),
      );
    }

    /** A domain on `projectId` in `state`, under a fresh hostname. */
    async function domainOn(
      projectId: string,
      state: DomainState,
    ): Promise<{ domainId: string; hostname: string }> {
      const hostname = `www-${randomUUID().slice(0, 8)}.acme.example`;
      const { id } = await inTenant((tx) =>
        domains.insert(tx, {
          addedBy: userId,
          hostname,
          now,
          orgId,
          ownershipToken: ownershipToken(),
          projectId,
        }),
      );
      await moveTo(id, state);

      return { domainId: id, hostname };
    }

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await moduleRef.init();

      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      bypass = moduleRef.get<ForgeDatabase>(BYPASS_DATABASE);
      transactions = moduleRef.get(TenantTransactionRunner);
      service = new DomainRouteService(bypass, transactions, domains);

      const [user] = await database
        .insert(schema.users)
        .values({ email: `028r-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });

      userId = user!.id;
      orgId = (
        await moduleRef.get(OrgService).create(userId, {
          name: 'Domain route fixture',
          slug: `028r-${randomUUID().slice(0, 8)}`,
        })
      ).id;
    }, 60_000);

    afterAll(async () => {
      if (orgId !== undefined) await database.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
      if (userId !== undefined)
        await database.delete(schema.users).where(eq(schema.users.id, userId));
      await moduleRef?.close();
    });

    it.each(['active', 'drifted'] as const)(
      'resolves a %s domain on a live release to its org, project, deployment and artifact',
      async (state) => {
        const { deploymentId, projectId } = await live();
        const { hostname } = await domainOn(projectId, state);

        await expect(service.resolve(hostname)).resolves.toEqual({
          artifact: ARTIFACT,
          deployment: deploymentId,
          org: orgId,
          project: projectId,
        });
        // Resolving is available through the module the broker imports.
        expect(moduleRef.get(DomainRouteService)).toBeInstanceOf(DomainRouteService);
      },
    );

    it.each(['pending', 'failed', 'removing', 'removed'] as const)(
      'answers undefined for a %s domain on a live release',
      async (state) => {
        const { projectId } = await live();
        const { hostname } = await domainOn(projectId, state);

        await expect(service.resolve(hostname)).resolves.toBeUndefined();
      },
    );

    it('answers undefined for an offline site', async () => {
      const { projectId } = await live();
      const { hostname } = await domainOn(projectId, 'active');
      await inTenant((tx) =>
        tx
          .update(schema.projectSites)
          .set({ offlineAt: now })
          .where(eq(schema.projectSites.projectId, projectId)),
      );

      await expect(service.resolve(hostname)).resolves.toBeUndefined();
    });

    it('answers undefined for a project that never deployed', async () => {
      const { projectId } = await newProject();
      const { hostname } = await domainOn(projectId, 'active');

      await expect(service.resolve(hostname)).resolves.toBeUndefined();
    });

    it('answers undefined for a deleted project', async () => {
      const { projectId } = await live();
      const { hostname } = await domainOn(projectId, 'active');
      await inTenant((tx) =>
        tx.update(schema.projects).set({ deletedAt: now }).where(eq(schema.projects.id, projectId)),
      );

      await expect(service.resolve(hostname)).resolves.toBeUndefined();
    });

    it('answers undefined for an unknown or invalid hostname, before any probe', async () => {
      const probe = vi.spyOn(domains, 'probeServing');
      try {
        await expect(service.resolve('unknown-host.acme.example')).resolves.toBeUndefined();
        expect(probe).toHaveBeenCalledTimes(1);

        probe.mockClear();
        for (const hostname of [
          '',
          'UPPER.acme.example',
          'acme.example.',
          'under_score.acme.example',
          '127.0.0.1',
          'localhost',
          '../escape',
          `${'a'.repeat(64)}.acme.example`,
          `${'abcdefghi.'.repeat(25)}example`,
        ]) {
          await expect(service.resolve(hostname)).resolves.toBeUndefined();
        }
        expect(probe).not.toHaveBeenCalled();
      } finally {
        probe.mockRestore();
      }
    });

    it('answers undefined for a domain moved to removing between the probe and the tenant read', async () => {
      const { projectId } = await live();
      const { domainId, hostname } = await domainOn(projectId, 'active');
      const probeServing = domains.probeServing.bind(domains);
      const probe = vi.spyOn(domains, 'probeServing').mockImplementation(async (db, name) => {
        const hit = await probeServing(db, name);
        // The removal commits after the probe saw the row serving.
        await moveTo(domainId, 'removing');
        return hit;
      });
      try {
        await expect(service.resolve(hostname)).resolves.toBeUndefined();
        expect(probe).toHaveBeenCalledTimes(1);
        await expect(probe.mock.results[0]!.value).resolves.toEqual({ orgId, projectId });
      } finally {
        probe.mockRestore();
      }
    });
  });
});
