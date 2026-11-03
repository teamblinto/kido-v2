import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { BYPASS_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { AuditService } from '../../audit/audit.service';
import { EventConsumer } from '../../outbox/consumer';
import type { Envelope } from '../../outbox/envelope';
import { OutboxWriter } from '../../outbox/outbox-writer';
import { CHECK_CONCURRENCY, DOMAIN_SWEEP_QUEUE, SWEEP_BATCH } from './domain.constants';
import { type DueDomain, DomainRepository } from './domain.repository';
import { DomainChecker } from './domain-checker';
import { recordRemovalRequested } from './domain-removal';

type DueEvent = Envelope<'maintenance.due'>;

/**
 * What one sweep did: rows listed, rows handled (checked, or sent to removal), and rows whose
 * handling threw.
 */
export interface SweepResult {
  readonly due: number;
  readonly checked: number;
  readonly failed: number;
}

/**
 * The `domain.check` arm of `maintenance.due` (spec 028 research R7), every 60 s on its own queue
 * on the `events` lane — the `DeploySweepConsumer` shape. One bypass probe lists at most
 * `SWEEP_BATCH` due domains across every tenant (`domains_due_idx`), then `DomainChecker.checkOne`
 * runs for each, at most `CHECK_CONCURRENCY` at once. Each check claims its row, so a tick that
 * overlaps the last one, or a check-now, does not check a domain twice.
 *
 * A deleted org's live domains are listed whatever their `next_check_at` (FR-026). Each one not
 * yet `removing` is sent there in its own tenant transaction, with no author, and its
 * `domain.removing` has `DomainCheckConsumer` deregister it; one already `removing` is checked
 * like any other.
 *
 * One domain's failure is logged and skipped: its claim lease brings it back later, and the rest
 * of the batch is checked.
 */
@Injectable()
export class DomainCheckSweepConsumer extends EventConsumer<'maintenance.due', boolean> {
  readonly attempts = 3;
  readonly name = 'domain-check-sweep';
  override readonly profile = 'events' as const;
  readonly queue = DOMAIN_SWEEP_QUEUE;
  readonly types = ['maintenance.due'] as const;

  private readonly logger = new Logger(DomainCheckSweepConsumer.name);

  constructor(
    @Inject(BYPASS_DATABASE) private readonly bypass: ForgeDatabase,
    @Inject(DomainRepository) private readonly domains: DomainRepository,
    @Inject(DomainChecker) private readonly checker: DomainChecker,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
  ) {
    super();
  }

  /** As `MaintenanceConsumer.jobId`: BullMQ refuses `:` in a custom id, so the period is epoch ms. */
  override jobId(event: DueEvent): string {
    return `${event.payload.job}.${String(Date.parse(event.payload.periodStart))}.domains`;
  }

  /** Whether this tick is ours; every other job is another module's. */
  handle(event: DueEvent): Promise<boolean> {
    return Promise.resolve(event.payload.job === 'domain.check');
  }

  override async effect(_event: DueEvent, owned: boolean): Promise<void> {
    if (!owned) return;
    const { checked, due, failed } = await this.sweep();
    if (due > 0) {
      this.logger.log(
        `checked ${String(checked)} of ${String(due)} due domain(s), ${String(failed)} failed`,
      );
    }
  }

  /** One pass over the due rows. Public for a suite to drive. */
  async sweep(): Promise<SweepResult> {
    const due = await this.domains.probeDue(this.bypass, this.clock.now(), SWEEP_BATCH);
    let next = 0;
    let checked = 0;
    let failed = 0;

    const worker = async (): Promise<void> => {
      while (next < due.length) {
        const domain: DueDomain = due[next++]!;
        try {
          if (!(domain.orgDeleted && (await this.sendToRemoval(domain)))) {
            await this.checker.checkOne(domain.orgId, domain.id);
          }
          checked += 1;
        } catch (error) {
          failed += 1;
          this.logger.warn(
            `domain check skipped ${domain.id} (org ${domain.orgId}): ${(error as Error).message}`,
          );
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CHECK_CONCURRENCY, due.length) }, () => worker()),
    );
    return { checked, due: due.length, failed };
  }

  /** FR-026: a deleted org's domain to `removing`. False when it had already left the live states. */
  private sendToRemoval(domain: DueDomain): Promise<boolean> {
    return this.transactions.runInTenantTransaction(domain.orgId, async (tx) => {
      const moved = await this.domains.markRemoving(
        tx,
        domain.orgId,
        { ids: [domain.id] },
        this.clock.now(),
      );
      const trail = { audit: this.audit, outbox: this.outbox };
      for (const row of moved) await recordRemovalRequested(tx, trail, row, null);
      return moved.length > 0;
    });
  }
}
