/** Queues (spec 029). */
export const WEBHOOK_FANOUT_QUEUE = 'webhook.fanout';
export const INTEGRATION_OUT_QUEUE = 'integration.out';
export const WEBHOOK_NOTICE_QUEUE = 'webhook.notice';

export const WEBHOOK_ENDPOINTS_PER_ORG = 20;
export const ATTEMPT_TIMEOUT_MS = 10_000;
export const RESPONSE_READ_LIMIT = 65_536;
export const RESPONSE_KEEP_BYTES = 4_096;
export const CLAIM_LEASE_MS = 30_000;
export const IN_FLIGHT_PER_ORG = 8;
/**
 * How many of an org's due sends may have a `webhook.attempt-due` waiting at once (research R9):
 * past it, fan-out appends none and each finished attempt dispatches the next, so one org's burst
 * cannot fill the outbox and the lane ahead of every other org (SC-006).
 */
export const DISPATCH_PER_ORG = 32;
export const REDELIVER_BATCH = 500;
export const REDELIVER_PER_ORG = 50;
/** The delivery log's page (research R11). */
export const DELIVERY_PAGE_SIZE = 50;
/**
 * Retention (Appendix A, ADR 051), for the inbound `webhook_deliveries` and the outbound log alike:
 * a body is dropped at 7 days, and the record outlives it until 30.
 */
export const BODY_RETENTION_DAYS = 7;
export const ROW_RETENTION_DAYS = 30;
/** How long a rotated-out signing secret keeps signing alongside the new one: 24 hours. */
export const ROTATION_OVERLAP_MS = 86_400_000;
export const SECRET_PURPOSE = 'webhook:signing-secret';
/** `maintenance.due`'s webhook arms, on their own `events` queue (one consumer per type per queue). */
export const WEBHOOK_SWEEP_QUEUE = 'webhook.sweep';
