/**
 * The retry schedule (spec 029 research R7). Eight attempts; the gaps after attempts 1 to 7 are
 * nominally 1 m, 5 m, 30 m, 2 h, 5 h, 8 h and 8 h, each scaled by a uniform factor in [0.8, 1.2]
 * so a burst de-synchronises while the span stays near 24 h. A longer `Retry-After` replaces the
 * gap. Every attempt is clamped to 24 h after the first, and a clamp at or before `now` means the
 * schedule is exhausted.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const MAX_ATTEMPTS = 8;
export const RETRY_WINDOW_MS = 24 * HOUR;
export const RETRY_GAPS_MS: readonly number[] = [
  MINUTE,
  5 * MINUTE,
  30 * MINUTE,
  2 * HOUR,
  5 * HOUR,
  8 * HOUR,
  8 * HOUR,
];

export interface ScheduleInput {
  /** The number of the scheduled attempt that just failed, from 1. */
  readonly attempt: number;
  readonly firstAttemptAt: Date;
  readonly now: Date;
  readonly retryAfterMs: number | null;
  /** Uniform in [0, 1]; injected so tests can pin the jitter. */
  readonly random?: () => number;
}

/** When the next attempt is due, or null when the schedule is exhausted. */
export function nextAttemptAt({
  attempt,
  firstAttemptAt,
  now,
  random = Math.random,
  retryAfterMs,
}: ScheduleInput): Date | null {
  if (attempt < 1 || attempt >= MAX_ATTEMPTS) return null;

  const jittered = Math.round(RETRY_GAPS_MS[attempt - 1]! * (0.8 + 0.4 * random()));
  const gap = retryAfterMs !== null && retryAfterMs > jittered ? retryAfterMs : jittered;
  const at = Math.min(now.getTime() + gap, firstAttemptAt.getTime() + RETRY_WINDOW_MS);

  return at <= now.getTime() ? null : new Date(at);
}
