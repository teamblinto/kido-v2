import { Inject, Injectable, Logger } from '@nestjs/common';
import { orgs } from '@repo/db';
import { isNull } from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { APP_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { AuditService } from '../audit/audit.service';
import { EventConsumer } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import { OutboxWriter } from '../outbox/outbox-writer';
import { DEPLOY_SWEEP_QUEUE, STALE_AFTER_MS } from './deploy.constants';
import { DeploymentRepository } from './deployment.repository';

type DueEvent = Envelope<'maintenance.due'>;

/**
 * The `deploy.sweep` arm of `maintenance.due` (spec 027 US4, research R8), on its own queue on the
 * `events` lane — the `ConnectorHealthConsumer` shape. A build job that died past its DLQ (or a
 * worker lost after its last attempt) leaves the row `building` or `uploading`, holding the
 * project's one in-flight slot (FR-004); once its `started_at` is `STALE_AFTER_MS` old the sweep
 * fails it `platform` with an epoch bump — so a late write from that worker matches nothing — and
 * writes the audit row and `deploy.failed`, as the build consumer's own settle does.
 *
 * `deployments` is under forced RLS and this process holds no bypass role, so the sweep is one
 * tenant transaction per organisation; one organisation's failure rolls back only its own.
 */
@Injectable()
export class DeploySweepConsumer extends EventConsumer<'maintenance.due', boolean> {
  readonly attempts = 3;
  readonly name = 'deploy-sweep';
  override readonly profile = 'events' as const;
  readonly queue = DEPLOY_SWEEP_QUEUE;
  readonly types = ['maintenance.due'] as const;

  private readonly logger = new Logger(DeploySweepConsumer.name);

  constructor(
    @Inject(APP_DATABASE) private readonly db: ForgeDatabase,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(DeploymentRepository) private readonly deployments: DeploymentRepository,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {
    super();
  }

  /** As `MaintenanceConsumer.jobId`: BullMQ refuses `:` in a custom id, so the period is epoch ms. */
  override jobId(event: DueEvent): string {
    return `${event.payload.job}.${String(Date.parse(event.payload.periodStart))}.deploy`;
  }

  /** Whether this tick is ours; every other job is another module's. */
  handle(event: DueEvent): Promise<boolean> {
    return Promise.resolve(event.payload.job === 'deploy.sweep');
  }

  override async effect(_event: DueEvent, owned: boolean): Promise<void> {
    if (!owned) return;
    const failed = await this.sweep();
    this.logger.log(`failed ${String(failed)} stale deployment(s) as platform`);
  }

  /** One pass over every live organisation; the count settled. Public for a suite to drive. */
  async sweep(): Promise<number> {
    const now = this.clock.now();
    const olderThan = new Date(now.getTime() - STALE_AFTER_MS);
    const tenants = await this.db.select({ id: orgs.id }).from(orgs).where(isNull(orgs.deletedAt));
    let failed = 0;

    for (const { id: orgId } of tenants) {
      try {
        failed += await this.transactions.runInTenantTransaction(orgId, async (tx) => {
          const swept = await this.deployments.failStale(tx, orgId, olderThan, now);

          for (const { checkpointId, id: deploymentId, projectId } of swept) {
            await this.audit.record(tx, {
              action: 'deploy.failed',
              actorId: null,
              metadata: { checkpointId, deploymentId, projectId, reason: 'platform' },
              orgId,
              target: deploymentId,
            });
            await this.outbox.append(tx, {
              aggregateId: deploymentId,
              orgId,
              payload: { deploymentId, orgId, projectId, reason: 'platform' },
              type: 'deploy.failed',
            });
          }
          return swept.length;
        });
      } catch (error) {
        this.logger.warn(`deploy sweep skipped org ${orgId}: ${(error as Error).message}`);
      }
    }

    return failed;
  }
}
