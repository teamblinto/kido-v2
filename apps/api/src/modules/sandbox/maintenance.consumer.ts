import { Inject, Injectable } from '@nestjs/common';

import { EventConsumer } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import { PoolRefill } from './pool-refill';
import { MAINTENANCE_QUEUE, type MaintenanceJob } from './sandbox.constants';
import { SandboxReconciler } from './sandbox-reconciler';
import { SandboxSweep } from './sandbox-sweep';

type DueEvent = Envelope<'maintenance.due'>;

/**
 * The `maintenance` queue's consumer (spec 014 contract § 4, research R7): one `due` per job per
 * period, dispatched to the job's callable in `effect` — each drives Daytona, so none runs on the
 * base's transaction. The callables compute from current state, never from the job, so a retry
 * re-runs one whole; an error is left to the registry's retry and dead-letter path.
 */
@Injectable()
export class MaintenanceConsumer extends EventConsumer<'maintenance.due', MaintenanceJob> {
  readonly attempts = 3;
  override readonly concurrency = 2;
  readonly name = 'maintenance';
  override readonly profile = 'cron' as const;
  readonly queue = MAINTENANCE_QUEUE;
  readonly types = ['maintenance.due'] as const;

  constructor(
    @Inject(SandboxSweep) private readonly sweep: SandboxSweep,
    @Inject(PoolRefill) private readonly refill: PoolRefill,
    @Inject(SandboxReconciler) private readonly reconciler: SandboxReconciler,
  ) {
    super();
  }

  /**
   * The outbox key is `${job}:${periodStart}`; BullMQ refuses a custom id containing `:` (as
   * `mailJobId` found), and the ISO period start carries two, so the id is the period in epoch ms.
   */
  override jobId(event: DueEvent): string {
    return `${event.payload.job}.${Date.parse(event.payload.periodStart)}`;
  }

  handle(event: DueEvent): Promise<MaintenanceJob> {
    return Promise.resolve(event.payload.job);
  }

  override async effect(_event: DueEvent, job: MaintenanceJob): Promise<void> {
    switch (job) {
      case 'sandbox.sweep':
        await this.sweep.sweep();
        return;
      case 'sandbox.refill':
        await this.refill.refill();
        return;
      case 'sandbox.reconcile':
        await this.reconciler.reconcile();
        return;
      case 'connector.verify':
      case 'connector.sync-reconcile':
      case 'connector.ops-timeout':
      case 'byok.verify':
      case 'byos.verify':
      case 'webhook.retention':
      case 'deploy.sweep':
      case 'domain.check':
      case 'webhook.redeliver':
        // Spec 018 R9 / 020 US4 / 026 R15 / 027 R8 / 028 / 029 R6: `ConnectorHealthConsumer`,
        // `ProviderKeyHealthConsumer`, `LinkedAccountHealthConsumer` (032), `WebhooksMaintenanceConsumer` (retention),
        // `DeploySweepConsumer`, the domain check routine and `WebhooksMaintenanceConsumer`
        // (redelivery) take these on their own queues.
        return;
      default:
        // Exhaustive: a job added to `MaintenanceJob` without a case here stops compiling.
        return job satisfies never;
    }
  }
}
