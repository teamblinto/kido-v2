/**
 * Spec 028's fixed numbers (plan.md § Constraints, research R6, R7, R10). One place, so the add,
 * the checker, the sweep and the removal path cannot disagree about a limit or an interval.
 */

/** The due-row sweep's queue (`events` profile): `maintenance.due` `domain.check` lists due rows (R7). */
export const DOMAIN_SWEEP_QUEUE = 'domain.sweep';

/** One job per due domain (`events` profile): claim, observe, settle (R7). */
export const DOMAIN_CHECK_QUEUE = 'domain.check';

/** FR-004: live domains (every state but `failed` and `removed`) per project and per org. */
export const DOMAINS_PER_PROJECT = 10;
export const DOMAINS_PER_ORG = 50;

/** The verification window a `pending` domain has before it ends `verification-timeout` (R6). */
export const WINDOW_MS = 72 * 60 * 60 * 1000;

/** Consecutive conclusive failed checks of an `active` domain before it is `drifted` (R6). */
export const DRIFT_THRESHOLD = 3;

/** A `drifted` domain is released this long after `drifted_at` (FR-022). */
export const RELEASE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** The release warning mail goes this long after `drifted_at`, a week before the release. */
export const RELEASE_WARNING_MS = 23 * 24 * 60 * 60 * 1000;

/** FR-012: a member may ask for a check at most once per this interval per domain. */
export const CHECK_NOW_MIN_INTERVAL_MS = 60 * 1000;

/** The claim's row lease: a claimed row's `next_check_at` moves this far ahead (R7). */
export const CLAIM_LEASE_MS = 10 * 60 * 1000;

/** Due rows listed per sweep tick, and checks run at once from one tick (R7). */
export const SWEEP_BATCH = 200;
export const CHECK_CONCURRENCY = 8;

/** The ownership TXT record's owner is this label prefixed to the hostname (R8). */
export const CHALLENGE_PREFIX = '_forge-challenge.';
