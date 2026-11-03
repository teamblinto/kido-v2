import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import type { TenantTransaction } from '../../database/database.types';
import { AuditService } from '../audit/audit.service';
import { CheckpointService } from '../checkpoints/checkpoint.service';
import { EventConsumer } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import { OutboxWriter } from '../outbox/outbox-writer';
import { DEPLOY_LIFECYCLE_QUEUE } from './deploy.constants';
import { DeploymentRepository } from './deployment.repository';
import { DomainRepository } from './domains/domain.repository';
import { recordRemovalRequested } from './domains/domain-removal';
import { SiteRepository } from './site.repository';

/**
 * `project.archived` → the site goes offline and any deploy in flight is `cancelled` (spec 027
 * US5, FR-032 "archiving a project MUST take its site offline and cancel any deploy in flight",
 * research R13). Database work only, on the base's transaction, under the project writer lock
 * go-live and the site routes take, so an archive and a go-live of the same project are
 * serialised.
 *
 * The cancel bumps the epoch, which fences out the build worker that held it (R8): its
 * `markUploading` and its go-live `succeed` both carry the old epoch and a claimed state, so they
 * match zero rows and it writes nothing further. The offline write has no author
 * (`updated_by` null, data-model) and, like `PUT …/site { offline }`, is idempotent by its target
 * state: a re-delivery finds `offline_at` set and writes no second audit row or `site.offline`.
 *
 * Every live domain of the project goes to `removing` in the same transaction (spec 028 FR-026,
 * research R1, R10), each with a `domain.removal-requested` audit row that has no author and a
 * `domain.removing` event for the check routine to deregister it. It does so whether or not the
 * site ever went live, and a re-delivery finds none left to move.
 *
 * Its own queue on the `events` profile, so the flip never waits behind fifteen-minute builds on
 * `build.deploy` (`agent`); the registry refuses two profiles on one queue.
 */
@Injectable()
export class DeployProjectConsumer extends EventConsumer<'project.archived'> {
  readonly attempts = 5;
  readonly name = 'deploy-project';
  override readonly profile = 'events' as const;
  readonly queue = DEPLOY_LIFECYCLE_QUEUE;
  readonly types = ['project.archived'] as const;

  constructor(
    @Inject(DeploymentRepository) private readonly deployments: DeploymentRepository,
    @Inject(SiteRepository) private readonly sites: SiteRepository,
    @Inject(CheckpointService) private readonly checkpoints: CheckpointService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(DomainRepository) private readonly domains: DomainRepository,
  ) {
    super();
  }

  async handle(event: Envelope<'project.archived'>, tx: TenantTransaction): Promise<void> {
    const { orgId, projectId } = event.payload;
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    await this.checkpoints.lockProject(tx, { orgId, projectId });

    const now = this.clock.now();
    await this.deployments.cancelInFlight(tx, orgId, projectId, now);

    for (const domain of await this.domains.markRemoving(tx, orgId, { projectId }, now)) {
      await recordRemovalRequested(tx, { audit: this.audit, outbox: this.outbox }, domain, null);
    }

    const stored = await this.sites.byProject(tx, orgId, projectId);
    // No site row (never went live), or already offline: nothing to write.
    if (stored?.offlineAt !== null) return;

    await this.sites.setOffline(tx, { orgId, projectId, updatedBy: null });
    await this.audit.record(tx, {
      action: 'site.offline',
      actorId: null,
      metadata: { projectId },
      orgId,
      target: projectId,
    });
    await this.outbox.append(tx, {
      aggregateId: projectId,
      orgId,
      payload: { orgId, projectId },
      type: 'site.offline',
    });
  }
}
