import { Inject, Injectable, Logger } from '@nestjs/common';
import { orgs } from '@repo/db';
import { and, inArray, isNull } from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { APP_DATABASE, BYPASS_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { EventConsumer } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import { OutboxWriter } from '../outbox/outbox-writer';
import {
  type RetentionSweepReport,
  WebhookDeliveryRepository,
} from './inbound/inbound-delivery.repository';
import { EndpointRepository } from './outbound/endpoint.repository';
import { type OutboundRetentionReport, SendRepository } from './outbound/send.repository';
import { REDELIVER_BATCH, REDELIVER_PER_ORG, WEBHOOK_SWEEP_QUEUE } from './webhooks.constants';

type DueEvent = Envelope<'maintenance.due'>;

/** The `maintenance.due` jobs this consumer owns. */
type OwnedJob = 'webhook.redeliver' | 'webhook.retention';

/** What one retention pass did: the inbound table's sweep (a full pass only) and the outbound log's. */
export interface RetentionResult {
  readonly inbound: RetentionSweepReport | null;
  readonly outbound: OutboundRetentionReport & { readonly secretsExpired: number };
}

/** What one redelivery tick did: sends the probe found, and sends claimed and appended. */
export interface RedeliverResult {
  readonly claimed: number;
  readonly due: number;
}

/**
 * The webhooks module's arms of `maintenance.due` (spec 029 research R6, R12), on its own queue
 * on the `events` lane, the `DomainCheckSweepConsumer` shape: a queue takes one consumer per event
 * type, so this cannot share `maintenance` with the sandbox consumer.
 *
 * `webhook.redeliver`, every 60 s: one `forge_bypass` probe of due, unclaimed `pending` sends
 * across every org (at most `REDELIVER_BATCH`, and `REDELIVER_PER_ORG` for any one org), then, per
 * org in its own tenant transaction, each still-due send is claimed (its `next_attempt_at` moves
 * one lease ahead) and given a `webhook.attempt-due`. One org's failure is logged and skipped; its
 * sends stay due for the next tick.
 *
 * `webhook.retention`, daily (research R12, ADR 051), the job's one owner (T089):
 * - inbound: one pass over the platform table `webhook_deliveries`, which has no `org_id`, on the
 *   application database: `body` nulled at 7 days, the row deleted at 30 (spec 026 R15);
 * - outbound: per live org, in its own tenant transaction, `webhook_sends.body` and
 *   `webhook_send_attempts.response_body` nulled at 7 days and sends deleted at 30, their attempts
 *   by cascade; and every rotation overlap that has expired ends, its previous `secrets` row
 *   deleted (research R10). One org's failure is logged and skipped.
 */
@Injectable()
export class WebhooksMaintenanceConsumer extends EventConsumer<'maintenance.due', OwnedJob | null> {
  readonly attempts = 3;
  readonly name = 'webhooks-maintenance';
  override readonly profile = 'events' as const;
  readonly queue = WEBHOOK_SWEEP_QUEUE;
  readonly types = ['maintenance.due'] as const;

  private readonly logger = new Logger(WebhooksMaintenanceConsumer.name);

  constructor(
    @Inject(BYPASS_DATABASE) private readonly bypass: ForgeDatabase,
    @Inject(APP_DATABASE) private readonly db: ForgeDatabase,
    @Inject(SendRepository) private readonly sends: SendRepository,
    @Inject(EndpointRepository) private readonly endpoints: EndpointRepository,
    @Inject(WebhookDeliveryRepository) private readonly inbound: WebhookDeliveryRepository,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {
    super();
  }

  /** As `MaintenanceConsumer.jobId`: BullMQ refuses `:` in a custom id, so the period is epoch ms. */
  override jobId(event: DueEvent): string {
    return `${event.payload.job}.${String(Date.parse(event.payload.periodStart))}.webhooks`;
  }

  /** Whether this tick is ours; every other job is another module's. */
  handle(event: DueEvent): Promise<OwnedJob | null> {
    const { job } = event.payload;
    return Promise.resolve(job === 'webhook.redeliver' || job === 'webhook.retention' ? job : null);
  }

  override async effect(_event: DueEvent, job: OwnedJob | null): Promise<void> {
    if (job === null) return;
    if (job === 'webhook.retention') {
      const { inbound, outbound } = await this.retain();
      this.logger.log(
        `inbound: nulled ${String(inbound?.bodiesNulled ?? 0)} body(s), deleted ${String(inbound?.rowsDeleted ?? 0)} row(s); ` +
          `outbound: nulled ${String(outbound.bodiesNulled)} body(s) and ${String(outbound.responsesNulled)} response body(s), deleted ${String(outbound.sendsDeleted)} send(s), expired ${String(outbound.secretsExpired)} previous secret(s)`,
      );
      return;
    }
    const { claimed, due } = await this.redeliver();
    if (due > 0) {
      this.logger.log(`redelivered ${String(claimed)} of ${String(due)} due webhook send(s)`);
    }
  }

  /**
   * One redelivery pass. Public for a suite to drive; `orgIds` narrows the probe to those orgs, so
   * an end-to-end suite moving its clock by days does not claim other suites' sends.
   */
  async redeliver(orgIds?: readonly string[]): Promise<RedeliverResult> {
    const now = this.clock.now();
    const due = await this.sends.dueProbe(
      this.bypass,
      now,
      REDELIVER_BATCH,
      REDELIVER_PER_ORG,
      orgIds,
    );
    const byOrg = new Map<string, string[]>();
    for (const send of due) byOrg.set(send.orgId, [...(byOrg.get(send.orgId) ?? []), send.id]);

    let claimed = 0;
    for (const [orgId, sendIds] of byOrg) {
      try {
        claimed += await this.transactions.runInTenantTransaction(orgId, async (tx) => {
          const ids = await this.sends.claimDue(tx, orgId, sendIds, now);
          for (const sendId of ids) {
            await this.outbox.append(tx, {
              aggregateId: sendId,
              orgId,
              payload: { orgId, sendId },
              type: 'webhook.attempt-due',
            });
          }
          return ids.length;
        });
      } catch (error) {
        this.logger.warn(`redelivery skipped org ${orgId}: ${(error as Error).message}`);
      }
    }

    return { claimed, due: due.length };
  }

  /**
   * One retention pass. Public for a suite to drive; `orgIds` narrows the outbound half to those
   * orgs and skips the inbound half (a platform table no org scopes), so an end-to-end suite
   * moving its clock by weeks does not sweep other suites' rows.
   */
  async retain(orgIds?: readonly string[]): Promise<RetentionResult> {
    const now = this.clock.now();
    const inbound = orgIds === undefined ? await this.inbound.sweep(this.db, now) : null;
    const tenants = await this.db
      .select({ id: orgs.id })
      .from(orgs)
      .where(
        and(
          isNull(orgs.deletedAt),
          orgIds === undefined ? undefined : inArray(orgs.id, [...orgIds]),
        ),
      );
    const report = { bodiesNulled: 0, responsesNulled: 0, secretsExpired: 0, sendsDeleted: 0 };

    for (const { id: orgId } of tenants) {
      try {
        const swept = await this.transactions.runInTenantTransaction(orgId, async (tx) => ({
          ...(await this.sends.retain(tx, orgId, now)),
          secretsExpired: await this.endpoints.clearExpiredPrevious(tx, orgId, now),
        }));
        report.bodiesNulled += swept.bodiesNulled;
        report.secretsExpired += swept.secretsExpired;
        report.responsesNulled += swept.responsesNulled;
        report.sendsDeleted += swept.sendsDeleted;
      } catch (error) {
        this.logger.warn(`retention skipped org ${orgId}: ${(error as Error).message}`);
      }
    }

    return { inbound, outbound: report };
  }
}
