import { index, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { citext, timestamps } from './columns';
import { users } from './identity';

/**
 * Single-use credentials that belong to a *person*, not to a tenant.
 *
 * Like `users` these are roots: they carry no `org_id`, take no RLS policy, and reference `users.id`
 * with a single-column key. That is deliberate and is argued in
 * `docs/adr/015-account-scoped-auth-tables-are-roots.md` — the short version is that the flows
 * consuming them run *before* there is a tenant context to set. A password reset knows a token and
 * nothing else; giving these tables an `org_id` would force the reset path to guess an organisation
 * for a user who may belong to none or to six, and RLS would then hide the row from the one request
 * entitled to it.
 *
 * None of them stores the token it hands out. The column is the SHA-256 digest of the raw value,
 * hex-encoded: a database disclosure must not be a valid reset link. Consumption is `consumed_at`
 * rather than a delete, so replaying a used token is distinguishable from presenting one that never
 * existed — and neither is soft-deleted (ADR 012: these grant access).
 */
export const emailVerificationTokens = pgTable(
  'email_verification_tokens',
  {
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    /**
     * The address this token proves control of, captured at issue time. Success criterion 2 requires
     * an email change to invalidate an outstanding link; comparing this against `users.email` at
     * consumption is what makes that true without a second table to keep in step.
     */
    email: citext('email').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('email_verification_tokens_token_hash_key').on(table.tokenHash),
    index('email_verification_tokens_user_id_idx').on(table.userId),
  ],
);

/**
 * Password reset. §11 requires that using one of these revokes every session and refresh token, so
 * the row outlives its use by `consumed_at` — the revocation is auditable after the fact.
 */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('password_reset_tokens_token_hash_key').on(table.tokenHash),
    index('password_reset_tokens_user_id_idx').on(table.userId),
  ],
);

/**
 * The ten one-time codes issued at TOTP enrolment (success criterion 8). `code_hash` is a password
 * hash, not a digest — a recovery code is low-entropy enough to be worth brute-forcing, so T20
 * writes the same Argon2id output it writes for a password, and the column is sized for it.
 *
 * The unique key is `(user_id, code_hash)`: single use is enforced by `consumed_at`, and this stops
 * one enrolment from issuing the same code twice.
 */
export const mfaRecoveryCodes = pgTable(
  'mfa_recovery_codes',
  {
    codeHash: text('code_hash').notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (table) => [unique('mfa_recovery_codes_user_id_code_hash_key').on(table.userId, table.codeHash)],
);

export type EmailVerificationToken = typeof emailVerificationTokens.$inferSelect;
export type NewEmailVerificationToken = typeof emailVerificationTokens.$inferInsert;
export type MfaRecoveryCode = typeof mfaRecoveryCodes.$inferSelect;
export type NewMfaRecoveryCode = typeof mfaRecoveryCodes.$inferInsert;
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert;
