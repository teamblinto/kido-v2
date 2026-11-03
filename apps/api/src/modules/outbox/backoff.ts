import type { BackoffStrategy } from 'bullmq';

/** Two seconds: the first retry lands within it (FR-018). */
const BASE_MS = 2_000;

/** Fifteen minutes: reached from attempt 10 on and never exceeded (FR-018). */
const CAP_MS = 900_000;

/**
 * The BullMQ backoff strategy behind `backoff: { type: 'full-jitter' }` (research R5):
 * `U[0, min(cap, base · 2^(attemptsMade − 1))]`, AWS's "full jitter" — the variant whose retries
 * from a burst of failures spread evenly across the window instead of returning as the same burst.
 *
 * BullMQ's built-in `exponential` with `jitter: 1` is the same distribution but has no cap: at
 * attempt 20 it would wait twelve days. The cap is the requirement, so the strategy is ours; it
 * ignores the type, the error and the job the runtime also passes because only the count matters.
 * `attemptsMade` is 1-based — the attempt that just failed.
 */
export function fullJitter(attemptsMade: number): number {
  return Math.floor(Math.random() * Math.min(CAP_MS, BASE_MS * 2 ** (attemptsMade - 1)));
}

// A plain function rather than a `BackoffStrategy`-typed const, so a caller gets `number` back
// instead of `number | Promise<number>`; this line is what keeps it assignable to the Worker's
// `settings.backoffStrategy`.
fullJitter satisfies BackoffStrategy;
