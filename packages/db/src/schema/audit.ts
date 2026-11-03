import { index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { timestamps } from './columns';
import { orgs } from './tenancy';

/**
 * The append-only security trail (§09, Appendix A). Append-only is enforced by the grant in
 * `migrations/0003_grants.sql` — `forge_app` gets `SELECT` and `INSERT` and nothing else — because
 * a convention that says "never update this table" is a convention one migration or one repository
 * method can break silently, and a missing privilege is not.
 *
 * Partition-**ready**, not partitioned: `pg_partman` is out of scope for this spec (§09 lists
 * monthly partitions as the eventual strategy). What that readiness costs today is the `at` column
 * below and the absence of any incoming foreign key; what it will cost then is recorded in
 * `docs/adr/016-audit-log-is-partition-ready-not-partitioned.md`.
 *
 * `actor_id` deliberately carries **no** foreign key to `users`. The trail is retained for one to
 * seven years and outlives the rows it names: an `on delete set null` would erase the attribution
 * the trail exists to keep, and an `on delete restrict` would make an account deletion fail against
 * its own audit history.
 *
 * `org_id` is not null like every other tenant-owned table, so an account-scope security event that
 * belongs to no organisation — a failed login for an address that does not exist — is not recorded
 * here. Those go to the structured application log (§05). A nullable `org_id` would be worse than
 * either: the `tenant_isolation` policy compares it with `=`, so a null row is invisible to every
 * tenant and readable only by the bypass role, which is a silent hole rather than a design.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    action: text('action').notNull(),
    actorId: uuid('actor_id'),
    /**
     * When the audited thing happened, from the injected `ClockPort`, and the future partition key.
     * `created_at` is when the row was written; the two are usually equal and are deliberately not
     * one column, because a partition key has to be the caller's stable event time.
     */
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    id: uuid('id').primaryKey().defaultRandom(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    target: text('target').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('audit_log_org_id_id_key').on(table.orgId, table.id),
    index('audit_log_org_id_at_idx').on(table.orgId, table.at),
    index('audit_log_org_id_actor_id_at_idx').on(table.orgId, table.actorId, table.at),
  ],
);

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
