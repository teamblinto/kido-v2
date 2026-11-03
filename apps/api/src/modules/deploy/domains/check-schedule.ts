import type { Domain } from '@repo/db';

/**
 * When a domain is next due for a check (spec 028 research R7). Pure: the checker's settle step
 * writes the answer to `next_check_at`, and the sweep's bypass probe finds the row again when it
 * is due. Every time is the injected clock's `now`, never the database's.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** An inconclusive check changes nothing and is tried again this soon (R6, FR-021). */
const INCONCLUSIVE_RETRY_MS = 5 * MINUTE_MS;

/**
 * `pending`, by the age of the window: the first entry whose bound the age is under wins, and the
 * last applies after. FR-008: at least every 5 minutes in the first hour, at least hourly after.
 */
const PENDING_CADENCE: readonly { readonly under: number; readonly every: number }[] = [
  { every: MINUTE_MS, under: 10 * MINUTE_MS },
  { every: 5 * MINUTE_MS, under: HOUR_MS },
  { every: 15 * MINUTE_MS, under: 24 * HOUR_MS },
];
const PENDING_LATE_EVERY_MS = HOUR_MS;

/**
 * `active`: daily after a pass (FR-020), hourly after a failure, so the third consecutive failure
 * (`drifted`) comes about 2 hours after the first rather than 3 days later.
 */
const ACTIVE_PASSED_EVERY_MS = 24 * HOUR_MS;
const ACTIVE_FAILED_EVERY_MS = HOUR_MS;

/** `drifted`: hourly, pass or fail, so a recovery is noticed quickly (US3 scenario 3). */
const DRIFTED_EVERY_MS = HOUR_MS;

/**
 * `removing`: the next deregistration attempt is as far away as the removal is old, between these
 * bounds. Attempts therefore fall 1, 2, 4, 8, 16 minutes after the request, doubling with no
 * counter to keep, then every 30 minutes (R7, R10).
 */
const REMOVING_FIRST_MS = MINUTE_MS;
const REMOVING_CAP_MS = 30 * MINUTE_MS;

/**
 * How the check just made came out. `inconclusive` is a check that met an unavailable resolver or
 * a retryable edge answer (R6).
 */
export type CheckResult = 'failed' | 'inconclusive' | 'passed';

/** The columns the schedule reads. */
export type ScheduledDomain = Pick<Domain, 'removalRequestedAt' | 'state' | 'windowStartedAt'>;

/** When `domain` is next due, after a check at `now` that came out `result`. */
export function nextCheckAt(domain: ScheduledDomain, result: CheckResult, now: Date): Date {
  return new Date(now.getTime() + intervalMs(domain, result, now));
}

function intervalMs(domain: ScheduledDomain, result: CheckResult, now: Date): number {
  switch (domain.state) {
    case 'pending': {
      if (result === 'inconclusive') return INCONCLUSIVE_RETRY_MS;
      const age = now.getTime() - domain.windowStartedAt.getTime();
      return PENDING_CADENCE.find((step) => age < step.under)?.every ?? PENDING_LATE_EVERY_MS;
    }
    case 'active':
      if (result === 'inconclusive') return INCONCLUSIVE_RETRY_MS;
      return result === 'passed' ? ACTIVE_PASSED_EVERY_MS : ACTIVE_FAILED_EVERY_MS;
    case 'drifted':
      return result === 'inconclusive' ? INCONCLUSIVE_RETRY_MS : DRIFTED_EVERY_MS;
    case 'removing': {
      // Whatever the attempt came to: a settled removal is never checked again.
      const age = now.getTime() - (domain.removalRequestedAt ?? now).getTime();
      return Math.min(Math.max(age, REMOVING_FIRST_MS), REMOVING_CAP_MS);
    }
    case 'failed':
    case 'removed':
      throw new Error(`nextCheckAt: a ${domain.state} domain is never checked`);
  }
}
