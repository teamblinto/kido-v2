import { sql } from 'drizzle-orm';
import { customType, timestamp } from 'drizzle-orm/pg-core';

/**
 * Case-insensitive text. Installed by `infra/postgres/init-roles.sql`; Appendix A requires it for
 * `users.email` so that `A@b.com` and `a@b.com` cannot become two accounts.
 */
export const citext = customType<{ data: string; driverData: string }>({
  dataType: () => 'citext',
});

/** Raw ciphertext. Envelope-encrypted payloads are bytes, never base64 in a text column. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * Wall-clock columns every table carries (Appendix A). `updated_at` is bumped from the database
 * clock rather than the process clock, so a skewed node cannot write a timestamp from the future.
 * `$onUpdate` only fires for Drizzle updates; the append-only tables in T05 do not update at all.
 */
export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => sql`now()`),
};

/**
 * The same, plus the soft-delete column Appendix A requires "where a tenant-level restore is
 * expected" — the containers that hold tenant data. Rows that *grant access* deliberately do not
 * get one; see `docs/adr/012-soft-delete-boundary.md`.
 */
export const restorableTimestamps = {
  ...timestamps,
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
};
