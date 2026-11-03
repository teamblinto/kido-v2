/**
 * Token under which consumers may be handed to the registry as a list. A symbol, for the reason
 * `redis.constants.ts` gives. Shipped code provides `[]` — modules register their consumers as
 * ordinary providers and the registry discovers them (spec 006 R6); the e2e suites override it.
 */
export const EVENT_CONSUMERS = Symbol('forge.outbox.consumers');

/**
 * The advisory lock the relay takes per batch (`pg_try_advisory_xact_lock`, research R3) so that
 * one process publishes at a time. Nothing else in the codebase takes an advisory lock; the next
 * thing that does must pick a different number, or it will serialise against the relay.
 */
export const OUTBOX_RELAY_LOCK = 7_301_005n;

/** Rows per relay transaction. A full batch runs the next tick immediately. */
export const RELAY_BATCH = 100;

/**
 * Retention on every queue add (research R8, FR-022). Seconds, as BullMQ counts them. The
 * completed set is not a record and the failed set is not the DLQ; both are bounded so the
 * `noeviction` queue store fills with work, not history. DLQ jobs carry no retention at all.
 */
export const JOB_RETENTION = {
  removeOnComplete: { age: 86_400, count: 1_000 },
  removeOnFail: { age: 604_800 },
} as const;
