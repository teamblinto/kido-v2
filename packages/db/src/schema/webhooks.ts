import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { timestamps } from './columns';
import { connectorProvider } from './connectors';
import { secrets } from './secrets';
import { orgs, projects } from './tenancy';

/** `received` is committed in the request; every other transition happens in the consumer. */
export const webhookDeliveryState = pgEnum('webhook_delivery_state', [
  'received',
  'processed',
  'ignored',
  'failed',
]);

/**
 * One row per delivery the provider hands us (spec 026, data-model § 1). `id` doubles as the outbox
 * aggregate id and the BullMQ job id, as `sync_operations.id` does.
 *
 * A **platform** table, like `outbox` and `sandbox_pool`: deliberately no column named `org_id`,
 * and therefore no policy. The delivery arrives before any organisation is known (R11), and
 * resolving one would mean doing the lookup in the request, which is the processing § 12 forbids
 * there. Every *effect* of a delivery happens inside a per-organisation tenant transaction (R13),
 * so tenancy is enforced where the tenant exists. Grants live in
 * `migrations/0032_webhook_deliveries_grants.sql`, which carries the same argument for the reader
 * who arrives at the migration first.
 *
 * `body` is nullable because the retention sweep nulls it at 7 days and deletes the row at 30
 * (R15); `failure` holds a classified category, never a provider body (§ 05).
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    attempts: integer('attempts').notNull().default(0),
    /** Nulled by the retention sweep at 7 days — a delivery outlives its payload. */
    body: jsonb('body').$type<Record<string, unknown>>(),
    /** The provider's own id (`X-GitHub-Delivery`); half of the dedup key. */
    deliveryId: text('delivery_id').notNull(),
    /** `push`, or whatever arrived: an unknown event is recorded and ignored, not refused (R16). */
    eventType: text('event_type').notNull(),
    /** A classified category, never a provider body. */
    failure: text('failure'),
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null when the payload carries none; such a delivery is ignored at processing. */
    installationId: bigint('installation_id', { mode: 'number' }),
    provider: connectorProvider('provider').notNull(),
    /** From the injected `ClockPort`, set by the writer. Never `now()`. */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    state: webhookDeliveryState('state').notNull(),
    ...timestamps,
  },
  (table) => [
    // The dedup key. The insert is `ON CONFLICT DO NOTHING`; zero rows means duplicate —
    // acknowledged and not enqueued (R11, FR-027).
    unique('webhook_deliveries_provider_delivery_id_key').on(table.provider, table.deliveryId),
    // The retention sweep's predicate.
    index('webhook_deliveries_received_at_idx').on(table.receivedAt),
    // Partial: the parked-deliveries view (FR-029) reads only the failures, and this keeps that an
    // index walk no matter how large the processed history grows.
    index('webhook_deliveries_failed_idx')
      .on(table.state, table.receivedAt)
      .where(sql`${table.state} = 'failed'`),
  ],
);

export type NewWebhookDelivery = typeof webhookDeliveries.$inferInsert;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;

/** Spec 029, data-model.md § 1. `paused` is entered only by the attempt settle (R9). */
export const webhookEndpointState = pgEnum('webhook_endpoint_state', [
  'enabled',
  'disabled',
  'paused',
]);

/** Spec 029, data-model.md § 2. `cancelled` is never stored: deleting an endpoint deletes its sends. */
export const webhookSendState = pgEnum('webhook_send_state', [
  'pending',
  'succeeded',
  'failed',
  'not_sent',
]);

/**
 * An organisation's outbound webhook endpoint (spec 029, data-model.md § 1). Tenant-owned: RLS,
 * grants and the CHECKs comparing `state::text` live in
 * `migrations/0039_webhook_endpoints_are_tenant_owned.sql` (the 0021 enum-in-one-transaction
 * gotcha); they are declared here too so drizzle-kit's snapshot records them and never diffs them
 * again. Hard-deleted: sends, attempts and project scope cascade with it.
 */
export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    circuitOpenUntil: timestamp('circuit_open_until', { withTimezone: true }),
    /** The member who created it; used only for the audit trail. */
    createdBy: uuid('created_by').notNull(),
    description: text('description').notNull().default(''),
    /** Non-empty; each a public event type except `ping`. */
    eventTypes: text('event_types').array().notNull(),
    failingSince: timestamp('failing_since', { withTimezone: true }),
    failureCount: integer('failure_count').notNull().default(0),
    id: uuid('id').primaryKey().defaultRandom(),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    previousSecretExpiresAt: timestamp('previous_secret_expires_at', { withTimezone: true }),
    /** Set only during a rotation overlap. */
    previousSecretId: uuid('previous_secret_id'),
    secretId: uuid('secret_id').notNull(),
    state: webhookEndpointState('state').notNull(),
    /** Normalised by `parseEndpointUrl` (R8); at most 2,048 characters. */
    url: text('url').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('webhook_endpoints_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.secretId],
      foreignColumns: [secrets.orgId, secrets.id],
      name: 'webhook_endpoints_org_id_secret_id_fk',
    }),
    foreignKey({
      columns: [table.orgId, table.previousSecretId],
      foreignColumns: [secrets.orgId, secrets.id],
      name: 'webhook_endpoints_org_id_previous_secret_id_fk',
    }),
    check(
      'webhook_endpoints_previous_secret_check',
      sql`(${table.previousSecretId} is null) = (${table.previousSecretExpiresAt} is null)`,
    ),
    check(
      'webhook_endpoints_paused_check',
      sql`(${table.state}::text = 'paused') = (${table.pausedAt} is not null)`,
    ),
    index('webhook_endpoints_org_created_idx').on(table.orgId, table.createdAt),
  ],
);

/** An endpoint's project scope (data-model.md § 1a). No rows means every project (FR-002). */
export const webhookEndpointProjects = pgTable(
  'webhook_endpoint_projects',
  {
    endpointId: uuid('endpoint_id').notNull(),
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('webhook_endpoint_projects_org_id_id_key').on(table.orgId, table.id),
    unique('webhook_endpoint_projects_endpoint_id_project_id_key').on(
      table.endpointId,
      table.projectId,
    ),
    foreignKey({
      columns: [table.orgId, table.endpointId],
      foreignColumns: [webhookEndpoints.orgId, webhookEndpoints.id],
      name: 'webhook_endpoint_projects_org_id_endpoint_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
      name: 'webhook_endpoint_projects_org_id_project_id_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * One event for one endpoint (data-model.md § 2): the API calls it a "delivery"; the name differs
 * only because spec 026 already owns `webhook_deliveries` (R3). `body` is `text`, not `jsonb`: the
 * bytes are what is signed, and `jsonb` re-serialises. `project_id` has no FK, because the log
 * outlives an archived project.
 */
export const webhookSends = pgTable(
  'webhook_sends',
  {
    attempts: integer('attempts').notNull().default(0),
    /** The exact serialised envelope; nulled at 7 days. */
    body: text('body'),
    /** The attempt lease (R6). */
    claimedUntil: timestamp('claimed_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    endpointId: uuid('endpoint_id').notNull(),
    /** The outbox event id, or a fresh id for `ping`; stable across retries and replay. */
    eventId: uuid('event_id').notNull(),
    eventType: text('event_type').notNull(),
    firstAttemptAt: timestamp('first_attempt_at', { withTimezone: true }),
    id: uuid('id').primaryKey().defaultRandom(),
    lastFailure: text('last_failure'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id'),
    state: webhookSendState('state').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`now()`),
  },
  (table) => [
    unique('webhook_sends_org_id_id_key').on(table.orgId, table.id),
    // The fan-out's dedup key (FR-011, SC-003).
    unique('webhook_sends_endpoint_id_event_id_key').on(table.endpointId, table.eventId),
    foreignKey({
      columns: [table.orgId, table.endpointId],
      foreignColumns: [webhookEndpoints.orgId, webhookEndpoints.id],
      name: 'webhook_sends_org_id_endpoint_id_fk',
    }).onDelete('cascade'),
    check(
      'webhook_sends_next_attempt_check',
      sql`(${table.state}::text = 'pending') = (${table.nextAttemptAt} is not null)`,
    ),
    index('webhook_sends_log_idx').on(
      table.orgId,
      table.endpointId,
      table.createdAt.desc(),
      table.id,
    ),
    // The redelivery probe (bypass).
    index('webhook_sends_due_idx')
      .on(table.nextAttemptAt)
      .where(sql`${table.state} = 'pending'`),
    // The per-organisation in-flight count (R9).
    index('webhook_sends_in_flight_idx')
      .on(table.orgId)
      .where(sql`${table.claimedUntil} is not null`),
    index('webhook_sends_created_at_idx').on(table.createdAt),
  ],
);

/** One HTTP attempt of a send (data-model.md § 3). */
export const webhookSendAttempts = pgTable(
  'webhook_send_attempts',
  {
    /** The pinned address connected to; null when refused before connecting. */
    address: inet('address'),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull(),
    durationMs: integer('duration_ms').notNull(),
    failure: text('failure'),
    id: uuid('id').primaryKey().defaultRandom(),
    /** True for a replay or a first `ping`. */
    manual: boolean('manual').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    /** First 4 KB as received; nulled at 7 days. */
    responseBody: text('response_body'),
    /** At most 32 headers of 1 KB; `set-cookie` dropped. */
    responseHeaders: jsonb('response_headers').$type<Record<string, string>>(),
    sendId: uuid('send_id').notNull(),
    status: integer('status'),
    ...timestamps,
  },
  (table) => [
    unique('webhook_send_attempts_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.sendId],
      foreignColumns: [webhookSends.orgId, webhookSends.id],
      name: 'webhook_send_attempts_org_id_send_id_fk',
    }).onDelete('cascade'),
    index('webhook_send_attempts_send_idx').on(table.orgId, table.sendId, table.attemptedAt.desc()),
  ],
);

export type NewWebhookEndpoint = typeof webhookEndpoints.$inferInsert;
export type NewWebhookSend = typeof webhookSends.$inferInsert;
export type NewWebhookSendAttempt = typeof webhookSendAttempts.$inferInsert;
export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;
export type WebhookSend = typeof webhookSends.$inferSelect;
export type WebhookSendAttempt = typeof webhookSendAttempts.$inferSelect;
