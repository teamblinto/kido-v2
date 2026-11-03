import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ProjectTemplate, Site } from '@repo/contracts';
import type { ProjectSite } from '@repo/db';

import { NotFoundError } from '../../common/errors/domain-error';
import type { Environment } from '../../config/environment';
import type { TenantTransaction } from '../../database/database.types';
import { AuditService } from '../audit/audit.service';
import { CheckpointService } from '../checkpoints/checkpoint.service';
import { OutboxWriter } from '../outbox/outbox-writer';
import { TemplateCatalogue } from '../sandbox/template-catalogue';
import { ProjectService } from '../tenancy/services/project.service';
import { deployConflict } from './deploy.errors';
import { DeploymentRepository } from './deployment.repository';
import type { ProjectRef } from './deployment.service';
import { SiteRepository } from './site.repository';

/**
 * The project's site (spec 027 US2 and US5, contracts/deployments.md § site): read it, release a
 * `succeeded` deployment onto it (rollback / roll-forward, no build), or take it offline. Both
 * writes take the project writer lock go-live takes (`CheckpointService.lockProject`), so a release
 * and a go-live of the same project are serialised, and each writes the pointer, its audit row and
 * its event on the caller's one transaction. Both are idempotent by their target state: a repeat
 * writes nothing and answers the same body.
 */
@Injectable()
export class SiteService {
  private readonly domain: string;

  constructor(
    @Inject(SiteRepository) private readonly sites: SiteRepository,
    @Inject(DeploymentRepository) private readonly deployments: DeploymentRepository,
    @Inject(ProjectService) private readonly projects: ProjectService,
    @Inject(CheckpointService) private readonly checkpoints: CheckpointService,
    @Inject(TemplateCatalogue) private readonly catalogue: TemplateCatalogue,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ConfigService) config: ConfigService<Environment, true>,
  ) {
    this.domain = config.get('SITE_DOMAIN', { infer: true });
  }

  /** `GET …/site`. An unknown project is `404`; archived projects stay readable. */
  async read(tx: TenantTransaction, ref: ProjectRef): Promise<Site> {
    const project = await this.projects.deployTarget(tx, ref);
    const row = await this.sites.byProject(tx, ref.orgId, ref.projectId);

    return this.toContract(row, project.template);
  }

  /**
   * `PUT …/site { action: 'release' }`. Order: the lock, the project (404, archived), the
   * deployment (another project's is as absent as none), its state, then the pointer.
   */
  async release(
    tx: TenantTransaction,
    ref: ProjectRef,
    actorId: string,
    deploymentId: string,
  ): Promise<Site> {
    await this.checkpoints.lockProject(tx, ref);

    const project = await this.projects.deployTarget(tx, ref);
    if (project.archived) throw deployConflict('project-archived');

    const deployment = await this.deployments.byId(tx, ref.orgId, ref.projectId, deploymentId);
    if (deployment === undefined) throw new NotFoundError('No such deployment.');
    if (deployment.state !== 'succeeded') throw deployConflict('not-releasable');

    const stored = await this.sites.byProject(tx, ref.orgId, ref.projectId);
    if (stored?.currentDeploymentId === deploymentId && stored.offlineAt === null) {
      return this.toContract(stored, project.template);
    }

    // A succeeded deployment went live, and go-live writes the row in the same transaction.
    const row = await this.sites.release(tx, { ...ref, deploymentId, updatedBy: actorId });
    if (row === undefined) throw deployConflict('never-deployed');

    await this.audit.record(tx, {
      action: 'site.released',
      actorId,
      metadata: { deploymentId, projectId: ref.projectId },
      orgId: ref.orgId,
      target: ref.projectId,
    });
    await this.outbox.append(tx, {
      aggregateId: ref.projectId,
      orgId: ref.orgId,
      payload: { deploymentId, orgId: ref.orgId, projectId: ref.projectId },
      type: 'site.released',
    });

    return this.toContract(row, project.template);
  }

  /** `PUT …/site { action: 'offline' }`. A project with no site row is `never-deployed`. */
  async offline(tx: TenantTransaction, ref: ProjectRef, actorId: string): Promise<Site> {
    await this.checkpoints.lockProject(tx, ref);

    const project = await this.projects.deployTarget(tx, ref);
    const stored = await this.sites.byProject(tx, ref.orgId, ref.projectId);
    if (stored === undefined) throw deployConflict('never-deployed');
    if (stored.offlineAt !== null) return this.toContract(stored, project.template);

    const row = await this.sites.setOffline(tx, { ...ref, updatedBy: actorId });
    if (row === undefined) throw deployConflict('never-deployed');

    await this.audit.record(tx, {
      action: 'site.offline',
      actorId,
      metadata: { projectId: ref.projectId },
      orgId: ref.orgId,
      target: ref.projectId,
    });
    await this.outbox.append(tx, {
      aggregateId: ref.projectId,
      orgId: ref.orgId,
      payload: { orgId: ref.orgId, projectId: ref.projectId },
      type: 'site.offline',
    });

    return this.toContract(row, project.template);
  }

  private toContract(row: ProjectSite | undefined, template: ProjectTemplate): Site {
    return {
      currentDeploymentId: row?.currentDeploymentId ?? null,
      deployable: this.catalogue.get(template).manifest.build !== undefined,
      offline: row?.offlineAt != null,
      url: row === undefined ? null : `https://${row.siteLabel}.${this.domain}`,
    };
  }
}
