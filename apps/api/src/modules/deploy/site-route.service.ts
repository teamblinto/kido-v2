import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@repo/db';
import { and, eq, isNull } from 'drizzle-orm';

import { BYPASS_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { SiteRepository } from './site.repository';

const { deployments, projectSites, projects } = schema;

/** Contract site-serving.md § 1's host grammar, the same as the `project_sites` CHECK. */
const SITE_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** What a live label points at: the claims of the signed site record, less `kind`, `label` and times. */
export interface SiteRoute {
  readonly artifact: string;
  readonly deployment: string;
  readonly org: string;
  readonly project: string;
}

/**
 * Resolves a site label for `preview`'s broker (spec 027, contract site-serving.md § 2) — this
 * module's one export. Step 1 is the bypass probe of `project_sites_site_label_key`
 * (`SiteRepository.probeLabel`); step 2, under that tenant's transaction, is the pointer, the
 * project (`deleted_at IS NULL`), the current deployment (`state = 'succeeded'`) and
 * `offline_at IS NULL`. Every refusal — unknown, never live, offline, archived — is the same
 * `undefined`: the wire answer is one `404 {}`, so there is nothing to tell apart here either.
 */
@Injectable()
export class SiteRouteService {
  constructor(
    @Inject(BYPASS_DATABASE) private readonly bypass: ForgeDatabase,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(SiteRepository) private readonly sites: SiteRepository,
  ) {}

  async resolve(label: string): Promise<SiteRoute | undefined> {
    if (!SITE_LABEL.test(label)) return undefined;

    const hit = await this.sites.probeLabel(this.bypass, label);
    if (hit === undefined) return undefined;

    const [row] = await this.transactions.runInTenantTransaction(hit.orgId, (tx) =>
      tx
        .select({ artifact: deployments.artifactSha, deployment: deployments.id })
        .from(projectSites)
        .innerJoin(
          projects,
          and(eq(projects.orgId, projectSites.orgId), eq(projects.id, projectSites.projectId)),
        )
        .innerJoin(
          deployments,
          and(
            eq(deployments.orgId, projectSites.orgId),
            eq(deployments.id, projectSites.currentDeploymentId),
          ),
        )
        .where(
          and(
            eq(projectSites.orgId, hit.orgId),
            eq(projectSites.siteLabel, label),
            isNull(projectSites.offlineAt),
            isNull(projects.deletedAt),
            eq(deployments.state, 'succeeded'),
          ),
        )
        .limit(1),
    );
    // `deployments_succeeded_artifact_check` makes a succeeded row's artifact non-null.
    if (row?.artifact == null) return undefined;

    return {
      artifact: row.artifact,
      deployment: row.deployment,
      org: hit.orgId,
      project: hit.projectId,
    };
  }
}
