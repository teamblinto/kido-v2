import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { appDatabaseUrl, bypassDatabaseUrl, migrationDatabaseUrl } from '../env';

const { Pool } = pg;

interface PolicyRow {
  cmd: string;
  policyName: string;
  qual: string | null;
  tableName: string;
  withCheck: string | null;
}

interface PrivilegeRow {
  hasDelete: boolean;
  hasInsert: boolean;
  hasSelect: boolean;
  hasUpdate: boolean;
  tableName: string;
}

interface SecurityRow {
  forced: boolean;
  enabled: boolean;
  tableName: string;
}

/**
 * The predicate §09 mandates, as Postgres renders it back from `pg_policies`.
 *
 * The `NULLIF` is not decoration and is asserted rather than tolerated. Setting a customised option
 * creates it on that backend, and a transaction-scoped set reverts the *value* at commit -- to the
 * empty string, not to non-existence. Without the `NULLIF`, `''::uuid` raises 22P02 on every query
 * a reused connection issues outside a tenant transaction, instead of returning the zero rows §09
 * requires. `migrations/0004_rls_null_tenant.sql` carries the measurement; ADR 005 carries the why.
 */
const TENANT_PREDICATE =
  /org_id = \(?NULLIF\(current_setting\('app\.org_id'::text, true\), ''::text\)\)?::uuid/;

/**
 * The one clause in the schema that filters by a person instead of by a tenant, asserted here so it
 * is a decision rather than something the regex above happens to tolerate.
 *
 * `migrations/0007_memberships_self_read.sql` adds it to `memberships` and to nothing else, so that
 * "which organisations am I in?" — the one read in the product that spans tenants by nature — can be
 * answered on the request path instead of through `forge_bypass`. ADR 023 carries the argument.
 *
 * Two properties are checked below and both matter. It appears on exactly one table: a second table
 * gaining it would mean a transaction carrying `app.user_id` could read more than a person's own
 * membership edges. And it appears in `USING` only: in `WITH CHECK` it would let a row be written
 * outside any tenant.
 */
const SELF_READ_PREDICATE =
  /user_id = \(?NULLIF\(current_setting\('app\.user_id'::text, true\), ''::text\)\)?::uuid/;

/**
 * The only tables `SELF_READ_PREDICATE` may appear on. `project_grants` joined `memberships` in
 * spec 031 (`0045_project_invitations_and_grant_self_read.sql`, research R6): a guest's
 * organisations are reached through their grants, and `GET /orgs` has no `app.org_id` to set.
 */
const SELF_READ_TABLES = ['memberships', 'project_grants'];

/**
 * The tables that are neither tenant-owned nor given the four verbs — each with its own privilege
 * assertion below, so naming a table here narrows what forge_app may do rather than excusing it.
 *
 * `audit_log` is append-only (0003). `outbox` and `processed_events` are spec 005's platform
 * tables (`0009_outbox_grants.sql`): the relay reads every tenant's rows as forge_app, so they carry
 * no policy and no `org_id` column, and forge_app gets exactly the verbs the relay and the consumer
 * base need — one UPDATE for the published mark, and no DELETE anywhere. `sandbox_pool` and
 * `sandbox_pool_settings` are spec 014's warm pool (`0014_sandbox_pool_grants.sql`): a pool entry
 * belongs to no tenant until claimed, so neither carries `org_id` or a policy, and forge_app gets
 * the four verbs — the claim is a DELETE. `template_versions` is spec 015's catalogue
 * (`0016_template_versions_grants.sql`): a version belongs to no tenant either.
 * `webhook_deliveries` is spec 026's receiver (`0030_webhook_deliveries_grants.sql`): a delivery
 * arrives carrying an installation id and no organisation, and resolving one would put the lookup
 * on the request path — so it carries no `org_id` and no policy, and forge_app gets the four verbs
 * (the retention sweep is an UPDATE and a DELETE). `byos_providers` is spec 032's sign-off record
 * (`0048_byos_grants_and_platform_table.sql`, research R12): forge_app gets SELECT, INSERT and
 * UPDATE and no DELETE, so a provider's history is kept.
 */
const PLATFORM_TABLES = [
  'audit_log',
  'byos_providers',
  'outbox',
  'processed_events',
  'sandbox_pool',
  'sandbox_pool_settings',
  'template_versions',
  'webhook_deliveries',
];

/**
 * Tenant-owned, but append-only like `audit_log` rather than given the four verbs. `run_events`
 * (spec 008, `0011_run_events_partitioned.sql`) is the event log of a run: a milestone is a fact
 * about the past, and a role that cannot UPDATE cannot rewrite one. Named here so the four-verb
 * assertion skips it and its own assertions below hold it to exactly SELECT and INSERT.
 */
const APPEND_ONLY_TABLES = ['run_events'];

/**
 * Tenant-owned and append-only in spirit, but with one column that moves: `checkpoints` (spec 016,
 * `0018_checkpoints_are_append_only.sql`) is history, and FR-003 makes that a grant — forge_app
 * may INSERT, SELECT and UPDATE only `mirrored_at`, never DELETE. A column-scoped UPDATE is not a
 * table privilege, so the four-verb assertion skips it and its own assertions below hold it to
 * exactly that shape as the role itself.
 */
const COLUMN_UPDATABLE_TABLES = ['checkpoints'];

/**
 * Tenant-owned and written in place, but never deleted by the application: `deployments` and
 * `project_sites` (spec 027, `0034_deploys_are_tenant_owned.sql`). A deployment is the record of a
 * release, moved through its states by UPDATE, and a site row is the release pointer; both go
 * with their project by cascade, so forge_app gets SELECT, INSERT and UPDATE and no DELETE. Named
 * here so the four-verb assertion skips them and their own assertion below holds them to exactly
 * that shape. `domains` joins them (spec 028, `0036_domains_are_tenant_owned.sql`): rows are never
 * deleted, every end goes through `removing` and settles as `failed` or `removed` by UPDATE (R9).
 * `project_invitations` (spec 031, 0045) mirrors `invitations`: withdrawn and accepted are stamps.
 */
const NO_DELETE_TABLES = ['deployments', 'domains', 'project_invitations', 'project_sites'];

const migratorPool = new Pool({
  connectionString: migrationDatabaseUrl(),
  connectionTimeoutMillis: 3_000,
  max: 1,
});

/**
 * The request-path role, and the only connection here that is not the table owner. Everything about
 * a grant is a claim about a specific role, so the append-only proof has to be made as the role the
 * grant names — as the migrator it would prove nothing, and `FORCE ROW LEVEL SECURITY` means the
 * migrator is not even exempt from the policies.
 */
const appPool = new Pool({
  connectionString: appDatabaseUrl(),
  connectionTimeoutMillis: 3_000,
  max: 1,
});

async function isReachable(pool: pg.Pool): Promise<boolean> {
  try {
    await pool.query('select 1');
    return true;
  } catch {
    return false;
  }
}

function redacted(url: string): string {
  return url.replace(/:\/\/[^@]*@/, '://***@');
}

/**
 * The cross-tenant probe role, for the one grant here that is narrower than a table: forge_bypass
 * reads six columns of `domains` and not `ownership_token` (spec 028, 0036).
 */
const bypassPool = new Pool({
  connectionString: bypassDatabaseUrl(),
  connectionTimeoutMillis: 3_000,
  max: 1,
});

const databaseReachable =
  (await isReachable(migratorPool)) &&
  (await isReachable(appPool)) &&
  (await isReachable(bypassPool));

if (!databaseReachable) {
  if (process.env.EXPECT_INTEGRATION === '1') {
    await Promise.all([migratorPool.end(), appPool.end(), bypassPool.end()]);
    throw new Error(
      `EXPECT_INTEGRATION=1 but Postgres is unreachable at ${redacted(migrationDatabaseUrl())} ` +
        `or ${redacted(appDatabaseUrl())} or ${redacted(bypassDatabaseUrl())} — CI must not ` +
        'skip the RLS gate.',
    );
  }

  console.warn(
    [
      '',
      '='.repeat(100),
      'SKIPPING the row-level-security gate: Postgres is unreachable as forge_migrator at',
      `${redacted(migrationDatabaseUrl())}, as forge_app at ${redacted(appDatabaseUrl())} or as`,
      `forge_bypass at ${redacted(bypassDatabaseUrl())}.`,
      'Start it with `docker compose up -d postgres`, then `pnpm --filter @repo/db db:migrate`.',
      'CI runs this suite with EXPECT_INTEGRATION=1, where an unreachable database is a failure.',
      '='.repeat(100),
      '',
    ].join('\n'),
  );

  await Promise.all([migratorPool.end(), appPool.end(), bypassPool.end()]);
}

/**
 * The row-level-security gate.
 *
 * §09: "Application guards check permissions; row-level security makes a guard bug a non-event
 * rather than a breach." That is only true if RLS is on, forced, and carries both clauses — three
 * properties nothing in the TypeScript schema can express, because `migrations/0002_rls_policies.sql`
 * is hand-written and `drizzle-kit` neither emits policies nor notices their absence.
 *
 * "Tenant-owned" is derived from the database — any table carrying an `org_id` column — and never
 * from a list in this file. A table added next month is in scope the moment it is created, and the
 * only way to leave the gate is to stop being tenant-owned.
 */
describe.skipIf(!databaseReachable)('row-level security', () => {
  let policies: PolicyRow[] = [];
  let bypassPrivileges: PrivilegeRow[] = [];
  let privileges: PrivilegeRow[] = [];
  let security: SecurityRow[] = [];
  let tenantOwnedTables: string[] = [];

  beforeAll(async () => {
    // A partition (`relispartition`) is storage for its parent, not a table of its own: it is
    // never named by the application and carries no grant, so it leaves every list here and the
    // parent — relkind 'p' — takes its place in all of them.
    const tenantOwnedResult = await migratorPool.query<{ tableName: string }>(
      `select distinct c.relname as "tableName"
         from information_schema.columns col
         join pg_class c on c.relname = col.table_name
         join pg_namespace n on n.oid = c.relnamespace and n.nspname = col.table_schema
        where col.table_schema = 'public'
          and col.column_name = 'org_id'
          and not c.relispartition
        order by c.relname`,
    );

    if (tenantOwnedResult.rows.length === 0) {
      throw new Error(
        'No tenant-owned tables found — run `pnpm --filter @repo/db db:migrate` first.',
      );
    }

    tenantOwnedTables = tenantOwnedResult.rows.map((row) => row.tableName);

    const securityResult = await migratorPool.query<SecurityRow>(
      `select c.relname          as "tableName",
              c.relrowsecurity   as "enabled",
              c.relforcerowsecurity as "forced"
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind in ('r', 'p')
          and not c.relispartition
        order by c.relname`,
    );

    security = securityResult.rows;

    const policyResult = await migratorPool.query<PolicyRow>(
      `select tablename  as "tableName",
              policyname as "policyName",
              cmd        as "cmd",
              qual       as "qual",
              with_check as "withCheck"
         from pg_policies
        where schemaname = 'public'
        order by tablename, policyname`,
    );

    policies = policyResult.rows;

    const privilegesOf = async (role: string): Promise<PrivilegeRow[]> => {
      const result = await migratorPool.query<PrivilegeRow>(
        `select c.relname as "tableName",
                has_table_privilege($1, c.oid, 'SELECT') as "hasSelect",
                has_table_privilege($1, c.oid, 'INSERT') as "hasInsert",
                has_table_privilege($1, c.oid, 'UPDATE') as "hasUpdate",
                has_table_privilege($1, c.oid, 'DELETE') as "hasDelete"
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public'
            and c.relkind in ('r', 'p')
            and not c.relispartition
          order by c.relname`,
        [role],
      );

      return result.rows;
    };

    privileges = await privilegesOf('forge_app');
    bypassPrivileges = await privilegesOf('forge_bypass');
  });

  afterAll(async () => {
    await Promise.all([migratorPool.end(), appPool.end(), bypassPool.end()]);
  });

  /**
   * The list is stated rather than derived so that the assertions below cannot pass by finding
   * nothing. `workspace_members` joined it in T27, and the fact that adding the table turned this
   * test red before its policy was written is the mechanism working: every other assertion in this
   * file is quantified over this list, so a tenant-owned table with no policy cannot slip in
   * unnoticed.
   */
  it('finds the tenant-owned tables the schema is supposed to have added', () => {
    expect(tenantOwnedTables).toEqual([
      'agent_runs',
      'audit_log',
      'checkpoints',
      'connections',
      'connector_bindings',
      'connector_operations',
      'connector_resources',
      'deployments',
      'domains',
      'invitations',
      'local_agent_runs',
      'mcp_grants',
      'memberships',
      'org_data_keys',
      'project_context',
      'project_grants',
      'project_invitations',
      'project_sites',
      'projects',
      'provider_keys',
      'repo_links',
      'run_events',
      'run_messages',
      'sandboxes',
      'secrets',
      'sync_operations',
      'webhook_endpoint_projects',
      'webhook_endpoints',
      'webhook_send_attempts',
      'webhook_sends',
      'workspace_members',
      'workspaces',
    ]);
  });

  it('enables AND forces row-level security on every tenant-owned table', () => {
    const offenders = tenantOwnedTables
      .map((table) => security.find((row) => row.tableName === table))
      .filter((row) => row === undefined || !row.enabled || !row.forced)
      .map((row) => row?.tableName ?? '<missing from pg_class>');

    expect(offenders).toEqual([]);
  });

  it('leaves the roots out of it, so the list above is a fact and not a coincidence', () => {
    const rootsWithRls = security
      .filter((row) => !tenantOwnedTables.includes(row.tableName) && row.enabled)
      .map((row) => row.tableName);

    expect(rootsWithRls).toEqual([]);
  });

  /**
   * Spec 032 (ADR 015): `linked_accounts` is owned by a person, a root like `users`, so it is
   * named here rather than left to the derivation above finding no `org_id`.
   */
  it('keeps linked_accounts a root: no org_id, no row-level security, no policy, four verbs', () => {
    expect(tenantOwnedTables).not.toContain('linked_accounts');
    expect(security.find((row) => row.tableName === 'linked_accounts')).toMatchObject({
      enabled: false,
      forced: false,
    });
    expect(policies.filter((row) => row.tableName === 'linked_accounts')).toEqual([]);
    expect(privileges.find((row) => row.tableName === 'linked_accounts')).toMatchObject({
      hasDelete: true,
      hasInsert: true,
      hasSelect: true,
      hasUpdate: true,
    });
  });

  it('keeps byos_providers a platform table: no org_id, no policy, no delete for forge_app', () => {
    expect(tenantOwnedTables).not.toContain('byos_providers');
    expect(security.find((row) => row.tableName === 'byos_providers')).toMatchObject({
      enabled: false,
      forced: false,
    });
    expect(policies.filter((row) => row.tableName === 'byos_providers')).toEqual([]);
    expect(privileges.find((row) => row.tableName === 'byos_providers')).toMatchObject({
      hasDelete: false,
      hasInsert: true,
      hasSelect: true,
      hasUpdate: true,
    });
  });

  it('gives every tenant-owned table exactly one tenant_isolation policy, for all commands', () => {
    for (const table of tenantOwnedTables) {
      const forTable = policies.filter((row) => row.tableName === table);

      expect(
        forTable.map((row) => row.policyName),
        `policies on ${table}`,
      ).toEqual(['tenant_isolation']);
      expect(forTable[0]?.cmd, `${table}.tenant_isolation applies to`).toBe('ALL');
    }
  });

  /**
   * The clause that is easy to forget and impossible to notice. `USING` filters what a statement
   * reads; `WITH CHECK` constrains what it writes. With `USING` alone an INSERT stamped with another
   * tenant's `org_id` succeeds, and RLS then hides the row from the tenant who created it — a
   * cross-tenant write that looks like nothing at all from the inside.
   */
  it('carries BOTH a USING and a WITH CHECK clause on org_id, on every one of them', () => {
    for (const table of tenantOwnedTables) {
      const policy = policies.find(
        (row) => row.tableName === table && row.policyName === 'tenant_isolation',
      );

      expect(policy?.qual, `${table}.tenant_isolation USING`).toEqual(expect.any(String));
      expect(policy?.withCheck, `${table}.tenant_isolation WITH CHECK`).toEqual(expect.any(String));
      expect(policy?.qual, `${table}.tenant_isolation USING`).toMatch(TENANT_PREDICATE);
      expect(policy?.withCheck, `${table}.tenant_isolation WITH CHECK`).toMatch(TENANT_PREDICATE);
    }
  });

  /**
   * The exception, named and bounded. `GET /api/v1/orgs` is rooted at a person and spans every
   * tenant they belong to, so it cannot derive an `app.org_id` — the organisations are the answer.
   * The read stays inside the policy rather than going round it through `forge_bypass` (ADR 023),
   * which costs `memberships` this second `USING` clause and costs no other table anything.
   */
  it('lets a user read their own membership and grant rows, on those tables and no other', () => {
    const carrying = policies
      .filter((row) => SELF_READ_PREDICATE.test(row.qual ?? ''))
      .map((row) => row.tableName);

    expect(carrying).toEqual(SELF_READ_TABLES);
  });

  /**
   * `USING` filters what a statement reads; `WITH CHECK` constrains what it writes. The self-read
   * clause belongs in the first and nowhere near the second: in `WITH CHECK` it would let a caller
   * insert a membership stamped with any organisation at all, outside every tenant, simply by
   * naming themselves as its user — which is a standing grant nobody would see.
   */
  it('keeps that clause out of every WITH CHECK, so it can never widen a write', () => {
    const writable = policies
      .filter((row) => SELF_READ_PREDICATE.test(row.withCheck ?? ''))
      .map((row) => row.tableName);

    expect(writable).toEqual([]);
  });

  it('grants forge_app the four verbs on every table except the platform tables', () => {
    const writable = privileges.filter(
      (row) =>
        !PLATFORM_TABLES.includes(row.tableName) &&
        !APPEND_ONLY_TABLES.includes(row.tableName) &&
        !COLUMN_UPDATABLE_TABLES.includes(row.tableName) &&
        !NO_DELETE_TABLES.includes(row.tableName),
    );

    expect(writable.length).toBeGreaterThan(0);

    for (const row of writable) {
      expect(row, `forge_app on ${row.tableName}`).toMatchObject({
        hasDelete: true,
        hasInsert: true,
        hasSelect: true,
        hasUpdate: true,
      });
    }
  });

  it('makes audit_log append-only for forge_app by privilege, not by convention', () => {
    const auditLog = privileges.find((row) => row.tableName === 'audit_log');

    expect(auditLog).toMatchObject({
      hasDelete: false,
      hasInsert: true,
      hasSelect: true,
      hasUpdate: false,
    });
  });

  it('refuses an UPDATE on audit_log issued as forge_app', async () => {
    const error = await appPool
      .query(`update audit_log set action = 'tampered'`)
      .then(() => undefined)
      .catch((caught: unknown) => caught as pg.DatabaseError);

    expect(error, 'UPDATE audit_log was NOT refused').toBeDefined();
    // 42501 is insufficient_privilege. The check happens before RLS is consulted, so this is a
    // refusal to write at all, not a policy that filtered every row.
    expect(error?.code).toBe('42501');
    expect(error?.message).toMatch(/permission denied for table audit_log/);
  });

  /**
   * Spec 008 / ADR 032. The parent is the whole surface: a policy on it governs every row reached
   * through it, and the partitions carry no grant at all, so a statement naming one directly is a
   * privilege error before RLS is a question. That is the shape the parent-only checks above rely
   * on, so it is asserted rather than assumed.
   */
  it('makes run_events append-only for forge_app by privilege, like audit_log', () => {
    expect(privileges.find((row) => row.tableName === 'run_events')).toMatchObject({
      hasDelete: false,
      hasInsert: true,
      hasSelect: true,
      hasUpdate: false,
    });
  });

  it('refuses an UPDATE and a DELETE on run_events issued as forge_app', async () => {
    for (const statement of [`update run_events set type = 'tampered'`, 'delete from run_events']) {
      const error = await appPool
        .query(statement)
        .then(() => undefined)
        .catch((caught: unknown) => caught as pg.DatabaseError);

      expect(error?.code, `${statement} was NOT refused`).toBe('42501');
    }
  });

  it('grants forge_app nothing on a run_events partition, so the parent is the only door', async () => {
    const partitions = await migratorPool.query<{ name: string }>(
      `select i.inhrelid::regclass::text as name
         from pg_inherits i
        where i.inhparent = 'run_events'::regclass`,
    );

    expect(partitions.rows.length).toBeGreaterThanOrEqual(3);

    for (const { name } of partitions.rows) {
      const error = await appPool
        .query(`select 1 from ${name}`)
        .then(() => undefined)
        .catch((caught: unknown) => caught as pg.DatabaseError);

      expect(error?.code, `select from ${name} was NOT refused`).toBe('42501');
    }
  });

  it('refuses a DELETE on audit_log issued as forge_app', async () => {
    const error = await appPool
      .query('delete from audit_log')
      .then(() => undefined)
      .catch((caught: unknown) => caught as pg.DatabaseError);

    expect(error?.code, 'DELETE audit_log was NOT refused').toBe('42501');
  });

  /**
   * Spec 005 FR-003b. The relay runs as forge_app and sets `published_at` once, so this is the one
   * table in the schema that is append-only in spirit yet carries an UPDATE grant. DELETE is nobody's
   * until roadmap 014 decides retention.
   */
  it('grants forge_app select, insert and update but not delete on outbox', () => {
    expect(privileges.find((row) => row.tableName === 'outbox')).toMatchObject({
      hasDelete: false,
      hasInsert: true,
      hasSelect: true,
      hasUpdate: true,
    });
  });

  it('makes processed_events insert-only for forge_app by privilege', () => {
    expect(privileges.find((row) => row.tableName === 'processed_events')).toMatchObject({
      hasDelete: false,
      hasInsert: true,
      hasSelect: true,
      hasUpdate: false,
    });
  });

  it('refuses a DELETE on outbox issued as forge_app', async () => {
    const error = await appPool
      .query('delete from outbox')
      .then(() => undefined)
      .catch((caught: unknown) => caught as pg.DatabaseError);

    expect(error?.code, 'DELETE outbox was NOT refused').toBe('42501');
  });

  it('refuses an UPDATE on processed_events issued as forge_app', async () => {
    const error = await appPool
      .query(`update processed_events set consumer = 'tampered'`)
      .then(() => undefined)
      .catch((caught: unknown) => caught as pg.DatabaseError);

    expect(error?.code, 'UPDATE processed_events was NOT refused').toBe('42501');
  });

  /**
   * The invariant 0003 states and 0009 keeps: a role that can see every tenant's rows is never one
   * statement away from changing them. The relay is not forge_bypass precisely so this stays true.
   */
  it('gives forge_bypass select only on both platform tables', () => {
    for (const table of ['outbox', 'processed_events']) {
      expect(
        bypassPrivileges.find((row) => row.tableName === table),
        table,
      ).toMatchObject({
        hasDelete: false,
        hasInsert: false,
        hasSelect: true,
        hasUpdate: false,
      });
    }
  });

  /**
   * Spec 014: the pool is platform-owned and fully writable by forge_app — the refill inserts a
   * row, the op consumer settles it, the claim transaction deletes it — and carries no policy,
   * because there is no tenant to isolate by until a row is claimed. Spec 015: `template_versions`
   * is the catalogue's, written by the publish command and the refill as forge_app, and a version
   * belongs to no tenant.
   */
  for (const table of ['sandbox_pool', 'sandbox_pool_settings', 'template_versions']) {
    it(`grants forge_app the four verbs on ${table}, with no row-level security`, () => {
      expect(privileges.find((row) => row.tableName === table)).toMatchObject({
        hasDelete: true,
        hasInsert: true,
        hasSelect: true,
        hasUpdate: true,
      });
      expect(security.find((row) => row.tableName === table)).toMatchObject({
        enabled: false,
        forced: false,
      });
      expect(policies.filter((row) => row.tableName === table)).toEqual([]);
    });
  }

  /**
   * Spec 026, data-model.md § 1: `webhook_deliveries` is the deliberate exception, and it is
   * asserted as one rather than left to the derivation above finding no `org_id`. A delivery is
   * recorded before any organisation is known (R11) — the receiver verifies the signature, inserts
   * `ON CONFLICT DO NOTHING` and acknowledges — so the table carries no `org_id`, no policy and no
   * row-level security, and every *effect* of a delivery is applied by the consumer inside a
   * per-organisation tenant transaction (R13), where the tenant exists.
   *
   * The first assertion is the load-bearing one: if a later change gives this table an `org_id`,
   * it becomes tenant-owned, this test goes red, and the policy the rest of this file quantifies
   * over has to be written. The exception cannot quietly widen.
   */
  it('keeps webhook_deliveries a platform table: no org_id, no policy, four verbs', () => {
    expect(tenantOwnedTables).not.toContain('webhook_deliveries');

    expect(privileges.find((row) => row.tableName === 'webhook_deliveries')).toMatchObject({
      hasDelete: true,
      hasInsert: true,
      hasSelect: true,
      hasUpdate: true,
    });

    expect(security.find((row) => row.tableName === 'webhook_deliveries')).toMatchObject({
      enabled: false,
      forced: false,
    });

    expect(policies.filter((row) => row.tableName === 'webhook_deliveries')).toEqual([]);
  });

  it('gives forge_bypass select only on webhook_deliveries', () => {
    expect(bypassPrivileges.find((row) => row.tableName === 'webhook_deliveries')).toMatchObject({
      hasDelete: false,
      hasInsert: false,
      hasSelect: true,
      hasUpdate: false,
    });
  });

  for (const table of NO_DELETE_TABLES) {
    it(`grants forge_app select, insert and update on ${table}, and no delete`, () => {
      expect(privileges.find((row) => row.tableName === table)).toMatchObject({
        hasDelete: false,
        hasInsert: true,
        hasSelect: true,
        hasUpdate: true,
      });
    });
  }

  /**
   * Spec 027: the route broker resolves a site label to its organisation before there is a tenant
   * to set, as preview's broker does (`route-broker.service.ts` step 1) — so forge_bypass reads
   * `project_sites`, and, as everywhere (0003), cannot change it.
   */
  it('gives forge_bypass select only on project_sites, for the broker probe', () => {
    expect(bypassPrivileges.find((row) => row.tableName === 'project_sites')).toMatchObject({
      hasDelete: false,
      hasInsert: false,
      hasSelect: true,
      hasUpdate: false,
    });
  });

  /**
   * Spec 028 (0036): the sweep's due probe and the broker's serving probe run before there is a
   * tenant to set, so forge_bypass reads exactly the six columns they need. The ownership token is
   * the proof a member controls the zone, and a role that reads across tenants never sees it.
   */
  it('lets forge_bypass read the six probe columns of domains, and refuses ownership_token', async () => {
    expect(bypassPrivileges.find((row) => row.tableName === 'domains')).toMatchObject({
      hasDelete: false,
      hasInsert: false,
      hasSelect: false,
      hasUpdate: false,
    });

    const allowed = await bypassPool.query(
      'select id, org_id, project_id, hostname, state, next_check_at from domains limit 0',
    );

    expect(allowed.rowCount).toBe(0);

    const error = await bypassPool
      .query('select ownership_token from domains limit 0')
      .then(() => undefined)
      .catch((caught: unknown) => caught as pg.DatabaseError);

    // Postgres names the table, not the column, when a column-level grant does not cover it.
    expect(error?.code).toBe('42501');
    expect(error?.message).toMatch(/permission denied for table domains/);
  });

  /**
   * Spec 028's two database-held invariants, proved by the database refusing them. Seeded as the
   * migrator in one transaction and rolled back; each probe runs under a savepoint so a refusal
   * does not end the transaction.
   */
  describe('domains invariants', () => {
    const token = 'abcdefghijklmnopqrstuvwxyz234567';

    async function withSeed(
      probe: (
        client: pg.PoolClient,
        seed: { orgs: [string, string]; projects: [string, string] },
      ) => Promise<void>,
    ): Promise<void> {
      const client = await migratorPool.connect();
      try {
        await client.query('begin');
        const orgs: string[] = [];
        const projects: string[] = [];
        for (const suffix of ['a', 'b']) {
          const orgId = (
            await client.query<{ id: string }>(
              `insert into orgs (name, slug) values ('domains-probe', 'domains-probe-' || gen_random_uuid()) returning id`,
            )
          ).rows[0]!.id;
          await client.query(`select set_config('app.org_id', $1, true)`, [orgId]);
          const workspaceId = (
            await client.query<{ id: string }>(
              `insert into workspaces (org_id, name) values ($1, 'w-${suffix}') returning id`,
              [orgId],
            )
          ).rows[0]!.id;
          const projectId = (
            await client.query<{ id: string }>(
              `insert into projects (org_id, workspace_id, name, preview_label)
               values ($1, $2, 'p', 'domains-probe-' || gen_random_uuid()) returning id`,
              [orgId, workspaceId],
            )
          ).rows[0]!.id;
          orgs.push(orgId);
          projects.push(projectId);
        }
        await probe(client, {
          orgs: [orgs[0]!, orgs[1]!],
          projects: [projects[0]!, projects[1]!],
        });
      } finally {
        await client.query('rollback');
        client.release();
      }
    }

    async function attempt(
      client: pg.PoolClient,
      statement: string,
      values: unknown[],
    ): Promise<pg.DatabaseError | undefined> {
      await client.query('savepoint probe');
      try {
        await client.query(statement, values);
        await client.query('release savepoint probe');
        return undefined;
      } catch (caught: unknown) {
        await client.query('rollback to savepoint probe');
        return caught as pg.DatabaseError;
      }
    }

    async function asTenant(client: pg.PoolClient, orgId: string): Promise<void> {
      await client.query(`select set_config('app.org_id', $1, true)`, [orgId]);
    }

    const insertDomain = `insert into domains
        (org_id, project_id, hostname, state, failure_reason, ownership_token, ownership_verified_at,
         edge_id, certificate_active_at, activated_at, window_started_at, next_check_at)
      values ($1, $2, $3, $4, $5, '${token}', $6, $7, $8, $9, now(), now())`;

    it('refuses an active domain without certificate_active_at (FR-009)', async () => {
      await withSeed(async (client, { orgs, projects }) => {
        await asTenant(client, orgs[0]);

        const refused = await attempt(client, insertDomain, [
          orgs[0],
          projects[0],
          'www.fr009.example',
          'active',
          null,
          new Date(),
          'edge-1',
          null,
          new Date(),
        ]);

        expect(refused?.code).toBe('23514');
        expect(refused?.constraint).toBe('domains_serving_proven_check');

        const accepted = await attempt(client, insertDomain, [
          orgs[0],
          projects[0],
          'www.fr009.example',
          'active',
          null,
          new Date(),
          'edge-1',
          new Date(),
          new Date(),
        ]);

        expect(accepted).toBeUndefined();
      });
    });

    it('holds a live hostname across organisations, and lets a failed or removed one go', async () => {
      await withSeed(async (client, { orgs, projects }) => {
        const hostname = 'shop.held.example';

        await asTenant(client, orgs[0]);
        expect(
          await attempt(client, insertDomain, [
            orgs[0],
            projects[0],
            hostname,
            'pending',
            null,
            null,
            null,
            null,
            null,
          ]),
        ).toBeUndefined();

        await asTenant(client, orgs[1]);
        const taken = await attempt(client, insertDomain, [
          orgs[1],
          projects[1],
          hostname,
          'pending',
          null,
          null,
          null,
          null,
          null,
        ]);

        expect(taken?.code).toBe('23505');
        expect(taken?.constraint).toBe('domains_hostname_live_key');

        expect(
          await attempt(client, insertDomain, [
            orgs[1],
            projects[1],
            hostname,
            'failed',
            'verification-timeout',
            null,
            null,
            null,
            null,
          ]),
        ).toBeUndefined();
        expect(
          await attempt(client, insertDomain, [
            orgs[1],
            projects[1],
            hostname,
            'removed',
            null,
            null,
            null,
            null,
            null,
          ]),
        ).toBeUndefined();
      });
    });
  });

  /**
   * Spec 029 (0039): the redelivery probe runs before there is a tenant to set, so forge_bypass
   * reads exactly six columns of `webhook_sends`. The signed body is tenant data it never sees, and
   * it has nothing at all on the endpoints, which reference signing secrets.
   */
  it('lets forge_bypass read the six probe columns of webhook_sends, and refuses body', async () => {
    const allowed = await bypassPool.query(
      'select id, org_id, state, next_attempt_at, claimed_until, created_at from webhook_sends limit 0',
    );

    expect(allowed.rowCount).toBe(0);

    const error = await bypassPool
      .query('select body from webhook_sends limit 0')
      .then(() => undefined)
      .catch((caught: unknown) => caught as pg.DatabaseError);

    expect(error?.code).toBe('42501');
    expect(error?.message).toMatch(/permission denied for (column body|table webhook_sends)/);
  });

  it.each(['webhook_endpoints', 'webhook_endpoint_projects', 'webhook_send_attempts'])(
    'denies forge_bypass any read of %s',
    async (table) => {
      expect(bypassPrivileges.find((row) => row.tableName === table)).toMatchObject({
        hasDelete: false,
        hasInsert: false,
        hasSelect: false,
        hasUpdate: false,
      });

      const error = await bypassPool
        .query(`select 1 from ${table} limit 0`)
        .then(() => undefined)
        .catch((caught: unknown) => caught as pg.DatabaseError);

      expect(error?.code).toBe('42501');
      expect(error?.message).toMatch(new RegExp(`permission denied for table ${table}`));
    },
  );

  /**
   * Spec 029's database-held invariants (data-model.md §§ 1-2), proved by the database refusing
   * them. Seeded as the migrator in one transaction and rolled back; each probe runs under a
   * savepoint so a refusal does not end the transaction.
   */
  describe('webhook invariants', () => {
    async function withEndpoint(
      probe: (
        client: pg.PoolClient,
        seed: { endpointId: string; orgId: string; secretId: string },
      ) => Promise<void>,
    ): Promise<void> {
      const client = await migratorPool.connect();
      try {
        await client.query('begin');
        const orgId = (
          await client.query<{ id: string }>(
            `insert into orgs (name, slug) values ('webhooks-probe', 'webhooks-probe-' || gen_random_uuid()) returning id`,
          )
        ).rows[0]!.id;
        await client.query(`select set_config('app.org_id', $1, true)`, [orgId]);
        const dekId = (
          await client.query<{ id: string }>(
            `insert into org_data_keys (org_id, alg, kek_id, wrapped_dek)
             values ($1, 'probe', 'probe', '\\x00') returning id`,
            [orgId],
          )
        ).rows[0]!.id;
        const secretId = (
          await client.query<{ id: string }>(
            `insert into secrets (org_id, dek_id, alg, ciphertext, fingerprint, purpose)
             values ($1, $2, 'probe', '\\x00', 'probe', 'webhook:signing-secret') returning id`,
            [orgId, dekId],
          )
        ).rows[0]!.id;
        const endpointId = (
          await client.query<{ id: string }>(
            `insert into webhook_endpoints (org_id, url, event_types, state, secret_id, created_by)
             values ($1, 'https://hooks.example.com/x', '{deploy.succeeded}', 'enabled', $2, gen_random_uuid())
             returning id`,
            [orgId, secretId],
          )
        ).rows[0]!.id;
        await probe(client, { endpointId, orgId, secretId });
      } finally {
        await client.query('rollback');
        client.release();
      }
    }

    async function attempt(
      client: pg.PoolClient,
      statement: string,
      values: unknown[],
    ): Promise<pg.DatabaseError | undefined> {
      await client.query('savepoint probe');
      try {
        await client.query(statement, values);
        await client.query('release savepoint probe');
        return undefined;
      } catch (caught: unknown) {
        await client.query('rollback to savepoint probe');
        return caught as pg.DatabaseError;
      }
    }

    it('refuses a previous secret without its expiry, and an expiry without the secret', async () => {
      await withEndpoint(async (client, { endpointId, secretId }) => {
        const update = `update webhook_endpoints
            set previous_secret_id = $2, previous_secret_expires_at = $3 where id = $1`;

        for (const values of [
          [endpointId, secretId, null],
          [endpointId, null, new Date()],
        ]) {
          const refused = await attempt(client, update, values);

          expect(refused?.code).toBe('23514');
          expect(refused?.constraint).toBe('webhook_endpoints_previous_secret_check');
        }

        expect(await attempt(client, update, [endpointId, secretId, new Date()])).toBeUndefined();
        expect(await attempt(client, update, [endpointId, null, null])).toBeUndefined();
      });
    });

    it('sets paused_at exactly when the endpoint is paused', async () => {
      await withEndpoint(async (client, { endpointId }) => {
        const update = `update webhook_endpoints set state = $2, paused_at = $3 where id = $1`;

        for (const values of [
          [endpointId, 'paused', null],
          [endpointId, 'enabled', new Date()],
          [endpointId, 'disabled', new Date()],
        ]) {
          const refused = await attempt(client, update, values);

          expect(refused?.code).toBe('23514');
          expect(refused?.constraint).toBe('webhook_endpoints_paused_check');
        }

        expect(await attempt(client, update, [endpointId, 'paused', new Date()])).toBeUndefined();
      });
    });

    const insertSend = `insert into webhook_sends
        (org_id, endpoint_id, event_id, event_type, occurred_at, state, next_attempt_at)
      values ($1, $2, $3, 'deploy.succeeded', now(), $4, $5)`;

    it('sets next_attempt_at exactly when the send is pending', async () => {
      await withEndpoint(async (client, { endpointId, orgId }) => {
        for (const [state, next] of [
          ['pending', null],
          ['succeeded', new Date()],
          ['failed', new Date()],
          ['not_sent', new Date()],
        ] as const) {
          const refused = await attempt(client, insertSend, [
            orgId,
            endpointId,
            randomUUID(),
            state,
            next,
          ]);

          expect(refused?.code).toBe('23514');
          expect(refused?.constraint).toBe('webhook_sends_next_attempt_check');
        }

        expect(
          await attempt(client, insertSend, [
            orgId,
            endpointId,
            randomUUID(),
            'pending',
            new Date(),
          ]),
        ).toBeUndefined();
      });
    });

    it('refuses a second send of the same event to the same endpoint (FR-011)', async () => {
      await withEndpoint(async (client, { endpointId, orgId }) => {
        const eventId = randomUUID();

        expect(
          await attempt(client, insertSend, [orgId, endpointId, eventId, 'pending', new Date()]),
        ).toBeUndefined();

        const duplicate = await attempt(client, insertSend, [
          orgId,
          endpointId,
          eventId,
          'pending',
          new Date(),
        ]);

        expect(duplicate?.code).toBe('23505');
        expect(duplicate?.constraint).toBe('webhook_sends_endpoint_id_event_id_key');
      });
    });
  });

  it('grants forge_app select and insert on checkpoints, and no table-level update or delete', () => {
    expect(privileges.find((row) => row.tableName === 'checkpoints')).toMatchObject({
      hasDelete: false,
      hasInsert: true,
      hasSelect: true,
      hasUpdate: false,
    });
  });

  it('lets forge_app set checkpoints.mirrored_at, and refuses every other UPDATE and a DELETE', async () => {
    const allowed = await appPool.query('update checkpoints set mirrored_at = now()');

    expect(allowed.rowCount).toBe(0);

    for (const statement of [
      `update checkpoints set label = 'tampered'`,
      'delete from checkpoints',
    ]) {
      const error = await appPool
        .query(statement)
        .then(() => undefined)
        .catch((caught: unknown) => caught as pg.DatabaseError);

      expect(error?.code, `${statement} was NOT refused`).toBe('42501');
    }
  });

  /**
   * Spec 031 (research R6, 0045): the self-read clause, proved as the role it names. A guest's
   * `GET /orgs` sets `app.user_id` and no `app.org_id`, and must find their own grants; the same
   * transaction must not be able to write one, because `WITH CHECK` stays org-only.
   */
  it('project_grants is readable by app.user_id with app.org_id unset, and not writable that way', async () => {
    const seed = await migratorPool.connect();
    let orgId: string | undefined;
    let userId: string | undefined;
    try {
      await seed.query('begin');
      orgId = (
        await seed.query<{ id: string }>(
          `insert into orgs (name, slug) values ('grant-probe', 'grant-probe-' || gen_random_uuid()) returning id`,
        )
      ).rows[0]!.id;
      userId = (
        await seed.query<{ id: string }>(
          `insert into users (email, password_hash) values ('grant-probe-' || gen_random_uuid() || '@example.test', 'x') returning id`,
        )
      ).rows[0]!.id;
      await seed.query(`select set_config('app.org_id', $1, true)`, [orgId]);
      const workspaceId = (
        await seed.query<{ id: string }>(
          `insert into workspaces (org_id, name) values ($1, 'w') returning id`,
          [orgId],
        )
      ).rows[0]!.id;
      const projectId = (
        await seed.query<{ id: string }>(
          `insert into projects (org_id, workspace_id, name, preview_label)
           values ($1, $2, 'p', 'grant-probe-' || gen_random_uuid()) returning id`,
          [orgId, workspaceId],
        )
      ).rows[0]!.id;
      await seed.query(
        `insert into project_grants (org_id, project_id, user_id, role) values ($1, $2, $3, 'viewer')`,
        [orgId, projectId, userId],
      );
      await seed.query('commit');

      const client = await appPool.connect();
      try {
        await client.query('begin');
        await client.query(`select set_config('app.user_id', $1, true)`, [userId]);

        const read = await client.query(`select org_id from project_grants`);
        expect(read.rows).toEqual([{ org_id: orgId }]);

        await client.query('savepoint probe');
        const refused = await client
          .query(
            `insert into project_grants (org_id, project_id, user_id, role) values ($1, $2, $3, 'owner')`,
            [orgId, projectId, userId],
          )
          .then(
            () => undefined,
            (caught: unknown) => caught as pg.DatabaseError,
          );
        expect(refused?.code).toBe('42501');
        await client.query('rollback to savepoint probe');

        await client.query('savepoint probe');
        const unwritable = await client.query(`update project_grants set role = 'owner'`).then(
          () => undefined,
          (caught: unknown) => caught as pg.DatabaseError,
        );
        expect(unwritable?.code).toBe('42501');
        await client.query('rollback to savepoint probe');
      } finally {
        await client.query('rollback');
        client.release();
      }
    } finally {
      await seed.query('rollback').catch(() => undefined);
      if (orgId !== undefined) {
        await seed.query(`delete from orgs where id = $1`, [orgId]);
      }
      if (userId !== undefined) {
        await seed.query(`delete from users where id = $1`, [userId]);
      }
      seed.release();
    }
  });

  /**
   * The same statement shape on a table that is not append-only, so the two tests above are read as
   * "audit_log specifically" rather than "forge_app has no rights". It affects zero rows because no
   * tenant context is set — which is the §09 property T06 asserts in its own right.
   */
  it('still allows forge_app to UPDATE a table that is not append-only', async () => {
    const result = await appPool.query(`update workspaces set name = 'x'`);

    expect(result.rowCount).toBe(0);
  });

  /**
   * Spec 018 / migration 0024: the composite FK from `sync_operations` to `repo_links` nulls
   * `link_id` and only `link_id` when the link goes. A plain composite SET NULL would take
   * `org_id` with it and fail on the NOT NULL (23502) — which is what 0023 shipped and the code
   * worked around. Seeded and rolled back in one transaction, so nothing is left behind.
   */
  it('keeps org_id on a sync_operation whose repo_link is deleted, nulling only link_id', async () => {
    const client = await migratorPool.connect();
    try {
      await client.query('begin');
      const orgId = (
        await client.query<{ id: string }>(
          `insert into orgs (name, slug) values ('fk-probe', 'fk-probe-' || gen_random_uuid()) returning id`,
        )
      ).rows[0]!.id;
      await client.query(`select set_config('app.org_id', $1, true)`, [orgId]);
      const userId = (
        await client.query<{ id: string }>(
          `insert into users (email) values ('fk-probe-' || gen_random_uuid() || '@example.test') returning id`,
        )
      ).rows[0]!.id;
      const workspaceId = (
        await client.query<{ id: string }>(
          `insert into workspaces (org_id, name) values ($1, 'w') returning id`,
          [orgId],
        )
      ).rows[0]!.id;
      const projectId = (
        await client.query<{ id: string }>(
          `insert into projects (org_id, workspace_id, name, preview_label)
           values ($1, $2, 'p', 'fk-probe-' || gen_random_uuid()) returning id`,
          [orgId, workspaceId],
        )
      ).rows[0]!.id;
      const linkId = (
        await client.query<{ id: string }>(
          `insert into repo_links (org_id, project_id, linked_by, owner, name, branch, repo_id, state)
           values ($1, $2, $3, 'o', 'r', 'main', 1, 'disconnected') returning id`,
          [orgId, projectId, userId],
        )
      ).rows[0]!.id;
      const operationId = (
        await client.query<{ id: string }>(
          `insert into sync_operations (org_id, project_id, link_id, requested_by, kind, state)
           values ($1, $2, $3, $4, 'push', 'succeeded') returning id`,
          [orgId, projectId, linkId, userId],
        )
      ).rows[0]!.id;

      await client.query('delete from repo_links where id = $1', [linkId]);

      const survivor = await client.query<{ org_id: string; link_id: string | null }>(
        'select org_id, link_id from sync_operations where id = $1',
        [operationId],
      );

      expect(survivor.rows).toEqual([{ org_id: orgId, link_id: null }]);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});
