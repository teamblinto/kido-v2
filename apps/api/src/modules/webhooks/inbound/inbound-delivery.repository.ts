import { Injectable } from '@nestjs/common';
import { schema } from '@repo/db';
import { and, eq, gt, isNotNull, lt } from 'drizzle-orm';

import type { ForgeDatabase, TenantTransaction } from '../../../database/database.types';
import { BODY_RETENTION_DAYS, ROW_RETENTION_DAYS } from '../webhooks.constants';

/** What the request knows about a delivery before anything has processed it. */
export interface NewDelivery {
  readonly body: Record<string, unknown>;
  readonly deliveryId: string;
  readonly eventType: string;
  readonly installationId: number | null;
  readonly receivedAt: Date;
}

/** The classified categories `failure` may hold. Never a message, never a provider body (§ 05). */
export type DeliveryFailure = 'in-flight' | 'processing-failed';

/** What the consumer reads of a delivery; the row minus the columns nothing downstream uses. */
export interface WebhookDeliveryRow {
  readonly attempts: number;
  readonly body: Record<string, unknown> | null;
  readonly eventType: string;
  readonly id: string;
  readonly installationId: number | null;
  readonly state: 'failed' | 'ignored' | 'processed' | 'received';
}

export interface RetentionSweepReport {
  readonly bodiesNulled: number;
  readonly rowsDeleted: number;
}

/**
 * `webhook_deliveries` (spec 026 data-model § 1).
 *
 * A **platform** table: no `org_id`, no RLS, and therefore statements that name no tenant. The
 * delivery arrives before any organisation is known, and resolving one would mean doing the lookup
 * inside the request — which is the processing § 12 forbids there. Every *effect* of a delivery
 * happens later, inside a per-organisation tenant transaction.
 */
@Injectable()
export class WebhookDeliveryRepository {
  /**
   * The insert the whole pipeline turns on (R11, FR-027).
   *
   * `ON CONFLICT (provider, delivery_id) DO NOTHING`, and the answer is whether a row was written.
   * Zero rows means this delivery id has been seen: the provider is retrying, which it is entitled
   * to do, and the right response is to acknowledge without enqueuing a second time. The
   * deduplication is the unique index, not a prior `SELECT` — two concurrent copies of one delivery
   * are a real thing, and a check-then-insert would admit both.
   *
   * Runs on the caller's transaction so that "written down" and "enqueued" commit together.
   */
  async insertIfNew(tx: TenantTransaction, delivery: NewDelivery): Promise<string | undefined> {
    const [row] = await tx
      .insert(schema.webhookDeliveries)
      .values({
        body: delivery.body,
        deliveryId: delivery.deliveryId,
        eventType: delivery.eventType,
        installationId: delivery.installationId,
        provider: 'github',
        receivedAt: delivery.receivedAt,
        state: 'received',
      })
      .onConflictDoNothing({
        target: [schema.webhookDeliveries.provider, schema.webhookDeliveries.deliveryId],
      })
      .returning({ id: schema.webhookDeliveries.id });

    return row?.id;
  }

  /**
   * The delivery the consumer is about to act on: the id, what arrived, and the body it reads
   * three fields of. No tenant — this is the platform table, and the row is what the consumer
   * retries *from* (FR-029): nothing in the queue's payload is needed beyond the id.
   *
   * A row whose `body` the retention sweep already nulled reads with `body` null; the consumer
   * settles such a delivery rather than inventing a payload for it.
   */
  async byId(db: ForgeDatabase, id: string): Promise<WebhookDeliveryRow | undefined> {
    const [row] = await db
      .select({
        attempts: schema.webhookDeliveries.attempts,
        body: schema.webhookDeliveries.body,
        eventType: schema.webhookDeliveries.eventType,
        id: schema.webhookDeliveries.id,
        installationId: schema.webhookDeliveries.installationId,
        state: schema.webhookDeliveries.state,
      })
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.id, id));

    return row;
  }

  /**
   * The delivery's terminal state, and the attempt that reached it (FR-029).
   *
   * `attempts` is recorded on every pass, including the ones that defer and the ones that fail, so
   * a parked row says how many tries it cost as well as that it was parked. `failure` is a
   * classified category — `in-flight`, `processing-failed` — and never a provider body or a
   * message: § 05 and FR-031 both forbid the second kind of string in this column.
   */
  async settle(
    db: ForgeDatabase,
    id: string,
    state: 'failed' | 'ignored' | 'processed' | 'received',
    attempt: number,
    failure: DeliveryFailure | null = null,
  ): Promise<void> {
    await db
      .update(schema.webhookDeliveries)
      .set({ attempts: attempt, failure, state })
      .where(eq(schema.webhookDeliveries.id, id));
  }

  /**
   * The retention arm of the `maintenance.due` tick (R15).
   *
   * Two statements, in this order and for a reason: the body is the part with a provider's payload
   * in it, so it goes first and goes early; the row — a delivery id, an event name and a state — is
   * kept three weeks longer, because that is what answers "did we ever receive it?" when somebody
   * asks in a fortnight. Both predicates ride the `received_at` index.
   *
   * Not partitioned: Appendix A specifies monthly partitions, and ADR 051 (accepted) records the
   * deviation and the trigger for revisiting it. `WebhooksMaintenanceConsumer` runs this daily.
   */
  async sweep(db: ForgeDatabase, now: Date): Promise<RetentionSweepReport> {
    const bodies = await db
      .update(schema.webhookDeliveries)
      .set({ body: null })
      .where(
        and(
          lt(schema.webhookDeliveries.receivedAt, daysBefore(now, BODY_RETENTION_DAYS)),
          // Without this every sweep rewrites every already-nulled row for nothing.
          isNotNull(schema.webhookDeliveries.body),
        ),
      )
      .returning({ id: schema.webhookDeliveries.id });

    const rows = await db
      .delete(schema.webhookDeliveries)
      .where(lt(schema.webhookDeliveries.receivedAt, daysBefore(now, ROW_RETENTION_DAYS)))
      .returning({ id: schema.webhookDeliveries.id });

    return { bodiesNulled: bodies.length, rowsDeleted: rows.length };
  }

  /** The parked deliveries (FR-029), off the partial index. Public so an operator view can read it. */
  async failedSince(db: ForgeDatabase, since: Date): Promise<string[]> {
    const rows = await db
      .select({ id: schema.webhookDeliveries.id })
      .from(schema.webhookDeliveries)
      .where(
        and(
          eq(schema.webhookDeliveries.state, 'failed'),
          gt(schema.webhookDeliveries.receivedAt, since),
        ),
      );

    return rows.map((row) => row.id);
  }
}

function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 86_400_000);
}
