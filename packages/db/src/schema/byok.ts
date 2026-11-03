import { foreignKey, pgEnum, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { timestamps } from './columns';
import { connectorHealth } from './connectors';
import { users } from './identity';
import { secrets } from './secrets';
import { orgs } from './tenancy';

/** The value set of `LLM_PROVIDERS` in `@repo/contracts` (spec 020, data-model.md). */
export const llmProvider = pgEnum('llm_provider', ['anthropic', 'openai']);

/**
 * One organisation key per provider (spec 020, data-model.md § provider_keys). The sealed row is
 * the `secrets` row `secret_id` names — a composite FK, as `connections.secret_id` is, so a
 * cross-tenant pointer is a constraint violation before it is an RLS miss (research R9).
 * `last_four` is the one derivative §05 allows out and is a column so the list never opens a
 * secret; the fingerprint is read from the `secrets` row. `health` reuses 018's vocabulary and
 * this feature writes `healthy` and `needs_reauth` only (R5). `added_by` is set null so the row
 * outlives the member who pasted it.
 */
export const providerKeys = pgTable(
  'provider_keys',
  {
    addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
    health: connectorHealth('health').notNull(),
    id: uuid('id').primaryKey().defaultRandom(),
    lastFour: text('last_four').notNull(),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    provider: llmProvider('provider').notNull(),
    secretId: uuid('secret_id').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('provider_keys_org_id_id_key').on(table.orgId, table.id),
    unique('provider_keys_org_id_provider_key').on(table.orgId, table.provider),
    foreignKey({
      columns: [table.orgId, table.secretId],
      foreignColumns: [secrets.orgId, secrets.id],
      name: 'provider_keys_org_id_secret_id_fk',
    }).onDelete('cascade'),
  ],
);

export type ProviderKey = typeof providerKeys.$inferSelect;
export type NewProviderKey = typeof providerKeys.$inferInsert;
