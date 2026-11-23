import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type DeploymentFailureReason,
  type ProjectTemplate,
  projectTemplateSchema,
} from '@repo/contracts';
import { type Deployment, schema } from '@repo/db';
import { eq, sql } from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import type { ObjectStorePort } from '../../common/object-store/object-store.port';
import { NotFoundError } from '../../common/errors/domain-error';
import type { TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { AuditService } from '../audit/audit.service';
import { CheckpointService } from '../checkpoints/checkpoint.service';
import { classifyHttpStatus, EventConsumer, RetryableFailure } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import { OutboxWriter } from '../outbox/outbox-writer';
import { PermissionResolutionService } from '../rbac/permission-resolution.service';
import { scoped } from '../rbac/permissions';
import { DaytonaError } from '../sandbox/sandbox.errors';
import { parseRunConfig } from '../sandbox/run-config';
import { TemplateCatalogue } from '../sandbox/template-catalogue';
import { ProjectService } from '../tenancy/services/project.service';
import { type UploadResult, upload } from './artifact';
import { type BuildInput, type BuildOutcome, BuildRunner } from './build-runner';
import { ARTIFACT_STORE, BUILD_DEPLOY_QUEUE } from './deploy.constants';
import { DeploymentRepository } from './deployment.repository';
import { logTail } from './log-tail';
import { siteLabel } from './site-label';
import { SiteRepository } from './site.repository';

type DeployEvent = Envelope<'deploy.requested'>;

/** What `handle` claimed for `effect`: the row at its new epoch and the commit to build. */
export interface ClaimedDeployment {
  readonly deployment: Deployment;
  readonly epoch: number;
  readonly gitSha: string;
  readonly template: ProjectTemplate;
  /** Spec 047: the project's run profile build, when it has one. */
  readonly profile?: BuildInput['profile'];
}

/** `undefined`: nothing to build — gone, settled, fenced, or settled here past the upload boundary. */
export type BuildDeployJob = ClaimedDeployment | undefined;

/** Draws of a fresh site label before go-live gives up (40 random bits each; R10). */
const LABEL_ATTEMPTS = 5;

/**
 * `deploy.requested` → build, upload, go live (spec 027 US1, research R8, R9, R15).
 *
 * `handle` is R8's claim on the base's transaction: `queued` (or this job's own earlier
 * `building`) moves to `building` with a new epoch, and FR-012's toolchain pin is written with it.
 * A re-delivery whose row is already past the upload boundary is settled `failed / platform`
 * there and then (FR-015) — never rebuilt.
 *
 * `effect` runs with no connection held: `BuildRunner` (bundle → build sandbox → tar), then the
 * fenced `uploading` mark **before** the first object PUT, the upload, and one go-live
 * transaction — the project writer lock, the re-check of `project:deploy@<projectId>` for the
 * requester (R9), the fenced `succeeded` flip, the `project_sites` upsert (the stored label kept,
 * a new one drawn only on the first go-live) and the audit row and `deploy.succeeded`. Every write
 * carries the epoch: zero rows means another claim or a cancel took the row, and this worker
 * writes nothing further (FR-017).
 *
 * Classification (US4, FR-013, FR-015) — the `SyncConsumer.classify` pattern: the runner's own
 * verdicts (`install-failed`, `build-failed`, `no-output`, `output-too-large`, `timeout`) settle
 * at once and are never retried. A transient fault before the boundary — a provider 5xx, 429 or
 * timeout, a build sandbox that never started, the repos bucket unavailable — is rethrown as a
 * `RetryableFailure` while attempts remain and settles `platform` on the last one; any other
 * throw settles `platform` at once. Anything after the boundary — the upload, the go-live
 * transaction — settles `platform` and is never thrown as retryable: a retry would rebuild.
 * Every stored tail goes through `logTail` (scrubbed, last 64 KiB).
 *
 * ponytail: the per-organisation build cap (spec assumption: 2) is deferred (research R16) —
 * BullMQ's group concurrency is a paid feature and a claim-time count needs a delayed re-queue.
 * The per-node `concurrency` of 4 bounds the fleet until then.
 */
@Injectable()
export class BuildDeployConsumer extends EventConsumer<'deploy.requested', BuildDeployJob> {
  readonly attempts = 3;
  override readonly concurrency = 4;
  override readonly maxStalledCount = 1;
  readonly name = 'deploy-build';
  override readonly profile = 'agent' as const;
  readonly queue = BUILD_DEPLOY_QUEUE;
  readonly types = ['deploy.requested'] as const;

  private readonly logger = new Logger(BuildDeployConsumer.name);

  constructor(
    @Inject(DeploymentRepository) private readonly deployments: DeploymentRepository,
    @Inject(SiteRepository) private readonly sites: SiteRepository,
    @Inject(BuildRunner) private readonly runner: BuildRunner,
    @Inject(CheckpointService) private readonly checkpoints: CheckpointService,
    @Inject(TemplateCatalogue) private readonly catalogue: TemplateCatalogue,
    @Inject(ProjectService) private readonly projects: ProjectService,
    @Inject(PermissionResolutionService) private readonly permissions: PermissionResolutionService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(ARTIFACT_STORE) private readonly store: ObjectStorePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {
    super();
  }

  /** One job per deployment: a republished event is a no-op (research R15). */
  override jobId(event: DeployEvent): string {
    return event.payload.deploymentId;
  }

  async handle(event: DeployEvent, tx: TenantTransaction): Promise<BuildDeployJob> {
    const { deploymentId, orgId } = event.payload;
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    const now = this.clock.now();

    // A throw here is terminal (the base dead-letters it) and would roll the claim back, leaving
    // the row `queued` in the in-flight slot. The claim runs in a savepoint instead, so even a
    // statement that aborted it leaves this transaction able to settle the row `platform`.
    try {
      return await tx.transaction((savepoint) => this.claim(event, savepoint, now));
    } catch (error) {
      this.logger.warn(`deployment ${deploymentId} failed at its claim: ${message(error)}`);
      if (await this.deployments.failInFlight(tx, orgId, deploymentId, now)) {
        const row = await this.deployments.byId(tx, orgId, event.payload.projectId, deploymentId);
        if (row !== undefined) await this.trailFailure(tx, row, 'platform');
      }
      return undefined;
    }
  }

  private async claim(
    event: DeployEvent,
    tx: TenantTransaction,
    now: Date,
  ): Promise<BuildDeployJob> {
    const { deploymentId, orgId, projectId } = event.payload;
    const deployment = await this.deployments.claim(tx, orgId, deploymentId, now);

    if (deployment === undefined) {
      // FR-015: past the boundary a stalled job is surfaced as `platform`, never rebuilt.
      if (await this.deployments.failPastUpload(tx, orgId, deploymentId, now)) {
        const row = await this.deployments.byId(tx, orgId, projectId, deploymentId);
        if (row !== undefined) await this.trailFailure(tx, row, 'platform');
      }
      return undefined;
    }

    const epoch = deployment.leaseEpoch;
    const template = projectTemplateSchema.safeParse(deployment.template);
    const checkpoint = await this.checkpoints
      .byId(tx, { orgId, projectId }, deployment.checkpointId)
      .catch((error: unknown) => {
        if (error instanceof NotFoundError) return undefined;
        throw error;
      });

    if (!template.success || checkpoint === undefined) {
      await this.settleFailed(
        tx,
        deployment,
        epoch,
        'platform',
        'the checkpoint or template is gone\n',
      );
      return undefined;
    }

    const definition = this.catalogue.get(template.data);
    await this.deployments.recordToolchain(tx, orgId, deploymentId, epoch, {
      templateDigest: definition.digest,
      templateSnapshot: definition.snapshot,
    });

    // Spec 047: a project run from its own profile builds and installs the profile's way.
    const [project] = await tx
      .select({ runConfig: schema.projects.runConfig })
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId));
    const config = parseRunConfig(project?.runConfig);
    const profile =
      config?.build == null ? undefined : { build: config.build, install: config.install };

    return {
      deployment,
      epoch,
      gitSha: checkpoint.gitSha,
      template: template.data,
      ...(profile === undefined ? {} : { profile }),
    };
  }

  override async effect(_event: DeployEvent, job: BuildDeployJob, attempt = 1): Promise<void> {
    if (job === undefined) return;
    const { deployment, epoch } = job;
    const { orgId, projectId } = deployment;

    let outcome: BuildOutcome;
    try {
      outcome = await this.runner.run({
        deploymentId: deployment.id,
        gitSha: job.gitSha,
        orgId,
        projectId,
        template: job.template,
        ...(job.profile === undefined ? {} : { profile: job.profile }),
      });
    } catch (error) {
      const retry = this.classify(error, attempt);
      if (retry !== undefined) throw retry;
      this.logger.warn(
        `deployment ${deployment.id} failed on attempt ${String(attempt)}: ${message(error)}`,
      );
      await this.inTenant(orgId, (tx) =>
        this.settleFailed(tx, deployment, epoch, 'platform', `build aborted: ${nameOf(error)}\n`),
      );
      return;
    }

    if (outcome.kind === 'failed') {
      await this.inTenant(orgId, (tx) =>
        this.settleFailed(tx, deployment, epoch, outcome.reason, outcome.log),
      );
      return;
    }

    // R8's boundary, fenced and committed before the first PUT: from here nothing is retried.
    const uploading = await this.inTenant(orgId, (tx) =>
      this.deployments.markUploading(tx, orgId, deployment.id, epoch, this.clock.now()),
    );
    if (!uploading) return this.fencedOut(deployment);

    let artifact: UploadResult;
    try {
      artifact = await upload(this.store, orgId, projectId, outcome.files);
    } catch (error) {
      // The class name says which failure (unconfigured store, S3 refusal, timeout), never a secret.
      return this.failPastBoundary(
        deployment,
        epoch,
        `${outcome.log}upload failed: ${nameOf(error)}\n`,
        error,
      );
    }

    try {
      await this.goLive(deployment, epoch, artifact, outcome.log);
    } catch (error) {
      // The go-live transaction rolled back whole: the row is still this epoch's `uploading`.
      await this.failPastBoundary(
        deployment,
        epoch,
        `${outcome.log}go-live failed: ${nameOf(error)}\n`,
        error,
      );
    }
  }

  /** FR-015: past the boundary every failure is `platform`, settled here, never rethrown. */
  private async failPastBoundary(
    deployment: Deployment,
    epoch: number,
    log: string,
    error: unknown,
  ): Promise<void> {
    this.logger.warn(`deployment ${deployment.id} failed after upload began: ${message(error)}`);
    await this.inTenant(deployment.orgId, (tx) =>
      this.settleFailed(tx, deployment, epoch, 'platform', log),
    );
  }

  /** R9: one transaction — lock, re-check, fenced flip, pointer, trail. */
  private async goLive(
    deployment: Deployment,
    epoch: number,
    artifact: UploadResult,
    log: string,
  ): Promise<void> {
    const { orgId, projectId } = deployment;

    await this.inTenant(orgId, async (tx) => {
      await this.checkpoints.lockProject(tx, { orgId, projectId });

      const project = await this.projects.deployTarget(tx, { orgId, projectId });
      const held = await this.permissions.for(orgId, deployment.requestedBy);

      // Archived since the claim: R9's `cancelled`, the archive consumer's own outcome (US5).
      if (project.archived) {
        await this.deployments.cancelInFlight(tx, orgId, projectId, this.clock.now());
        return;
      }

      // The artifact stays in the bucket: a member who holds the permission can make it current
      // later (spec edge case). The pointer is not touched.
      if (!held.has(scoped('project:deploy', projectId))) {
        await this.settleFailed(tx, deployment, epoch, 'not-authorised', log);
        return;
      }

      const succeeded = await this.deployments.succeed(tx, orgId, deployment.id, epoch, {
        ...artifact,
        finishedAt: this.clock.now(),
        logTail: logTail(log),
      });
      if (!succeeded) return this.fencedOut(deployment);

      const stored = await this.sites.byProject(tx, orgId, projectId);
      let pointer;
      for (let draw = 0; pointer === undefined && draw < LABEL_ATTEMPTS; draw++) {
        pointer = await this.sites.upsertOnGoLive(tx, {
          deploymentId: deployment.id,
          label: stored?.siteLabel ?? siteLabel(project.name, project.previewLabel),
          orgId,
          projectId,
          updatedBy: deployment.requestedBy,
        });
      }
      if (pointer === undefined) {
        throw new Error(`no free site label after ${String(LABEL_ATTEMPTS)} draws`);
      }

      await this.audit.record(tx, {
        action: 'deploy.succeeded',
        actorId: null,
        metadata: { checkpointId: deployment.checkpointId, deploymentId: deployment.id, projectId },
        orgId,
        target: deployment.id,
      });
      await this.outbox.append(tx, {
        aggregateId: deployment.id,
        orgId,
        payload: { deploymentId: deployment.id, orgId, projectId, siteLabel: pointer.siteLabel },
        type: 'deploy.succeeded',
      });
    });
  }

  /** The fenced settle and, when it landed, its audit row and `deploy.failed`. */
  private async settleFailed(
    tx: TenantTransaction,
    deployment: Deployment,
    epoch: number,
    reason: DeploymentFailureReason,
    log: string,
  ): Promise<void> {
    const settled = await this.deployments.fail(tx, deployment.orgId, deployment.id, epoch, {
      finishedAt: this.clock.now(),
      logTail: logTail(log),
      reason,
    });
    if (!settled) return this.fencedOut(deployment);

    await this.trailFailure(tx, deployment, reason);
  }

  private async trailFailure(
    tx: TenantTransaction,
    deployment: Deployment,
    reason: DeploymentFailureReason,
  ): Promise<void> {
    const { id: deploymentId, orgId, projectId } = deployment;
    await this.audit.record(tx, {
      action: 'deploy.failed',
      actorId: null,
      metadata: {
        checkpointId: deployment.checkpointId,
        deploymentId,
        projectId,
        reason,
      },
      orgId,
      target: deploymentId,
    });
    await this.outbox.append(tx, {
      aggregateId: deploymentId,
      orgId,
      payload: { deploymentId, orgId, projectId, reason },
      type: 'deploy.failed',
    });
  }

  /**
   * A fault before the boundary: the `RetryableFailure` to rethrow while attempts remain, or
   * `undefined` to settle `platform` — on the last attempt, or for a fault no retry fixes.
   */
  private classify(error: unknown, attempt: number): RetryableFailure | undefined {
    return attempt < this.attempts ? transient(error) : undefined;
  }

  private fencedOut(deployment: Deployment): void {
    this.logger.warn(
      `deployment ${deployment.id} was claimed or cancelled elsewhere; writing nothing`,
    );
  }

  private inTenant<T>(orgId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
    return this.transactions.runInTenantTransaction(orgId, fn);
  }
}

/**
 * The faults worth another attempt (the repo mirror's rule): a retryable Daytona error — 429 as
 * `throttled`, a wire failure as `timeout` — and an S3 SDK error with no status (the wire), a 429
 * or a 5xx (the repos bucket, read for the bundle).
 */
function transient(error: unknown): RetryableFailure | undefined {
  if (error instanceof RetryableFailure) return error;
  if (error instanceof DaytonaError) {
    if (!error.retryable) return undefined;
    if (error.status === 429) return new RetryableFailure('throttled', error);
    return new RetryableFailure(error.status === undefined ? 'timeout' : 'upstream-5xx', error);
  }
  if (typeof error === 'object' && error !== null && '$metadata' in error) {
    const status = (error as { $metadata: { httpStatusCode?: number } }).$metadata.httpStatusCode;
    if (status === undefined) return new RetryableFailure('timeout', error);
    if (classifyHttpStatus(status) === 'retryable') {
      return new RetryableFailure(status === 429 ? 'throttled' : 'upstream-5xx', error);
    }
  }
  return undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
