import type { LoggerService } from '@nestjs/common';
import { type Job, type Queue, UnrecoverableError, type Worker } from 'bullmq';

import type { ClockPort } from '../../common/clock/clock.port';
import type { AttemptRecord } from './consumer-base';
import type { Envelope } from './envelope';
import type { EventType } from './events';

/** What `moveStalledJobsToWait` writes as the deferred failure once `stc > maxStalledCount`. */
export const STALL_LIMIT_REASON = 'job stalled more than allowable limit';

/** A job on `<queue>.dlq` (data-model.md § Dead letter). Never auto-removed; no worker reads it. */
export interface DeadLetter {
  readonly attempts: readonly AttemptRecord[];
  readonly deadLetteredAt: string;
  readonly errors: readonly string[];
  readonly failedReason: string;
  readonly jobId: string;
  readonly payload: Envelope;
  readonly poison: boolean;
  readonly sourceQueue: string;
  readonly traceId: string | null;
}

export type DeadLetterQueue = Queue<DeadLetter, void, 'dead-letter'>;

/**
 * The `failed` listener that is the whole dead-letter mechanism (research R7, FR-019/020).
 *
 * BullMQ's `failed` event fires for every failed attempt, retrying or not, so the listener
 * decides finality the way `moveToFailed` did: an `UnrecoverableError` (by instance or by name —
 * a duplicate `bullmq` copy would break `instanceof`) or a count that reached the budget. Poison
 * arrives on the same path: the stall script's deferred failure is raised as an
 * `UnrecoverableError` with a known message on the next pickup, before the processor runs.
 *
 * The add is not awaited by the listener — an emitter listener returns void — so a refused add
 * is logged at `error` with the job id rather than lost silently. The failed job is still in the
 * source queue's failed set under `removeOnFail`, which is why this is a log line and not a
 * retry: nothing is gone, and a reconciler is 006+'s call if the line is ever seen.
 *
 * Once the letter is written the source job is removed (spec 006, research R3): the job id is
 * the mail lane's dedupe key, and a job left in the failed set would pin it for 7 d, so a
 * same-hour re-request after the cause was fixed would be silently dropped. The letter carries
 * everything the failed set did. A failed remove is a `warn` — the job ages out under
 * `removeOnFail` as before — and never an error, because the letter, the record, exists.
 */
export function attachDeadLetter(
  worker: Worker<Envelope, void, EventType>,
  queue: Queue<Envelope, void, EventType>,
  dlq: DeadLetterQueue,
  clock: ClockPort,
  logger: Pick<LoggerService, 'error' | 'warn'>,
): void {
  worker.on('failed', (job, error) => {
    if (job?.id === undefined || !isFinal(job, error)) {
      return;
    }

    const jobId = job.id;

    void deadLetter(job, jobId, queue, clock)
      .then((letter) => dlq.add('dead-letter', letter, { jobId }))
      .then(() =>
        job.remove().catch((cause: unknown) => {
          logger.warn(
            `dead-lettered job ${jobId} could not be removed from ${queue.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }),
      )
      .catch((cause: unknown) => {
        logger.error(
          `dead-letter of job ${jobId} on ${queue.name} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      });
  });
}

function isFinal(job: Job<Envelope, void, EventType>, error: Error): boolean {
  return (
    error instanceof UnrecoverableError ||
    error.name === 'UnrecoverableError' ||
    job.attemptsMade >= (job.opts.attempts ?? 1)
  );
}

async function deadLetter(
  job: Job<Envelope, void, EventType>,
  jobId: string,
  queue: Queue<Envelope, void, EventType>,
  clock: ClockPort,
): Promise<DeadLetter> {
  const { logs } = await queue.getJobLogs(jobId);

  return {
    attempts: logs.map((row) => JSON.parse(row) as AttemptRecord),
    deadLetteredAt: clock.now().toISOString(),
    errors: job.stacktrace ?? [],
    failedReason: job.failedReason,
    jobId,
    payload: job.data,
    poison: job.failedReason === STALL_LIMIT_REASON,
    sourceQueue: queue.name,
    traceId: job.data.traceId,
  };
}
