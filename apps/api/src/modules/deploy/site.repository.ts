import { Injectable } from '@nestjs/common';
import { type ProjectSite, schema } from '@repo/db';
import { and, eq, sql } from 'drizzle-orm';

import type { ForgeDatabase, TenantTransaction } from '../../database/database.types';
import { isUniqueViolation } from './deployment.repository';

const { deployments, projectSites } = schema;

/** Where a label points, before any tenant is known. */
export interface LabelHit {
  readonly orgId: string;
  readonly projectId: string;
}

/**
 * The `project_sites` release pointer (spec 027, data-model.md § project_sites). It is written only
 * inside the go-live and release transactions, which is what keeps "the current deployment is
 * `succeeded`" true without a CHECK. `forge_app` has no DELETE: a site goes with its project.
 */
@Injectable()
export class SiteRepository {
  /**
   * The go-live pointer write. A project's first go-live inserts the row with `label`; a later one
   * keeps the stored `site_label` (FR-020's stable address), moves the pointer and clears
   * `offline_at` — unless the site was taken offline after this deployment was requested (its
   * `created_at`): offline beats a build that was already running, so a member who took a leaking
   * site down is not overridden by it. The comparison runs in SQL against the stored `created_at`,
   * so both sides are the database's clock (`setOffline` writes `now()`) at full precision.
   * Answers `undefined` when `label` is already another project's — the caller draws a new one and
   * tries again. Runs in a savepoint so that refusal leaves the go-live transaction usable.
   */
  async upsertOnGoLive(
    tx: TenantTransaction,
    pointer: {
      deploymentId: string;
      label: string;
      orgId: string;
      projectId: string;
      updatedBy: string | null;
    },
  ): Promise<ProjectSite | undefined> {
    const requestedAt = tx
      .select({ createdAt: deployments.createdAt })
      .from(deployments)
      .where(and(eq(deployments.orgId, pointer.orgId), eq(deployments.id, pointer.deploymentId)));

    try {
      return await tx.transaction(async (savepoint) => {
        const [row] = await savepoint
          .insert(projectSites)
          .values({
            currentDeploymentId: pointer.deploymentId,
            orgId: pointer.orgId,
            projectId: pointer.projectId,
            siteLabel: pointer.label,
            updatedBy: pointer.updatedBy,
          })
          .onConflictDoUpdate({
            set: {
              currentDeploymentId: pointer.deploymentId,
              offlineAt: sql`case when ${projectSites.offlineAt} > (${requestedAt}) then ${projectSites.offlineAt} end`,
              updatedBy: pointer.updatedBy,
            },
            target: [projectSites.orgId, projectSites.projectId],
          })
          .returning();

        return row!;
      });
    } catch (error) {
      if (isUniqueViolation(error)) return undefined;
      throw error;
    }
  }

  /**
   * The release pointer write (rollback / roll-forward): moves an existing row's pointer, clears
   * `offline_at` and keeps `site_label`. The caller has proved the deployment is this project's and
   * `succeeded`, under the project writer lock. `undefined` when the project has no site row.
   */
  async release(
    tx: TenantTransaction,
    pointer: { deploymentId: string; orgId: string; projectId: string; updatedBy: string },
  ): Promise<ProjectSite | undefined> {
    const [row] = await tx
      .update(projectSites)
      .set({
        currentDeploymentId: pointer.deploymentId,
        offlineAt: null,
        updatedBy: pointer.updatedBy,
      })
      .where(
        and(eq(projectSites.orgId, pointer.orgId), eq(projectSites.projectId, pointer.projectId)),
      )
      .returning();

    return row;
  }

  /**
   * The offline write, by hand (`updatedBy` the member) or by archive (`null`). The pointer and the
   * label stay, so the next go-live or release serves on the same address. `offline_at` is the
   * database's `now()`, never the app clock: go-live compares it with `deployments.created_at`,
   * which is `now()` too, and two clocks would misorder the two under skew. `undefined` when the
   * project has no site row.
   */
  async setOffline(
    tx: TenantTransaction,
    pointer: { orgId: string; projectId: string; updatedBy: string | null },
  ): Promise<ProjectSite | undefined> {
    const [row] = await tx
      .update(projectSites)
      .set({ offlineAt: sql`now()`, updatedBy: pointer.updatedBy })
      .where(
        and(eq(projectSites.orgId, pointer.orgId), eq(projectSites.projectId, pointer.projectId)),
      )
      .returning();

    return row;
  }

  async byProject(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
  ): Promise<ProjectSite | undefined> {
    const [row] = await tx
      .select()
      .from(projectSites)
      .where(and(eq(projectSites.orgId, orgId), eq(projectSites.projectId, projectId)));

    return row;
  }

  /**
   * The label-bearing request names no tenant and `project_sites` is under RLS, so the owner is
   * found by one probe of `project_sites_site_label_key` on the bypass handle — the preview
   * precedent (`route-broker.service.ts` step 1). It answers where the label points and nothing
   * else: whether that site is live is decided under the tenant's own transaction.
   */
  async probeLabel(bypass: ForgeDatabase, label: string): Promise<LabelHit | undefined> {
    const [hit] = await bypass
      .select({ orgId: projectSites.orgId, projectId: projectSites.projectId })
      .from(projectSites)
      .where(eq(projectSites.siteLabel, label))
      .limit(1);

    return hit;
  }
}
