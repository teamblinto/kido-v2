import { Inject, Injectable, Logger } from '@nestjs/common';
import { orgs, sandboxes } from '@repo/db';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { APP_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { OutboxWriter } from '../outbox/outbox-writer';
import { SANDBOX_TIMINGS, type SandboxTimings } from './sandbox.constants';

export interface SweepReport {
  /** `hibernated` rows past `archiveAfterMs`, left as they are (FR-013). */
  readonly archiveRefused: number;
  /** `idle` rows marked `hibernating` this pass, one `hibernate` op each. */
  readonly hibernating: number;
  /** `active` rows marked `idle` this pass. */
  readonly idled: number;
}

/**
 * The `sandbox.sweep` maintenance job (spec 014 research R8, FR-003): per live organisation, in
 * its own tenant transaction, `active → idle` where `last_seen_at` is older than `idleAfterMs`
 * and `idle → hibernating` (+ the op) where `state_entered_at` is older than `hibernateAfterMs`.
 * Nothing but `sandboxes` is read: a run in flight touches its row on every heartbeat, so a
 * project with a live run is never idled and the sweep needs no knowledge of runs (FR-005).
 * Hibernated rows past `archiveAfterMs` are counted and the refusal logged — archive needs a
 * durable copy that does not exist until 016 (FR-013). Rows mid-transition or lost are skipped.
 *
 * ponytail: one tenant transaction per org, the reaper's loop; a platform-level read is the
 * upgrade if the tenant count makes the pass slow.
 */
@Injectable()
export class SandboxSweep {
  private readonly logger = new Logger(SandboxSweep.name);

  constructor(
    @Inject(APP_DATABASE) private readonly db: ForgeDatabase,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(SANDBOX_TIMINGS) private readonly timings: SandboxTimings,
  ) {}

  async sweep(): Promise<SweepReport> {
    const now = this.clock.now();
    const before = (ms: number) => new Date(now.getTime() - ms);
    const settled = and(isNull(sandboxes.transition), isNull(sandboxes.lostAt));
    const report = { archiveRefused: 0, hibernating: 0, idled: 0 };
    const tenants = await this.db.select({ id: orgs.id }).from(orgs).where(isNull(orgs.deletedAt));

    for (const { id: orgId } of tenants) {
      await this.transactions.runInTenantTransaction(orgId, async (tx) => {
        const idled = await tx
          .update(sandboxes)
          .set({ state: 'idle', stateEnteredAt: now })
          .where(
            and(
              eq(sandboxes.orgId, orgId),
              eq(sandboxes.state, 'active'),
              settled,
              lt(sandboxes.lastSeenAt, before(this.timings.idleAfterMs)),
            ),
          )
          .returning({ id: sandboxes.id });
        report.idled += idled.length;

        const hibernating = await tx
          .update(sandboxes)
          .set({ transition: 'hibernating', transitionSince: now })
          .where(
            and(
              eq(sandboxes.orgId, orgId),
              eq(sandboxes.state, 'idle'),
              settled,
              lt(sandboxes.stateEnteredAt, before(this.timings.hibernateAfterMs)),
            ),
          )
          .returning({ id: sandboxes.id });
        for (const { id } of hibernating) {
          await this.outbox.append(tx, {
            aggregateId: id,
            orgId,
            payload: { op: 'hibernate', orgId, sandboxId: id, since: now.toISOString() },
            type: 'sandbox.op.requested',
          });
        }
        report.hibernating += hibernating.length;

        const [stale] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(sandboxes)
          .where(
            and(
              eq(sandboxes.orgId, orgId),
              eq(sandboxes.state, 'hibernated'),
              lt(sandboxes.hibernatedAt, before(this.timings.archiveAfterMs)),
            ),
          );
        if (stale !== undefined && stale.count > 0) {
          this.logger.warn(
            `archive refused: no durable copy (spec 014 FR-013) org=${orgId} hibernated=${String(stale.count)}`,
          );
          report.archiveRefused += stale.count;
        }
      });
    }

    return report;
  }
}
