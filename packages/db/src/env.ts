/**
 * Connection strings for the tooling in this package.
 *
 * Migrations, the seed and the schema tests all run as `forge_migrator`, the role that owns the
 * schema (§09 — `FORCE ROW LEVEL SECURITY` applies RLS to the table owner, so the owner can never
 * also be the request-path role). The request-path pools belong to `apps/api`, not here.
 *
 * The fallback is the local compose stack described in `infra/postgres/init-roles.sql`; those
 * credentials are development placeholders, not secrets. Anything other than a laptop sets
 * `DATABASE_MIGRATION_URL` explicitly, and the fallback fails closed by pointing at localhost.
 */
const LOCAL_MIGRATION_URL = 'postgres://forge_migrator:forge_migrator@localhost:5432/forge';
const LOCAL_APP_URL = 'postgres://forge_app:forge_app@localhost:5432/forge';
const LOCAL_BYPASS_URL = 'postgres://forge_bypass:forge_bypass@localhost:5432/forge';

export function migrationDatabaseUrl(): string {
  return process.env.DATABASE_MIGRATION_URL ?? LOCAL_MIGRATION_URL;
}

/**
 * The request-path role, for the one thing in this package that has to be `forge_app` rather than
 * the migrator: the privilege assertions in `src/schema/rls.spec.ts`. A grant is only proven by the
 * role the grant is about, and every other connection here owns the tables.
 *
 * The runtime pool still belongs to `apps/api`; this reads the same `DATABASE_URL` it does.
 */
export function appDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? LOCAL_APP_URL;
}

/**
 * The cross-tenant probe role, for the column-grant assertions in `src/schema/rls.spec.ts`: a
 * column grant is only proven by the role it names (spec 028, `0036_domains_are_tenant_owned.sql`).
 * It reads the same `DATABASE_URL_BYPASS_RLS` `apps/api` does.
 */
export function bypassDatabaseUrl(): string {
  return process.env.DATABASE_URL_BYPASS_RLS ?? LOCAL_BYPASS_URL;
}
