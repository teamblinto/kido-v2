import { Inject, Injectable } from '@nestjs/common';
import { processedEvents } from '@repo/db';
import { UnrecoverableError } from 'bullmq';
import { and, eq } from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { APP_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase } from '../../database/database.types';
import { type EventConsumer, RetryableFailure } from './consumer';
import type { Envelope } from './envelope';
import type { EventType } from './events';

/** What the base reads off a BullMQ job. A `Pick`, so a spec can hand it a literal. */
export interface ConsumerJob<T extends EventType> {
  readonly attemptsMade: number;
  readonly data: Envelope<T>;
  log(row: string): Promise<number>;
}

/**
 * One job log line per failed attempt (data-model.md § Attempt record): the DLQ's attempt
 * history, since BullMQ keeps a stack trace per attempt but no timestamp. `reason` is the
 * `RetryableFailure`'s reason or the error's class name — never its message, which a handler may
 * have built from the payload.
 */
export interface AttemptRecord {
  readonly at: string;
  readonly attempt: number;
  readonly classification: 'retryable' | 'terminal';
  readonly reason: string;
}

/**
 * The processor every worker runs (research R11, FR-015/016): one transaction on the application
 * pool, the `(consumer, event_id)` insert first, `handle` only when that insert returned a row.
 *
 * The insert goes first rather than last so a redelivery of an event whose handler is still
 * running blocks on the row lock and then sees the conflict, instead of running the handler twice.
 * `ON CONFLICT DO NOTHING RETURNING` is the whole idempotency check; there is no prior `SELECT`
 * because two workers would both pass it. No tenant context is set — `processed_events` is a
 * platform table and many events have no org; a consumer reading tenant-owned rows sets its own.
 *
 * Classification (R5, FR-017) happens around `handle` alone, not around the transaction: a
 * failure to claim the row or to commit is the pool's condition, not the handler's verdict, and
 * wrapping it as terminal would dead-letter an event over a database blip. `UnrecoverableError`
 * is the one class `moveToFailed` refuses to retry, so wrapping is the whole mechanism.
 *
 * A consumer with `effect` (spec 006, research R5) runs a second shape: tx 1 — processed row
 * exists → done, else `handle` → commit; `effect(prepared)` holding no connection; tx 2 — insert
 * the processed row. A failed `effect` leaves `handle`'s writes (an orphan token row that expires)
 * and no record, so the retry runs `handle` again; a crash between `effect` and tx 2 redelivers
 * and repeats the effect, which at-least-once permits. The record comes last because a lost
 * mail under the hour's dedupe key is a user who cannot resend for up to an hour.
 */
@Injectable()
export class ConsumerBase {
  constructor(
    @Inject(APP_DATABASE) private readonly db: ForgeDatabase,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async processJob<T extends EventType, P>(
    consumer: EventConsumer<T, P>,
    job: ConsumerJob<T>,
  ): Promise<void> {
    if (consumer.effect !== undefined) {
      return this.processWithEffect(consumer, job);
    }

    await this.db.transaction(async (tx) => {
      const claimed = await tx
        .insert(processedEvents)
        .values({ consumer: consumer.name, eventId: job.data.eventId })
        .onConflictDoNothing()
        .returning({ eventId: processedEvents.eventId });

      if (claimed.length === 0) {
        return;
      }

      await this.classified(job, () => consumer.handle(job.data, tx));
    });
  }

  private async processWithEffect<T extends EventType, P>(
    consumer: EventConsumer<T, P>,
    job: ConsumerJob<T>,
  ): Promise<void> {
    const key = { consumer: consumer.name, eventId: job.data.eventId };
    const prepared = await this.db.transaction(async (tx) => {
      const done = await tx
        .select({ eventId: processedEvents.eventId })
        .from(processedEvents)
        .where(
          and(eq(processedEvents.consumer, key.consumer), eq(processedEvents.eventId, key.eventId)),
        );

      if (done.length > 0) {
        return SKIP;
      }

      return this.classified(job, () => consumer.handle(job.data, tx));
    });

    if (prepared === SKIP) {
      return;
    }

    await this.classified(job, () => consumer.effect!(job.data, prepared, job.attemptsMade + 1));
    await this.db.transaction(async (tx) => {
      await tx.insert(processedEvents).values(key).onConflictDoNothing();
    });
  }

  /** Runs `step`, logging one attempt record and wrapping a terminal error when it throws. */
  private async classified<R>(job: ConsumerJob<EventType>, step: () => Promise<R>): Promise<R> {
    try {
      return await step();
    } catch (error) {
      const retryable = error instanceof RetryableFailure;
      const record: AttemptRecord = {
        at: this.clock.now().toISOString(),
        attempt: job.attemptsMade + 1,
        classification: retryable ? 'retryable' : 'terminal',
        reason: retryable ? error.reason : nameOf(error),
      };

      await job.log(JSON.stringify(record));

      if (retryable) {
        throw error;
      }

      // BullMQ's constructor takes the message only; the cause is set by hand so the DLQ's
      // error chain still reaches the handler's own error.
      const terminal = new UnrecoverableError(
        error instanceof Error ? error.message : String(error),
      );
      terminal.cause = error;
      throw terminal;
    }
  }
}

/** What tx 1 returns when the event is already recorded — distinct from any `P` a handler returns. */
const SKIP: unique symbol = Symbol('outbox.consumer.skip');

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
