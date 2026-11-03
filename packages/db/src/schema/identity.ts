import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { bytea, citext, timestamps } from './columns';

/**
 * Users are a root, not a tenant-owned table: a person exists before any organisation and may hold
 * memberships in several. `org_id` therefore does not belong here, and `memberships` is the only
 * thing that ties a user to a tenant. Everything reachable *through* a user is tenant-owned.
 *
 * `password_hash` is nullable because an OAuth-only account never sets one (§11), and
 * `mfa_secret_enc` holds the envelope ciphertext of the TOTP seed — the plaintext seed never
 * reaches a column.
 */
export const users = pgTable(
  'users',
  {
    email: citext('email').notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    id: uuid('id').primaryKey().defaultRandom(),
    mfaSecretEnc: bytea('mfa_secret_enc'),
    passwordHash: text('password_hash'),
    ...timestamps,
  },
  (table) => [uniqueIndex('users_email_key').on(table.email)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
