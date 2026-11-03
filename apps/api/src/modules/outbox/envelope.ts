import type { EventPayload, EventType } from './events';

/**
 * What a job carries: an outbox row, as the relay publishes it (data-model.md § Envelope).
 *
 * `eventId` is the job id on every queue the event reaches, which is what makes a republish after
 * a relay crash a no-op (R4); `type` is the job name. `seq` is deliberately absent — it orders the
 * relay's read and is never exposed. Timestamps travel as ISO 8601 strings because the envelope is
 * JSON in Redis and a `Date` would not survive the trip.
 */
export interface Envelope<T extends EventType = EventType> {
  readonly aggregate: string;
  readonly aggregateId: string;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly orgId: string | null;
  readonly payload: EventPayload<T>;
  readonly traceId: string | null;
  readonly type: T;
}
