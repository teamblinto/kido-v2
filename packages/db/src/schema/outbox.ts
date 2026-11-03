import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The transactional outbox (§10, spec 005). A **platform** table, not a tenant-owned one — no
 * `unique (org_id, id)`, no policy, and deliberately no column named `org_id` (spec FR-003a).
 *
 * The relay must read every tenant's rows, so a tenant policy on this table would only ever be
 * bypassed, and an always-bypassed policy is a hole with extra steps. Account-scope events — a
 * signup, a password reset — belong to no organisation, which rules out a `not null` org column and
 * makes a nullable `org_id` the pattern `audit.ts` already rejected. So the originating
 * organisation, where the aggregate has one, is `origin_org_id`: provenance copied into the event
 * envelope for the consumer to open its own tenant transaction with, never a key the relay filters
 * on, never a policy reads, and not the column name `rls.spec.ts` and `schema.spec.ts` treat as
 * "tenant-owned" — those gates stay list-free and this table stays outside them by construction.
 *
 * Grants live in `migrations/0009_outbox_grants.sql`: `forge_app` may `SELECT`, `INSERT` and
 * `UPDATE` (the published mark and nothing else); nothing but the owner may `DELETE`, because
 * retention is a policy decision (roadmap 014), not a side effect.
 */
export const outbox = pgTable(
  'outbox',
  {
    aggregate: text('aggregate').notNull(),
    /** Text, not uuid: a non-uuid aggregate later needs no migration. */
    aggregateId: text('aggregate_id').notNull(),
    /** Database clock — when the row was written. `occurred_at` is the event's own time. */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Becomes the BullMQ job id on every queue it is published to. */
    id: uuid('id').primaryKey().defaultRandom(),
    /** From the injected `ClockPort`, set by the writer. Never `now()`. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /** No foreign key: `orgs` is soft-deleted and an event outlives what it names. */
    originOrgId: uuid('origin_org_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /** Set once by the relay after every target queue accepted the job. `null` = work. */
    publishedAt: timestamp('published_at', { withTimezone: true }),
    /** Insertion order — the relay's `ORDER BY`. A uuid cannot order and `created_at` can tie. */
    seq: bigint('seq', { mode: 'number' }).notNull().generatedAlwaysAsIdentity(),
    traceId: text('trace_id'),
    type: text('type').notNull(),
  },
  (table) => [
    // Partial: the relay's whole read path is "next 100 unpublished in seq order", and this keeps
    // that an index walk no matter how large the published history grows.
    index('outbox_unpublished_seq_idx')
      .on(table.seq)
      .where(sql`${table.publishedAt} is null`),
    // Spec 014's scheduler dedupes `maintenance.due` by `(type, aggregate_id)` before appending.
    index('outbox_type_aggregate_id_idx').on(table.type, table.aggregateId),
  ],
);

/**
 * One row per (consumer, event) that has been handled — the idempotency guarantee (spec FR-002).
 * Inserted `ON CONFLICT DO NOTHING RETURNING event_id` in the handler's transaction; an empty
 * result means "already done, succeed". Append-only by privilege like `audit_log`
 * (`0009_outbox_grants.sql`). No foreign key to `outbox`: the outbox row is pruned on its own
 * schedule and this row must outlive it.
 */
export const processedEvents = pgTable(
  'processed_events',
  {
    consumer: text('consumer').notNull(),
    eventId: uuid('event_id').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.consumer, table.eventId] })],
);

export type NewOutboxEvent = typeof outbox.$inferInsert;
export type NewProcessedEvent = typeof processedEvents.$inferInsert;
export type OutboxEvent = typeof outbox.$inferSelect;
export type ProcessedEvent = typeof processedEvents.$inferSelect;
