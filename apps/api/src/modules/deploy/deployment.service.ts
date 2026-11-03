import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateDeploymentRequest,
  Deployment as DeploymentContract,
  DeploymentListResponse,
  DeploymentLogResponse,
} from '@repo/contracts';
import type { Deployment } from '@repo/db';

import { NotFoundError } from '../../common/errors/domain-error';
import type { TenantTransaction } from '../../database/database.types';
import { AuditService } from '../audit/audit.service';
import { CheckpointService } from '../checkpoints/checkpoint.service';
import { OutboxWriter } from '../outbox/outbox-writer';
import { TemplateCatalogue } from '../sandbox/template-catalogue';
import { ProjectService } from '../tenancy/services/project.service';
import { LOG_TAIL_MAX_BYTES } from './deploy.constants';
import { deployConflict } from './deploy.errors';
import { DeploymentRepository } from './deployment.repository';
import { SiteRepository } from './site.repository';

/** A project in an organisation — the path's `(orgId, projectId)`. */
export interface ProjectRef {
  readonly orgId: string;
  readonly projectId: string;
}

/**
 * The tail is cut to its last 64 KiB on a UTF-8 boundary (T073), so a cut tail lands within one
 * code point (≤ 3 bytes short) of the cap. No column records the cut; a tail that close to the cap
 * is reported as truncated, which a build whose whole output happened to be that size shares.
 */
const TRUNCATED_AT_BYTES = LOG_TAIL_MAX_BYTES - 3;

/**
 * Deploy requests and reads (spec 027 US1, contracts/deployments.md). Every refusal of the create
 * is decided before a row exists; what passes is one `queued` row, its `deploy.requested` (which
 * the relay routes to `build.deploy`, where `BuildDeployConsumer` claims it) and its audit row, all
 * on the caller's one transaction. The build itself is the consumer's.
 */
@Injectable()
export class DeploymentService {
  constructor(
    @Inject(DeploymentRepository) private readonly deployments: DeploymentRepository,
    @Inject(SiteRepository) private readonly sites: SiteRepository,
    @Inject(ProjectService) private readonly projects: ProjectService,
    @Inject(CheckpointService) private readonly checkpoints: CheckpointService,
    @Inject(TemplateCatalogue) private readonly catalogue: TemplateCatalogue,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * `POST …/deployments`. Order: the project (404, archived), the template's `build`, the
   * checkpoint (named → this project's, else the head), then the in-flight slot — checked first as
   * a read so the answer names the in-flight id, and again by the partial unique index on insert
   * for the concurrent request that passed the read.
   */
  async request(
    tx: TenantTransaction,
    ref: ProjectRef,
    actorId: string,
    body: CreateDeploymentRequest,
  ): Promise<DeploymentContract> {
    const project = await this.projects.deployTarget(tx, ref);

    if (project.archived) throw deployConflict('project-archived');

    if (this.catalogue.get(project.template).manifest.build === undefined) {
      throw deployConflict('not-deployable');
    }

    const checkpoint =
      body.checkpointId === undefined
        ? await this.checkpoints.head(tx, ref)
        : await this.checkpoints.byId(tx, ref, body.checkpointId);

    if (checkpoint === null) throw new NotFoundError('The project has no checkpoint yet.');

    const active = await this.deployments.inFlight(tx, ref.orgId, ref.projectId);

    if (active !== undefined) throw deployConflict('deploy-active', { deploymentId: active.id });

    const row = await this.deployments.insertQueued(tx, {
      checkpointId: checkpoint.id,
      orgId: ref.orgId,
      projectId: ref.projectId,
      requestedBy: actorId,
      template: project.template,
    });

    if (row === undefined) {
      // A concurrent request took the slot between the read and the insert (FR-004's second net).
      const winner = await this.deployments.inFlight(tx, ref.orgId, ref.projectId);

      throw deployConflict(
        'deploy-active',
        winner === undefined ? {} : { deploymentId: winner.id },
      );
    }

    await this.outbox.append(tx, {
      aggregateId: row.id,
      orgId: ref.orgId,
      payload: { deploymentId: row.id, orgId: ref.orgId, projectId: ref.projectId },
      type: 'deploy.requested',
    });

    await this.audit.record(tx, {
      action: 'deploy.requested',
      actorId,
      metadata: { checkpointId: checkpoint.id, projectId: ref.projectId },
      orgId: ref.orgId,
      target: row.id,
    });

    return toContract(row, null);
  }

  /** Newest first. An unknown project is `404` (archived projects keep their history readable). */
  async list(
    tx: TenantTransaction,
    ref: ProjectRef,
    page: { cursor?: string | undefined; limit: number },
  ): Promise<DeploymentListResponse> {
    await this.projects.deployTarget(tx, ref);

    const { items, nextCursor } = await this.deployments.list(tx, ref.orgId, ref.projectId, page);
    const current = await this.currentId(tx, ref);

    return { items: items.map((row) => toContract(row, current)), nextCursor };
  }

  async get(tx: TenantTransaction, ref: ProjectRef, id: string): Promise<DeploymentContract> {
    const row = await this.row(tx, ref, id);

    return toContract(row, await this.currentId(tx, ref));
  }

  /** The stored, scrubbed tail; `''` before the build writes one. */
  async log(tx: TenantTransaction, ref: ProjectRef, id: string): Promise<DeploymentLogResponse> {
    const log = (await this.row(tx, ref, id)).logTail ?? '';

    return { log, truncated: Buffer.byteLength(log, 'utf8') >= TRUNCATED_AT_BYTES };
  }

  /** A row of another project is as absent as no row. */
  private async row(tx: TenantTransaction, ref: ProjectRef, id: string): Promise<Deployment> {
    const row = await this.deployments.byId(tx, ref.orgId, ref.projectId, id);

    if (row === undefined) throw new NotFoundError('No such deployment.');

    return row;
  }

  private async currentId(tx: TenantTransaction, ref: ProjectRef): Promise<string | null> {
    return (await this.sites.byProject(tx, ref.orgId, ref.projectId))?.currentDeploymentId ?? null;
  }
}

function toContract(row: Deployment, currentId: string | null): DeploymentContract {
  return {
    artifactSha: row.artifactSha,
    attempts: row.attempts,
    checkpointId: row.checkpointId,
    createdAt: row.createdAt.toISOString(),
    current: row.state === 'succeeded' && row.id === currentId,
    failureReason: row.failureReason,
    fileCount: row.fileCount,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    id: row.id,
    requestedBy: row.requestedBy,
    startedAt: row.startedAt?.toISOString() ?? null,
    state: row.state,
    totalBytes: row.totalBytes,
  };
}
