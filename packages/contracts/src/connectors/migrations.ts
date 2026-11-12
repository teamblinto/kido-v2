import { z } from 'zod';

/**
 * SQL migrations for a project's bound database (Neon preview branch, Supabase project). The agent
 * writes `<version>_<name>.sql` files into the provider's directory; the person applies the pending
 * ones from the integrations panel. The applied set lives in the database itself, in
 * `<schema>.schema_migrations` — Supabase's own CLI table, so `supabase db push` agrees with it.
 */

export const MIGRATION_PROVIDERS = ['neon', 'supabase'] as const;

export const migrationProviderSchema = z.enum(MIGRATION_PROVIDERS);

export type MigrationProvider = z.output<typeof migrationProviderSchema>;

/** Where the project keeps each provider's migrations, relative to the workspace root. */
export const MIGRATION_DIRECTORIES: Readonly<Record<MigrationProvider, string>> = {
  neon: 'db/migrations',
  supabase: 'supabase/migrations',
};

/** Digits only (a `YYYYMMDDHHMMSS` timestamp by convention): it is ordered and inlined as a literal. */
export const migrationVersionSchema = z.string().regex(/^\d{1,20}$/u);

export const migrationNameSchema = z.string().regex(/^[A-Za-z0-9_-]{0,100}$/u);

/** One file's text; the request body limit (1 MB) bounds the whole batch. */
export const MIGRATION_SQL_MAX_BYTES = 256 * 1024;

export const migrationSchema = z.strictObject({
  name: migrationNameSchema,
  sql: z.string().min(1).max(MIGRATION_SQL_MAX_BYTES),
  version: migrationVersionSchema,
});

export type Migration = z.output<typeof migrationSchema>;

export const applyMigrationsRequestSchema = z.strictObject({
  migrations: z.array(migrationSchema).min(1).max(100),
});

export type ApplyMigrationsRequest = z.output<typeof applyMigrationsRequestSchema>;

export const migrationStatusSchema = z.strictObject({
  applied: z.array(migrationVersionSchema),
  directory: z.string(),
});

export type MigrationStatus = z.output<typeof migrationStatusSchema>;

/**
 * Migrations run in version order, each in its own transaction, and the run stops at the first
 * failure: `failed` names it with the database's message (the person's own SQL error).
 */
export const applyMigrationsResponseSchema = z.strictObject({
  applied: z.array(migrationVersionSchema),
  failed: z.strictObject({ message: z.string(), version: migrationVersionSchema }).nullable(),
  skipped: z.array(migrationVersionSchema),
});

export type ApplyMigrationsResponse = z.output<typeof applyMigrationsResponseSchema>;

const FILE_NAME = /^(\d{1,20})_([A-Za-z0-9_-]{0,100})\.sql$/u;

/** `20261112093000_create_todos.sql` → `{ version, name }`; any other name is not a migration. */
export function parseMigrationFileName(
  fileName: string,
): { readonly name: string; readonly version: string } | undefined {
  const match = FILE_NAME.exec(fileName);

  return match === null ? undefined : { name: match[2]!, version: match[1]! };
}
