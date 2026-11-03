import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { llmProvider } from './byok';
import { bytea, timestamps } from './columns';
import { connectorHealth } from './connectors';
import { users } from './identity';

/** Whether a provider's subscription linking is switched on (spec 032, research R12). */
export const byosProviderStatus = pgEnum('byos_provider_status', ['in_force', 'withdrawn']);

/**
 * One row per provider that has ever been switched in force (spec 032, data-model.md § byos_providers).
 * A platform table: it belongs to no tenant, so no `org_id` and no policy, and forge_app may not
 * DELETE — a provider's history is kept (`0048_byos_grants_and_platform_table.sql`).
 */
export const byosProviders = pgTable('byos_providers', {
  provider: llmProvider('provider').primaryKey(),
  record: text('record').notNull(),
  signedOffAt: timestamp('signed_off_at', { withTimezone: true }).notNull(),
  status: byosProviderStatus('status').notNull(),
  withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  ...timestamps,
});

/**
 * A person's linked subscription, one per provider (spec 032, data-model.md § linked_accounts).
 * A root table (ADR 015): owned by a person, so no `org_id` and no RLS. `grant_sealed` is the
 * account-secret seal of the grant JSON (R2); `access_expires_at` is copied out of it so "needs
 * refresh?" never opens it (R3). `health` reuses 018's vocabulary; this feature writes `healthy`
 * and `needs_reauth` only.
 */
export const linkedAccounts = pgTable(
  'linked_accounts',
  {
    accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }).notNull(),
    accountLabel: text('account_label').notNull(),
    grantSealed: bytea('grant_sealed').notNull(),
    health: connectorHealth('health').notNull(),
    healthChanges: integer('health_changes').notNull().default(0),
    id: uuid('id').primaryKey().defaultRandom(),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }).notNull(),
    limitedUntil: timestamp('limited_until', { withTimezone: true }),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull(),
    provider: llmProvider('provider').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (table) => [
    unique('linked_accounts_user_id_provider_key').on(table.userId, table.provider),
    index('linked_accounts_provider_last_checked_at_idx').on(table.provider, table.lastCheckedAt),
  ],
);

export type ByosProviderRow = typeof byosProviders.$inferSelect;
export type LinkedAccountRow = typeof linkedAccounts.$inferSelect;
export type NewLinkedAccountRow = typeof linkedAccounts.$inferInsert;
