import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { outbox } from '@repo/db';
import { asc, inArray, isNull, sql } from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import type { Environment } from '../../config/environment';
import { APP_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase } from '../../database/database.types';
import type { Envelope } from './envelope';
import type { EventPayload, EventType } from './events';
import { OUTBOX_RELAY_LOCK, RELAY_BATCH } from './outbox.constants';

/** What the relay hands each row to. `OutboxModule` supplies the queue registry's `publish`. */
export type Publish = (envelope: Envelope) => Promise<void>;

/**
 * Moves committed outbox rows to the queues (§10, research R3).
 *
 * Every tick is one short transaction on the application pool: take the advisory lock or give
 * the tick up, read the oldest unpublished rows, `publish` each in `seq` order, mark them, commit.
 * The lock is transaction-scoped rather than session-scoped because PgBouncer runs in transaction
 * mode in front of this database and hands the connection — and with it a session lock — to
 * whoever transacts next; a lock that dies with the transaction is the one that survives pooling.
 * The price is that leadership is decided per batch, not per process, which is what makes
 * failover the next tick on any other process (FR-012) with no lease and no heartbeat.
 *
 * Marking happens after `publish` accepted every row of the batch (FR-010). A crash between the
 * two publishes the batch again on the next tick, and the event id as job id makes that a no-op.
 *
 * Nothing here touches a tenant: no `set_config`, no policy — the tables are platform tables by
 * decision (spec FR-003a). And nothing here is on the request path: the relay depends on
 * `APP_DATABASE` and the clock, the writer on the clock alone, so a queue store that is down is a
 * `warn` line per tick and rows that wait (FR-014).
 */
@Injectable()
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name);
  private inFlight: Promise<void> = Promise.resolve();
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  /**
   * How long the loop waits when the last batch was not full (FR-012). Configuration rather than
   * a constant since spec 006 (research R8): production keeps the second SC-002 was measured at,
   * and the suites set 50 ms so a test that reads a mail waits on the outcome, not on a timer.
   */
  private readonly tickMs: number;

  constructor(
    @Inject(APP_DATABASE) private readonly db: ForgeDatabase,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(ConfigService) config: ConfigService<Environment, true>,
  ) {
    this.tickMs = config.get('OUTBOX_RELAY_TICK_MS', { infer: true });
  }

  /**
   * Begins the loop. The first tick waits one interval rather than running now, so a process that
   * boots before its migrations (US6 brings the stack up on an empty database) does not open with
   * a warning, and so that two processes starting together do not both fire at t=0.
   */
  start(publish: Publish): void {
    this.running = true;
    this.schedule(publish, this.tickMs);
  }

  /** Resolves once the in-flight tick, if any, has committed or rolled back. No further tick runs. */
  async stop(): Promise<void> {
    this.running = false;
    clearTimeout(this.timer);
    await this.inFlight;
  }

  /**
   * One batch. Public so a test can drive it without the timer; returns how many rows were
   * published — `RELAY_BATCH` means "there may be more", and the loop runs again at once.
   *
   * Rejects on any failure and leaves the transaction rolled back: a row that could not be
   * published is not marked, whichever row of the batch failed, because the mark is one `UPDATE`
   * for the batch and it comes last.
   */
  async tick(publish: Publish): Promise<number> {
    return this.db.transaction(async (tx) => {
      const { rows: lock } = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(${OUTBOX_RELAY_LOCK}) as locked`,
      );

      if (lock[0]?.locked !== true) {
        return 0;
      }

      const rows = await tx
        .select()
        .from(outbox)
        .where(isNull(outbox.publishedAt))
        .orderBy(asc(outbox.seq))
        .limit(RELAY_BATCH);

      // In order, one at a time: per-aggregate order is the guarantee, and the queue's insertion
      // order is the only thing carrying it.
      for (const row of rows) {
        await publish({
          aggregate: row.aggregate,
          aggregateId: row.aggregateId,
          eventId: row.id,
          occurredAt: row.occurredAt.toISOString(),
          orgId: row.originOrgId,
          payload: row.payload as EventPayload<EventType>,
          traceId: row.traceId,
          type: row.type as EventType,
        });
      }

      if (rows.length > 0) {
        await tx
          .update(outbox)
          .set({ publishedAt: this.clock.now() })
          .where(
            inArray(
              outbox.id,
              rows.map((row) => row.id),
            ),
          );
      }

      return rows.length;
    });
  }

  private schedule(publish: Publish, delayMs: number): void {
    this.timer = setTimeout(() => {
      this.inFlight = this.run(publish);
    }, delayMs);
  }

  /**
   * A failed tick is a warning and a retry at the next interval, never a crash: before the outbox
   * migration has run the table is missing (42P01), and with the queue store down `publish`
   * rejects — both are conditions that end without the process restarting.
   */
  private async run(publish: Publish): Promise<void> {
    let published = 0;

    try {
      published = await this.tick(publish);
    } catch (error) {
      this.logger.warn(
        `relay tick failed, retrying next tick: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (this.running) {
      this.schedule(publish, published === RELAY_BATCH ? 0 : this.tickMs);
    }
  }
}
