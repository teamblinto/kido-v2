import { pgEnum, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { citext, timestamps } from './columns';
import { users } from './identity';

/**
 * The providers §11 names. An enum for the same reason the role vocabularies are enums — it stops a
 * typo becoming a row — and a third provider is `ALTER TYPE ... ADD VALUE`, which does not rewrite
 * the table.
 */
export const oauthProvider = pgEnum('oauth_provider', ['github', 'google']);

/**
 * A federated login linked to an account. Like `users` this is a root: a person's GitHub account is
 * not tenant data, and the uniqueness that matters is **global**.
 *
 * `unique (provider, provider_user_id)` is the security property, not a hygiene constraint. Scoped
 * per organisation instead, one GitHub identity could be linked to a different local account in
 * each tenant, and "sign in with GitHub" would then resolve to whichever row the query happened to
 * reach — an account takeover with no attacker required. `provider_user_id` is the provider's
 * immutable subject claim, never the email, which users change.
 *
 * `email` records what the provider asserted at link time, for the audit trail and for the
 * proof-of-email-control check in success criterion 9. It is not authoritative and never overwrites
 * `users.email`. It is nullable because a provider may withhold it.
 */
export const oauthIdentities = pgTable(
  'oauth_identities',
  {
    email: citext('email'),
    id: uuid('id').primaryKey().defaultRandom(),
    provider: oauthProvider('provider').notNull(),
    providerUserId: text('provider_user_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('oauth_identities_provider_provider_user_id_key').on(
      table.provider,
      table.providerUserId,
    ),
    unique('oauth_identities_user_id_provider_key').on(table.userId, table.provider),
  ],
);

export type OauthIdentity = typeof oauthIdentities.$inferSelect;
export type NewOauthIdentity = typeof oauthIdentities.$inferInsert;
