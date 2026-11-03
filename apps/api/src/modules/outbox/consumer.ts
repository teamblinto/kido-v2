import type { WorkerProfile } from '../../config/run-profiles';
import type { TenantTransaction } from '../../database/database.types';
import type { Envelope } from './envelope';
import type { EventType } from './events';

/**
 * What a module implements to act on events (data-model.md § Consumer, FR-015..017).
 *
 * An abstract class rather than an interface so `concurrency` can carry its default of 1 — the
 * value that keeps the relay's per-queue insertion order. Raising it is the consumer's explicit
 * forfeit of that order, made in its own file where a reviewer sees it. `attempts` is the whole
 * budget including the first try (FR-019); it lives on the consumer, not the queue, because the
 * consumer is what knows how patient its upstream deserves.
 *
 * `handle` receives the transaction the base opened after inserting the processed row, so the
 * consumer's writes commit with that row or not at all (FR-016). No tenant context is set on it:
 * the envelope carries `orgId` and a consumer reading tenant-owned rows sets its own.
 *
 * A consumer with an external side effect (spec 006, research R5) defines `effect`: then `handle`
 * is database work only, committed on its own, and `effect` runs with no connection held, before
 * the processed row is written — a lost mail is worse than a repeated one. `P` is what `handle`
 * prepares for `effect`; `void` for the consumers that have none.
 *
 * `maxStalledCount` is how many times BullMQ may recover a job whose worker stopped renewing its
 * lock before moving it to failed (spec 008 research R6). Left undefined, the worker keeps
 * BullMQ's default of 1; a consumer whose job is resumable from durable state can afford more.
 */
export abstract class EventConsumer<T extends EventType = EventType, P = void> {
  abstract readonly attempts: number;
  readonly concurrency: number = 1;
  readonly maxStalledCount?: number;
  abstract readonly name: string;
  /** Which worker profile drains this consumer's queue (spec 013 R3). Defaults to the light lane. */
  readonly profile: WorkerProfile = 'events';
  abstract readonly queue: string;
  abstract readonly types: readonly T[];

  /** Database work only, on the base's transaction. Returns what `effect` needs. */
  abstract handle(event: Envelope<T>, tx: TenantTransaction): Promise<P>;

  /**
   * The external side effect, after `handle` committed and with no transaction held. `attempt`
   * is 1-based (the base passes it): a consumer that must settle a record when the budget is
   * spent compares it with `attempts`.
   */
  effect?(event: Envelope<T>, prepared: P, attempt?: number): Promise<void>;

  /**
   * Override to replace the event id as the job id; the mail lane dedupes with it (spec 006
   * research R3). The default, the event id, makes a republish a no-op and nothing more.
   */
  jobId?(event: Envelope<T>): string;
}

export type RetryableReason = 'throttled' | 'timeout' | 'upstream-5xx';

/**
 * The one class of failure the base retries (research R5). Everything else a handler throws is
 * terminal and goes straight to the DLQ, so a consumer that wants a retry must say so by name —
 * an unclassified `Error` being terminal is the default path, not a special case (US3 scenario
 * 6). The `reason` is what the attempt record logs; the payload never is.
 */
export class RetryableFailure extends Error {
  readonly reason: RetryableReason;

  constructor(reason: RetryableReason, cause?: unknown) {
    super(`Retryable failure: ${reason}`, { cause });
    this.name = 'RetryableFailure';
    this.reason = reason;
  }
}

/**
 * Where every HTTP-speaking consumer draws the line. 429 and 5xx are the upstream's condition
 * for a while; a 4xx other than 429 is our request, and repeating it would only repeat the answer.
 */
export function classifyHttpStatus(status: number): 'retryable' | 'terminal' {
  return status === 429 || status >= 500 ? 'retryable' : 'terminal';
}

/**
 * What `classifyMailFailure` reads of a `MailFailure`: the flag, the reason and the transport
 * status. Structural rather than the port's type so `outbox` gains no import of `mail` (spec 006
 * SC-010, research R7) — the graph stays `identity → outbox`, never the reverse.
 */
export interface MailFailureLike {
  readonly reason: string;
  readonly retryable: boolean;
  readonly status: number | undefined;
}

/** A refusal the transport will repeat: terminal, so the base dead-letters it on this attempt. */
export class MailNotDeliveredError extends Error {
  constructor(readonly reason: string) {
    super(`Mail not delivered: ${reason}`);
    this.name = 'MailNotDeliveredError';
  }
}

/**
 * The one classification a mail consumer's `effect` applies (spec 006 SC-010). `retryable` is
 * decided once, in `mailFailed`; this function only names the retry's reason for the attempt
 * record — a throttle is a throttle, and an outage is a timeout when nothing answered or an
 * upstream 5xx when something did. No table of reasons lives here: a reason the port adds is
 * classified by its flag without a change to either consumer.
 */
export function classifyMailFailure(failure: MailFailureLike): never {
  if (!failure.retryable) {
    throw new MailNotDeliveredError(failure.reason);
  }

  if (failure.reason === 'throttled') {
    throw new RetryableFailure('throttled');
  }

  throw new RetryableFailure(failure.status === undefined ? 'timeout' : 'upstream-5xx');
}
