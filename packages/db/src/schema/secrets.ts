import { sql } from 'drizzle-orm';
import {
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { bytea, timestamps } from './columns';
import { orgs } from './tenancy';

/**
 * The wrapped data-encryption key for one organisation (§05 envelope encryption). The DEK itself is
 * never stored: `wrapped_dek` is the ciphertext produced by the pluggable `KekProvider` (ADR 003),
 * and `kek_id` names the key-encryption key that produced it so a KEK rotation can be replayed
 * without guessing.
 *
 * "One DEK per org" is enforced as *one current DEK per org* — the partial unique index below. A
 * rotation inserts a new row and stamps `rotated_at` on the old one, which has to stay readable
 * until the last ciphertext encrypted under it has been re-wrapped. A plain `unique (org_id)` would
 * make rotation a migration instead of two statements.
 */
export const orgDataKeys = pgTable(
  'org_data_keys',
  {
    alg: text('alg').notNull(),
    id: uuid('id').primaryKey().defaultRandom(),
    kekId: text('kek_id').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    wrappedDek: bytea('wrapped_dek').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('org_data_keys_org_id_id_key').on(table.orgId, table.id),
    uniqueIndex('org_data_keys_org_id_current_key')
      .on(table.orgId)
      .where(sql`${table.rotatedAt} is null`),
  ],
);

/**
 * Envelope-encrypted tenant secrets — connector credentials, BYOK provider keys (Appendix A).
 * `ciphertext` is bytes, never base64 in a text column, and `org_id` plus `purpose` are bound into
 * the AAD by the crypto module (T08), which is what makes a row moved between tenants fail to
 * decrypt rather than succeed. `fingerprint` is the only part §05 allows back out of the API.
 *
 * The DEK reference is a composite `(org_id, dek_id)` foreign key: a single-column one would let a
 * secret be wrapped under another tenant's key and leave RLS to merely hide the result (§09).
 *
 * It cascades on delete rather than restricting. A DEK is never deleted in normal operation —
 * rotation stamps `rotated_at` — so the only delete that reaches one is the organisation cascade,
 * and `restrict` there would make dropping an org fail or succeed depending on the order Postgres
 * happens to walk two children of the same parent.
 */
export const secrets = pgTable(
  'secrets',
  {
    alg: text('alg').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    dekId: uuid('dek_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('secrets_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.dekId],
      foreignColumns: [orgDataKeys.orgId, orgDataKeys.id],
      name: 'secrets_org_id_dek_id_fk',
    }).onDelete('cascade'),
    index('secrets_org_id_purpose_idx').on(table.orgId, table.purpose),
  ],
);

export type OrgDataKey = typeof orgDataKeys.$inferSelect;
export type NewOrgDataKey = typeof orgDataKeys.$inferInsert;
export type Secret = typeof secrets.$inferSelect;
export type NewSecret = typeof secrets.$inferInsert;
