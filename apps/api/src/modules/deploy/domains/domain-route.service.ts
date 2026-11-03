import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@repo/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { BYPASS_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import type { SiteRoute } from '../site-route.service';
import { DomainRepository, SERVING_STATES } from './domain.repository';
import { normaliseHostname } from './normalise-hostname';

const { deployments, domains, projectSites, projects } = schema;

/** What a serving hostname points at: the claims of the signed domain record, less `kind`, `hostname` and times. */
export type DomainRoute = SiteRoute;

/**
 * Resolves a custom hostname for `preview`'s broker (spec 028, contract domain-serving.md § 2).
 *
 * 1. The hostname must already be in the stored form (research R8): a name `normaliseHostname`
 *    would change or refuse is never probed.
 * 2. The bypass probe of `domains_serving_idx` (`DomainRepository.probeServing`) finds the owner.
 * 3. Under that tenant's transaction, `SiteRouteService`'s join — the pointer, the project
 *    (`deleted_at IS NULL`), the current deployment (`state = 'succeeded'`), `offline_at IS NULL` —
 *    plus the domain row itself, still `active`/`drifted`, so a removal committed after the probe
 *    is honoured.
 *
 * Every refusal is the same `undefined`: the wire answer is one `404 {}`.
 */
@Injectable()
export class DomainRouteService {
  constructor(
    @Inject(BYPASS_DATABASE) private readonly bypass: ForgeDatabase,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(DomainRepository) private readonly domains: DomainRepository,
  ) {}

  async resolve(hostname: string): Promise<DomainRoute | undefined> {
    const normalised = normaliseHostname(hostname, []);
    if (!normalised.ok || normalised.hostname !== hostname) return undefined;

    const hit = await this.domains.probeServing(this.bypass, hostname);
    if (hit === undefined) return undefined;

    const [row] = await this.transactions.runInTenantTransaction(hit.orgId, (tx) =>
      tx
        .select({ artifact: deployments.artifactSha, deployment: deployments.id })
        .from(domains)
        .innerJoin(
          projectSites,
          and(eq(projectSites.orgId, domains.orgId), eq(projectSites.projectId, domains.projectId)),
        )
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
            eq(domains.orgId, hit.orgId),
            eq(domains.projectId, hit.projectId),
            eq(domains.hostname, hostname),
            inArray(domains.state, SERVING_STATES),
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
