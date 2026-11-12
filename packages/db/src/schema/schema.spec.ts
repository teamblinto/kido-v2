import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrationDatabaseUrl } from '../env';

const { Pool } = pg;

interface ColumnRow {
  columnName: string;
  isNullable: 'NO' | 'YES';
  tableName: string;
  udtName: string;
}

interface ForeignKeyRow {
  childTable: string;
  columnCount: number;
  constraintName: string;
  parentTable: string;
}

interface IndexRow {
  definition: string;
  tableName: string;
}

interface KeyConstraintRow {
  columnNames: string[];
  constraintName: string;
  tableName: string;
}

/** A partitioned parent and the column it ranges on; `partitions` are its children. */
interface PartitionRow {
  partitionColumn: string;
  partitions: string[];
  tableName: string;
}

const EXPECTED_TENANT_OWNED_TABLES = [
  // Spec 008. `run_events` is the first partitioned tenant-owned table (ADR 032); its partitions
  // are not tables in their own right here and are excluded by `relispartition` below.
  'agent_runs',
  'audit_log',
  // Spec 016. Immutable history: insert-only by grant (`0018_checkpoints_are_append_only.sql`).
  'checkpoints',
  // Spec 018. The connector, its links and their operations (`0021_connectors_are_tenant_owned.sql`).
  'connections',
  // Spec 030. A project's provider binding, what the platform created in the provider, and the
  // queued provider writes (`0042_connector_bindings_are_tenant_owned.sql`).
  'connector_bindings',
  'connector_operations',
  'connector_resources',
  // Spec 027. A deploy and the release pointer (`0034_deploys_are_tenant_owned.sql`).
  'deployments',
  // Spec 028. A custom hostname on a project (`0036_domains_are_tenant_owned.sql`).
  'domains',
  'invitations',
  // Spec 040. Which device ran a run, keyed by the run (`0051_local_agent_runs_are_tenant_owned.sql`).
  'local_agent_runs',
  // Spec 046. One person's consent for one MCP client in one org (`0059_mcp_grants_are_tenant_owned.sql`).
  'mcp_grants',
  'memberships',
  'org_data_keys',
  // Spec 021. One row per project, keyed by the project (`0028_project_context_is_tenant_owned.sql`).
  'project_context',
  'project_grants',
  // Spec 031. A project's own invitations (research R5, `0045_project_invitations_and_grant_self_read.sql`).
  'project_invitations',
  'project_sites',
  'projects',
  // Spec 020. One organisation key per provider (`0026_provider_keys_are_tenant_owned.sql`).
  'provider_keys',
  'repo_links',
  'run_events',
  'run_messages',
  'sandboxes',
  'secrets',
  'sync_operations',
  // Spec 029. Outbound endpoints, their scope, sends and attempts
  // (`0039_webhook_endpoints_are_tenant_owned.sql`).
  'webhook_endpoint_projects',
  'webhook_endpoints',
  'webhook_send_attempts',
  'webhook_sends',
  // T27. §11's third scope finally has somewhere to live: "workspace — admin, editor, viewer".
  // `permissions.ts` held that vocabulary in TypeScript until the schema caught up, and said so.
  'workspace_members',
  'workspaces',
];

/**
 * `orgs` and `users` are the two roots T04 established. T05 adds four more, and they are roots for
 * the same reason `users` is: they belong to a person rather than to a tenant, and the flows that
 * read them run before there is a tenant context to set. Argued in
 * `docs/adr/015-account-scoped-auth-tables-are-roots.md`.
 */
const ROOT_TABLES = [
  // Spec 041. A person's cloud agent home (ADR 015).
  'agent_homes',
  'email_verification_tokens',
  // Spec 032. A person's linked subscription (ADR 015).
  'linked_accounts',
  // Spec 040. A person's paired companion (ADR 015).
  'local_agent_devices',
  // Spec 046. A dynamically registered MCP OAuth client: belongs to no person or org (0059).
  'mcp_clients',
  'mfa_recovery_codes',
  'oauth_identities',
  'orgs',
  'password_reset_tokens',
  'users',
];

const pool = new Pool({
  connectionString: migrationDatabaseUrl(),
  connectionTimeoutMillis: 3_000,
  max: 1,
});

async function isReachable(): Promise<boolean> {
  try {
    await pool.query('select 1');
    return true;
  } catch {
    return false;
  }
}

function redactedUrl(): string {
  return migrationDatabaseUrl().replace(/:\/\/[^@]*@/, '://***@');
}

function hasUniqueIndex(indexes: IndexRow[], tableName: string, columnName: string): boolean {
  return indexes.some(
    (row) =>
      row.tableName === tableName &&
      row.definition.toLowerCase().includes('unique index') &&
      row.definition.includes(`(${columnName})`),
  );
}

/**
 * The key rule, as one function so the probe below can run it against a table it just created.
 *
 * Every tenant-owned table carries a two-column unique key on exactly `(org_id, id)` — except a
 * partitioned one, where Postgres requires the partition column inside every unique constraint and
 * `(org_id, id)` therefore cannot exist (ADR 016 foresaw it; ADR 032 decides it). A partitioned
 * table passes with a *primary key* that begins with `org_id` and ends with its partition column:
 * led by the tenant so the index is tenant-first, closed by the partition column because that is
 * the one column Postgres forces in. A table with no `id` at all (spec 021's `project_context`:
 * one row per project, keyed by the project) passes with a two-column *primary key* led by
 * `org_id` — the same tenant-first shape, with the parent's id where its own would be. Anything
 * else — an `id`-led key, a unique key that is not the primary key, no key at all — is an
 * offender, which is what the probe tests prove.
 */
function keyRuleOffenders(
  tables: readonly string[],
  keyConstraints: readonly KeyConstraintRow[],
  partitioned: readonly PartitionRow[],
  idless: readonly string[] = [],
): string[] {
  return tables.filter((table) => {
    const keys = keyConstraints.filter((row) => row.tableName === table);
    const parent = partitioned.find((row) => row.tableName === table);

    if (idless.includes(table)) {
      return !keys.some(
        (row) =>
          row.constraintName.endsWith('_pkey') &&
          row.columnNames.length === 2 &&
          row.columnNames[0] === 'org_id',
      );
    }

    if (parent === undefined) {
      return (
        keys.filter(
          (row) =>
            row.columnNames.length === 2 &&
            row.columnNames.includes('id') &&
            row.columnNames.includes('org_id'),
        ).length !== 1
      );
    }

    return !keys.some(
      (row) =>
        row.constraintName.endsWith('_pkey') &&
        row.columnNames[0] === 'org_id' &&
        row.columnNames.at(-1) === parent.partitionColumn,
    );
  });
}

/** `pg_partitioned_table` joined to its children: the parents, their range column, their partitions. */
async function partitionedTables(): Promise<PartitionRow[]> {
  const result = await pool.query<PartitionRow>(
    `select p.partrelid::regclass::text                          as "tableName",
            a.attname                                            as "partitionColumn",
            coalesce(array_agg(i.inhrelid::regclass::text order by i.inhrelid::regclass::text)
              filter (where i.inhrelid is not null), '{}')      as "partitions"
       from pg_partitioned_table p
       join pg_attribute a on a.attrelid = p.partrelid and a.attnum = p.partattrs[0]
       left join pg_inherits i on i.inhparent = p.partrelid
      group by p.partrelid, a.attname
      order by 1`,
  );

  return result.rows;
}

/** Unique and primary keys, columns in declared order — the partitioned rule reads first and last. */
async function keyConstraintRows(): Promise<KeyConstraintRow[]> {
  const result = await pool.query<KeyConstraintRow>(
    // column_name is information_schema.sql_identifier, a domain the pg driver does not know how
    // to parse in array form — cast to text so the row arrives as string[] rather than "{a,b}".
    `select tc.table_name                                                   as "tableName",
            tc.constraint_name                                              as "constraintName",
            array_agg(kcu.column_name::text order by kcu.ordinal_position) as "columnNames"
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on kcu.constraint_schema = tc.constraint_schema
        and kcu.constraint_name = tc.constraint_name
      where tc.constraint_type in ('PRIMARY KEY', 'UNIQUE')
        and tc.table_schema = 'public'
      group by tc.table_name, tc.constraint_name
      order by tc.table_name, tc.constraint_name`,
  );

  return result.rows;
}

const databaseReachable = await isReachable();

if (!databaseReachable) {
  if (process.env.EXPECT_INTEGRATION === '1') {
    await pool.end();
    throw new Error(
      `EXPECT_INTEGRATION=1 but Postgres is unreachable at ${redactedUrl()} — ` +
        'CI must not skip the composite-key gate.',
    );
  }

  console.warn(
    [
      '',
      '='.repeat(100),
      `SKIPPING the composite-foreign-key gate: Postgres is unreachable at ${redactedUrl()}.`,
      'Start it with `docker compose up -d postgres`, then `pnpm --filter @repo/db db:migrate`,',
      'or point DATABASE_MIGRATION_URL somewhere else.',
      'CI runs this suite with EXPECT_INTEGRATION=1, where an unreachable database is a failure.',
      '='.repeat(100),
      '',
    ].join('\n'),
  );

  await pool.end();
}

/**
 * The composite-key gate.
 *
 * §09: "Foreign keys are composite. A child row references (org_id, project_id), not project_id
 * alone, with the matching composite unique key on the parent. Single-column FKs are checked by the
 * system with RLS bypassed, so a cross-tenant reference can be created and then merely rendered
 * invisible by RLS — an orphan that surfaces later in a background job or an export."
 *
 * These assertions read `information_schema` rather than the TypeScript schema on purpose: it is
 * the shipped database that has to be right, and the hand-written migrations from T05 onwards add
 * objects the Drizzle schema never sees. "Tenant-owned" is derived from the database too — any
 * table carrying an `org_id` column — so a new table cannot escape the rule by being forgotten.
 */
describe.skipIf(!databaseReachable)('database schema', () => {
  let columns: ColumnRow[] = [];
  let foreignKeys: ForeignKeyRow[] = [];
  let indexes: IndexRow[] = [];
  let keyConstraints: KeyConstraintRow[] = [];
  let partitioned: PartitionRow[] = [];
  let tenantOwnedTables: string[] = [];

  beforeAll(async () => {
    const columnResult = await pool.query<ColumnRow>(
      `select table_name  as "tableName",
              column_name as "columnName",
              is_nullable as "isNullable",
              udt_name    as "udtName"
         from information_schema.columns
        where table_schema = 'public'
        order by table_name, column_name`,
    );

    if (columnResult.rows.length === 0) {
      throw new Error('Schema "public" is empty — run `pnpm --filter @repo/db db:migrate` first.');
    }

    partitioned = await partitionedTables();

    // A partition is storage for its parent, not a table of its own: it has the parent's columns,
    // inherits its constraints, and is never named by the application. Dropping it here keeps every
    // column-derived list — tenant-owned, soft-deleted — a list of tables somebody declared.
    const partitions = new Set(partitioned.flatMap((row) => row.partitions));

    columns = columnResult.rows.filter((row) => !partitions.has(row.tableName));
    tenantOwnedTables = [
      ...new Set(columns.filter((row) => row.columnName === 'org_id').map((row) => row.tableName)),
    ].sort();

    const foreignKeyResult = await pool.query<ForeignKeyRow>(
      `select tc.table_name                        as "childTable",
              tc.constraint_name                   as "constraintName",
              ccu.table_name                       as "parentTable",
              count(distinct kcu.column_name)::int as "columnCount"
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on kcu.constraint_schema = tc.constraint_schema
          and kcu.constraint_name = tc.constraint_name
         join information_schema.constraint_column_usage ccu
           on ccu.constraint_schema = tc.constraint_schema
          and ccu.constraint_name = tc.constraint_name
        where tc.constraint_type = 'FOREIGN KEY'
          and tc.table_schema = 'public'
        group by tc.table_name, tc.constraint_name, ccu.table_name
        order by tc.table_name, tc.constraint_name`,
    );

    foreignKeys = foreignKeyResult.rows;

    keyConstraints = await keyConstraintRows();

    const indexResult = await pool.query<IndexRow>(
      `select tablename as "tableName", indexdef as "definition"
         from pg_indexes
        where schemaname = 'public'
        order by tablename, indexname`,
    );

    indexes = indexResult.rows;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('classifies exactly the expected tables as tenant-owned', () => {
    expect(tenantOwnedTables).toEqual(EXPECTED_TENANT_OWNED_TABLES);
  });

  it('keeps the tenancy roots free of org_id', () => {
    for (const table of ROOT_TABLES) {
      expect(tenantOwnedTables).not.toContain(table);
    }
  });

  it('rejects any single-column foreign key between two tenant-owned tables', () => {
    const offenders = foreignKeys.filter(
      (row) =>
        tenantOwnedTables.includes(row.childTable) &&
        tenantOwnedTables.includes(row.parentTable) &&
        row.childTable !== row.parentTable &&
        row.columnCount < 2,
    );

    expect(
      offenders.map((row) => `${row.childTable}.${row.constraintName} -> ${row.parentTable}`),
    ).toEqual([]);
  });

  it('has composite foreign keys, so the gate above is not vacuous', () => {
    const composite = foreignKeys
      .filter(
        (row) =>
          tenantOwnedTables.includes(row.childTable) &&
          tenantOwnedTables.includes(row.parentTable) &&
          row.columnCount >= 2,
      )
      .map((row) => row.constraintName)
      .sort();

    expect(composite).toEqual([
      'agent_runs_org_id_project_id_fk',
      'agent_runs_org_id_summary_through_message_id_fk',
      'checkpoints_org_id_parent_id_fk',
      'checkpoints_org_id_project_id_fk',
      'checkpoints_org_id_reverts_id_fk',
      'checkpoints_org_id_sync_operation_id_fk',
      'connections_org_id_secret_id_fk',
      'connector_bindings_org_id_connection_id_fk',
      'connector_bindings_org_id_project_id_fk',
      'connector_operations_org_id_binding_id_fk',
      'connector_operations_org_id_deployment_id_fk',
      'connector_operations_org_id_domain_id_fk',
      'connector_operations_org_id_project_id_fk',
      'connector_operations_org_id_resource_id_fk',
      'connector_resources_org_id_binding_id_fk',
      'connector_resources_org_id_connection_id_fk',
      'connector_resources_org_id_domain_id_fk',
      'connector_resources_org_id_secret_id_fk',
      'deployments_org_id_checkpoint_id_fk',
      'deployments_org_id_project_id_fk',
      'domains_org_id_project_id_fk',
      'local_agent_runs_org_id_run_id_fk',
      'project_context_org_id_project_id_fk',
      'project_grants_org_id_project_id_fk',
      'project_invitations_org_id_project_id_fk',
      'project_sites_org_id_current_deployment_id_fk',
      'project_sites_org_id_project_id_fk',
      'projects_org_id_workspace_id_fk',
      'provider_keys_org_id_secret_id_fk',
      'repo_links_org_id_connection_id_fk',
      'repo_links_org_id_last_pushed_checkpoint_id_fk',
      'repo_links_org_id_project_id_fk',
      'run_events_org_id_run_id_fk',
      'run_messages_org_id_run_id_fk',
      'sandboxes_org_id_project_id_fk',
      'secrets_org_id_dek_id_fk',
      'sync_operations_org_id_link_id_fk',
      'sync_operations_org_id_project_id_fk',
      'webhook_endpoint_projects_org_id_endpoint_id_fk',
      'webhook_endpoint_projects_org_id_project_id_fk',
      'webhook_endpoints_org_id_previous_secret_id_fk',
      'webhook_endpoints_org_id_secret_id_fk',
      'webhook_send_attempts_org_id_send_id_fk',
      'webhook_sends_org_id_endpoint_id_fk',
      'workspace_members_org_id_workspace_id_fk',
    ]);
  });

  it('gives every tenant-owned table a unique key on (org_id, id) to reference', () => {
    const withId = new Set(
      columns.filter((row) => row.columnName === 'id').map((row) => row.tableName),
    );
    // A partitioned table has no `id` either, but its own rule above covers it.
    const idless = tenantOwnedTables.filter(
      (table) => !withId.has(table) && !partitioned.some((row) => row.tableName === table),
    );

    // The widening is bounded: these shipped tables are keyed by their parent instead of an id.
    expect(idless).toEqual(['local_agent_runs', 'project_context']);
    expect(keyRuleOffenders(tenantOwnedTables, keyConstraints, partitioned, idless)).toEqual([]);
  });

  /** The id-less widening is not vacuous either: a key not led by org_id is still an offender. */
  it('still fails an id-less tenant-owned table whose primary key is not led by org_id', async () => {
    await pool.query(
      `create table probe_idless (org_id uuid not null, project_id uuid not null,
         primary key (project_id, org_id))`,
    );

    try {
      expect(
        keyRuleOffenders(['probe_idless'], await keyConstraintRows(), partitioned, [
          'probe_idless',
        ]),
      ).toEqual(['probe_idless']);
    } finally {
      await pool.query('drop table probe_idless');
    }
  });

  /**
   * Spec 021 (data-model.md): `project_context` is keyed by `(org_id, project_id)` with a cascading
   * composite FK to `projects`; `agent_runs` carries the running summary, its marker (set null when
   * the message goes), the token estimate, the two cache counters and the skips list.
   */
  it('shapes project_context and the agent_runs summary columns per spec 021', async () => {
    const named = (table: string, name: string): ColumnRow | undefined =>
      columns.find((row) => row.tableName === table && row.columnName === name);

    expect(named('project_context', 'head_sha')?.isNullable).toBe('YES');
    expect(named('project_context', 'dirty_digest')?.isNullable).toBe('NO');
    expect(named('project_context', 'repo_map')?.udtName).toBe('text');
    expect(
      keyConstraints.find((row) => row.constraintName === 'project_context_pkey')?.columnNames,
    ).toEqual(['org_id', 'project_id']);

    expect(named('agent_runs', 'summary')?.isNullable).toBe('YES');
    expect(named('agent_runs', 'summary_through_message_id')?.udtName).toBe('uuid');
    expect(named('agent_runs', 'summary_tokens')?.udtName).toBe('int4');
    expect(named('agent_runs', 'cache_read_tokens')?.udtName).toBe('int8');
    expect(named('agent_runs', 'cache_write_tokens')?.udtName).toBe('int8');
    expect(named('agent_runs', 'context_skips')?.udtName).toBe('jsonb');

    // The marker's action names its column (0024's idiom): the tenant stays on the run.
    const rules = await pool.query<{ constraintName: string; definition: string }>(
      `select conname as "constraintName", pg_get_constraintdef(oid) as "definition"
         from pg_constraint
        where conname in
          ('project_context_org_id_project_id_fk', 'agent_runs_org_id_summary_through_message_id_fk')
        order by 1`,
    );

    expect(rules.rows.map((row) => row.constraintName)).toEqual([
      'agent_runs_org_id_summary_through_message_id_fk',
      'project_context_org_id_project_id_fk',
    ]);
    expect(rules.rows[0]?.definition).toContain('ON DELETE SET NULL (summary_through_message_id)');
    expect(rules.rows[1]?.definition).toContain('ON DELETE CASCADE');
  });

  /**
   * Spec 008 / ADR 032: the partitioned shape is stated, so the widening above is a rule and not
   * an exception list. Exactly one partitioned tenant-owned table exists today, it ranges on `at`,
   * has no `id`, and has the current month, the next and a DEFAULT partition from the migration
   * alone.
   */
  it('partitions run_events by at, with this month, next month and a default', () => {
    const parent = partitioned.find((row) => row.tableName === 'run_events');
    const month = (offset: number): string => {
      const date = new Date();
      date.setUTCDate(1);
      date.setUTCMonth(date.getUTCMonth() + offset);

      return `run_events_${String(date.getUTCFullYear())}_${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    };

    expect(partitioned.map((row) => row.tableName)).toEqual(['run_events']);
    expect(parent?.partitionColumn).toBe('at');
    expect(parent?.partitions).toEqual(
      expect.arrayContaining([month(0), month(1), 'run_events_default']),
    );
    expect(tenantOwnedTables).not.toContain('run_events_default');
    expect(columns.some((row) => row.tableName === 'run_events' && row.columnName === 'id')).toBe(
      false,
    );
  });

  /** SC-010: the partitioned primary key is the one index; every read is by run under a tenant. */
  it('indexes run_events exactly once, on its primary key', () => {
    const own = indexes.filter((row) => row.tableName === 'run_events');

    expect(own).toHaveLength(1);
    expect(own[0]?.definition).toContain('run_events_pkey');
  });

  /**
   * The widening is not vacuous: a partitioned tenant-owned table whose primary key is not led by
   * `org_id` is still an offender. Proven against a table created for the purpose and dropped
   * after, because no shipped table may be wrong in this way.
   */
  it('still fails a partitioned tenant-owned table whose key is not led by org_id', async () => {
    await pool.query(
      `create table probe_partitioned (
         org_id uuid not null, id uuid not null, at timestamptz not null,
         primary key (id, at)
       ) partition by range (at)`,
    );

    try {
      expect(
        keyRuleOffenders(
          ['probe_partitioned'],
          await keyConstraintRows(),
          await partitionedTables(),
        ),
      ).toEqual(['probe_partitioned']);
    } finally {
      await pool.query('drop table probe_partitioned');
    }
  });

  it('gives every tenant-owned table a non-null org_id, created_at and updated_at', () => {
    for (const table of tenantOwnedTables) {
      const named = (name: string): ColumnRow | undefined =>
        columns.find((row) => row.tableName === table && row.columnName === name);

      expect(named('org_id')?.isNullable, `${table}.org_id`).toBe('NO');
      expect(named('created_at')?.isNullable, `${table}.created_at`).toBe('NO');
      expect(named('updated_at')?.isNullable, `${table}.updated_at`).toBe('NO');
    }
  });

  it('carries deleted_at on the restorable tables and nowhere else', () => {
    const softDeleted = [
      ...new Set(
        columns.filter((row) => row.columnName === 'deleted_at').map((row) => row.tableName),
      ),
    ].sort();

    expect(softDeleted).toEqual(['orgs', 'projects', 'workspaces']);
  });

  it('stores emails as citext with a unique index', () => {
    const email = columns.find((row) => row.tableName === 'users' && row.columnName === 'email');

    expect(email?.udtName).toBe('citext');
    expect(email?.isNullable).toBe('NO');
    expect(hasUniqueIndex(indexes, 'users', 'email')).toBe(true);
  });

  it('keeps preview_label globally unique for the route broker', () => {
    expect(hasUniqueIndex(indexes, 'projects', 'preview_label')).toBe(true);
  });

  /**
   * Spec 017 (data-model.md § projects — one new column): `preview_visibility` is a three-value
   * enum, `not null default 'private'` with no backfill, so an existing row is the most
   * restrictive value there is.
   */
  it('gives projects a preview_visibility enum, not null, defaulting to private', async () => {
    const column = columns.find(
      (row) => row.tableName === 'projects' && row.columnName === 'preview_visibility',
    );

    expect(column?.udtName).toBe('preview_visibility');
    expect(column?.isNullable).toBe('NO');

    const defaultValue = await pool.query<{ columnDefault: string | null }>(
      `select column_default as "columnDefault"
         from information_schema.columns
        where table_schema = 'public' and table_name = 'projects'
          and column_name = 'preview_visibility'`,
    );

    expect(defaultValue.rows[0]?.columnDefault).toContain("'private'");

    const enumValues = await pool.query<{ label: string }>(
      `select enumlabel as "label"
         from pg_enum
        where enumtypid = 'preview_visibility'::regtype
        order by enumsortorder`,
    );

    expect(enumValues.rows.map((row) => row.label)).toEqual(['private', 'org', 'public']);
  });

  /**
   * Spec 005 FR-003a: the outbox and its processed-events ledger are platform tables. They must
   * exist, sit outside the tenant-owned derivation above (so no `org_id` column — the originating
   * organisation is `origin_org_id`), and carry the three shapes the relay and the consumer base
   * rely on: an always-generated identity for order, a composite primary key for idempotency, and
   * a partial index over the unpublished rows.
   */
  it('creates outbox and processed_events as platform tables, outside the tenant gate', async () => {
    const tables = new Set(columns.map((row) => row.tableName));

    expect(tables.has('outbox'), 'outbox missing').toBe(true);
    expect(tables.has('processed_events'), 'processed_events missing').toBe(true);
    expect(tenantOwnedTables).not.toContain('outbox');
    expect(tenantOwnedTables).not.toContain('processed_events');

    const seq = await pool.query<{ identityGeneration: string | null }>(
      `select identity_generation as "identityGeneration"
         from information_schema.columns
        where table_schema = 'public' and table_name = 'outbox' and column_name = 'seq'`,
    );

    expect(seq.rows[0]?.identityGeneration, 'outbox.seq is not an identity').toBe('ALWAYS');

    const processedKey = keyConstraints.find(
      (row) => row.tableName === 'processed_events' && row.constraintName.endsWith('_pk'),
    );

    expect(processedKey?.columnNames).toEqual(['consumer', 'event_id']);

    const unpublished = indexes.find((row) =>
      row.definition.includes('outbox_unpublished_seq_idx'),
    );

    expect(unpublished?.definition).toMatch(/\(seq\) WHERE \(published_at IS NULL\)/);
  });

  /** Spec 031 (data-model § 1): the holder backstop and the line's read, both partial. */
  it('project_invitations has unique (org_id, id) and the open-invitation partial unique', () => {
    const on = indexes.filter((row) => row.tableName === 'project_invitations');

    expect(on.map((row) => row.definition)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/UNIQUE INDEX .* \(org_id, id\)$/),
        expect.stringMatching(/UNIQUE INDEX .* \(token_hash\)$/),
        expect.stringMatching(
          /UNIQUE INDEX .* \(org_id, project_id, email\) WHERE \(\(accepted_at IS NULL\) AND \(revoked_at IS NULL\)\)/,
        ),
      ]),
    );
  });

  it('creates the one-holder-per-project unique index and the line index on agent_runs', () => {
    const definitionOf = (name: string): string | undefined =>
      indexes.find((row) => row.definition.includes(` ${name} `))?.definition;
    const holder = definitionOf('agent_runs_one_holder_per_project');
    const line = definitionOf('agent_runs_line_idx');

    expect(holder).toMatch(/UNIQUE INDEX .*\(org_id, project_id\) WHERE .*started_at IS NOT NULL/);
    expect(line).toMatch(/\(org_id, project_id, created_at, id\) WHERE .*started_at IS NULL/);
  });

  /**
   * Spec 014 (data-model.md): the warm pool is two platform tables outside the tenant gate; the
   * claim fallback and the refill count walk `(template, state, ready_at)`; the scheduler's dedupe
   * lookup walks `outbox (type, aggregate_id)`.
   */
  it('creates linked_accounts and byos_providers per spec 032, and orgs.personal_accounts_allowed', () => {
    const column = (table: string, name: string): ColumnRow | undefined =>
      columns.find((row) => row.tableName === table && row.columnName === name);
    const definitionOf = (name: string): string | undefined =>
      indexes.find((row) => row.definition.includes(name))?.definition;

    expect(tenantOwnedTables).not.toContain('linked_accounts');
    expect(tenantOwnedTables).not.toContain('byos_providers');
    expect(column('linked_accounts', 'grant_sealed')).toMatchObject({
      isNullable: 'NO',
      udtName: 'bytea',
    });
    expect(column('linked_accounts', 'health')).toMatchObject({ udtName: 'connector_health' });
    expect(column('linked_accounts', 'provider')).toMatchObject({ udtName: 'llm_provider' });
    expect(column('linked_accounts', 'limited_until')).toMatchObject({ isNullable: 'YES' });
    expect(column('linked_accounts', 'access_expires_at')).toMatchObject({ isNullable: 'NO' });
    expect(column('byos_providers', 'status')).toMatchObject({ udtName: 'byos_provider_status' });
    expect(column('byos_providers', 'withdrawn_at')).toMatchObject({ isNullable: 'YES' });
    expect(column('orgs', 'personal_accounts_allowed')).toMatchObject({
      isNullable: 'NO',
      udtName: 'bool',
    });
    expect(
      keyConstraints.find((row) => row.constraintName === 'linked_accounts_user_id_provider_key')
        ?.columnNames,
    ).toEqual(['user_id', 'provider']);
    expect(definitionOf('linked_accounts_provider_last_checked_at_idx')).toContain(
      '(provider, last_checked_at)',
    );
  });

  it('creates sandbox_pool and sandbox_pool_settings as platform tables, with their indexes', () => {
    const tables = new Set(columns.map((row) => row.tableName));
    const definitionOf = (name: string): string | undefined =>
      indexes.find((row) => row.definition.includes(name))?.definition;

    expect(tables.has('sandbox_pool'), 'sandbox_pool missing').toBe(true);
    expect(tables.has('sandbox_pool_settings'), 'sandbox_pool_settings missing').toBe(true);
    expect(tenantOwnedTables).not.toContain('sandbox_pool');
    expect(tenantOwnedTables).not.toContain('sandbox_pool_settings');
    expect(hasUniqueIndex(indexes, 'sandbox_pool', 'daytona_id')).toBe(true);
    expect(definitionOf('sandbox_pool_template_state_ready_at_idx')).toContain(
      '(template, state, ready_at)',
    );
    expect(definitionOf('outbox_type_aggregate_id_idx')).toContain('(type, aggregate_id)');
  });

  /**
   * Spec 015 (data-model.md § template_versions): the catalogue is a platform table keyed by
   * `(template, digest)`, unique on the snapshot name, with at most one current row per template
   * (partial unique index) and the two CHECKs of `0016_template_versions_grants.sql`;
   * `sandboxes.template_snapshot` records the version a sandbox was created from and
   * `sandbox_pool_settings.snapshot` is gone — the pool creates from the current version only.
   */
  it('creates template_versions as a platform table with its keys, index and checks', async () => {
    const tables = new Set(columns.map((row) => row.tableName));

    expect(tables.has('template_versions'), 'template_versions missing').toBe(true);
    expect(tenantOwnedTables).not.toContain('template_versions');
    expect(
      keyConstraints.find(
        (row) =>
          row.tableName === 'template_versions' && row.constraintName === 'template_versions_pk',
      )?.columnNames,
    ).toEqual(['template', 'digest']);
    expect(hasUniqueIndex(indexes, 'template_versions', 'snapshot')).toBe(true);
    expect(
      indexes.find((row) => row.definition.includes('template_versions_current_idx'))?.definition,
    ).toMatch(/UNIQUE INDEX .* \(template\) WHERE current/);

    const checks = await pool.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as "definition"
         from pg_constraint
        where conrelid = 'template_versions'::regclass and contype = 'c'
        order by conname`,
    );

    expect(checks.rows.map((row) => row.definition)).toEqual([
      expect.stringMatching(/NOT current.*state = 'ready'/),
      expect.stringMatching(/state <> 'failed'.*failure_reason IS NOT NULL/),
    ]);
  });

  it('records the version a sandbox came from, and the pool dial no longer names a snapshot', () => {
    const templateSnapshot = columns.find(
      (row) => row.tableName === 'sandboxes' && row.columnName === 'template_snapshot',
    );

    expect(templateSnapshot).toMatchObject({ isNullable: 'YES', udtName: 'text' });
    expect(
      columns.find(
        (row) => row.tableName === 'sandbox_pool_settings' && row.columnName === 'snapshot',
      ),
    ).toBeUndefined();
  });

  /**
   * Spec 016 (data-model.md § checkpoints): `git_sha` is unique per project (R5's idempotency
   * key), the parent and revert pointers are composite self-FKs, the four CHECKs (spec 018 adds
   * `pull`) tie each `kind` to the columns it sets, and the list walks
   * `(org_id, project_id, created_at desc, id desc)`.
   */
  it('creates checkpoints with its keys, self-references, checks and list index', async () => {
    expect(
      keyConstraints.find(
        (row) => row.constraintName === 'checkpoints_org_id_project_id_git_sha_key',
      )?.columnNames,
    ).toEqual(['org_id', 'project_id', 'git_sha']);
    expect(
      foreignKeys
        .filter((row) => row.childTable === 'checkpoints' && row.parentTable === 'checkpoints')
        .map((row) => row.constraintName),
    ).toEqual(['checkpoints_org_id_parent_id_fk', 'checkpoints_org_id_reverts_id_fk']);
    expect(
      indexes.find((row) => row.definition.includes('checkpoints_org_project_created_idx'))
        ?.definition,
    ).toContain('(org_id, project_id, created_at DESC NULLS LAST, id DESC NULLS LAST)');

    const checks = await pool.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as "definition"
         from pg_constraint
        where conrelid = 'checkpoints'::regclass and contype = 'c'
        order by conname`,
    );

    expect(checks.rows.map((row) => row.definition)).toEqual([
      expect.stringMatching(/kind = 'baseline'.*parent_id IS NULL/),
      // 0030, corrected by 0046: an edit is the one kind with an actor and no run, revert or pull.
      expect.stringMatching(
        /kind\)::text = 'edit'::text\) = \(\(actor_id IS NOT NULL\) AND \(run_id IS NULL\) AND \(reverts_id IS NULL\) AND \(sync_operation_id IS NULL\)/,
      ),
      // `kind = 'pull'` on a database migrated before 0021 compared as text; `(kind)::text =
      // 'pull'::text` on one migrated after. Same constraint, either rendering.
      expect.stringMatching(
        /kind\)?(::text)? = 'pull'(::text)?.*actor_id IS NOT NULL.*sync_operation_id IS NOT NULL/,
      ),
      expect.stringMatching(/kind = 'revert'.*actor_id IS NOT NULL.*reverts_id IS NOT NULL/),
      expect.stringMatching(/kind = 'turn'.*run_id IS NOT NULL.*turn IS NOT NULL/),
    ]);
  });

  /**
   * Spec 027 (data-model.md § deployments, § project_sites): at most one deployment in flight per
   * project (partial unique index), the keyset list index and the sweep's stale index; the
   * release pointer is one row per project on a globally unique label; the CHECKs of
   * `0034_deploys_are_tenant_owned.sql` tie each state to the columns it sets.
   */
  it('creates deployments with its in-flight, list and stale indexes and its checks', async () => {
    const definitionOf = (name: string): string | undefined =>
      indexes.find((row) => row.definition.includes(name))?.definition;

    expect(
      keyConstraints.find((row) => row.constraintName === 'deployments_org_id_id_key')?.columnNames,
    ).toEqual(['org_id', 'id']);
    expect(definitionOf('deployments_one_in_flight')).toMatch(
      /UNIQUE INDEX .* \(org_id, project_id\) WHERE .*queued.*building.*uploading/,
    );
    expect(definitionOf('deployments_org_project_created_idx')).toContain(
      '(org_id, project_id, created_at DESC NULLS LAST, id DESC NULLS LAST)',
    );
    expect(definitionOf('deployments_stale_idx')).toMatch(
      /\(state, started_at\) WHERE .*building.*uploading/,
    );

    const checks = await pool.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as "definition"
         from pg_constraint
        where conrelid = 'deployments'::regclass and contype = 'c'
        order by conname`,
    );

    expect(checks.rows.map((row) => row.definition)).toEqual([
      expect.stringMatching(/'failed'.*failure_reason IS NOT NULL/),
      expect.stringMatching(/'succeeded'.*'failed'.*'cancelled'.*finished_at IS NOT NULL/),
      expect.stringMatching(/char_length\(log_tail\) <= 65536/),
      expect.stringMatching(/'succeeded'.*artifact_sha IS NOT NULL/),
      expect.stringMatching(/'uploading'.*upload_started_at IS NOT NULL/),
    ]);
  });

  it('creates project_sites with one row per project on a globally unique label', async () => {
    expect(
      keyConstraints.find((row) => row.constraintName === 'project_sites_org_id_project_id_key')
        ?.columnNames,
    ).toEqual(['org_id', 'project_id']);
    expect(hasUniqueIndex(indexes, 'project_sites', 'site_label')).toBe(true);

    const checks = await pool.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as "definition"
         from pg_constraint
        where conrelid = 'project_sites'::regclass and contype = 'c'
        order by conname`,
    );

    expect(checks.rows.map((row) => row.definition)).toEqual([
      expect.stringMatching(/site_label ~ '\^\[a-z0-9\]/),
    ]);
  });

  /**
   * Spec 028 (data-model.md § domains): a hostname is unique among live rows across every tenant
   * (partial unique index, R9), the list index, the sweep's due index (R7) and the broker's
   * serving index (R11); the CHECKs of `0036_domains_are_tenant_owned.sql` tie each state to the
   * columns it sets, FR-009 among them.
   */
  it('creates domains with its live-hostname key, list, due and serving indexes and its checks', async () => {
    const definitionOf = (name: string): string | undefined =>
      indexes.find((row) => row.definition.includes(name))?.definition;

    expect(
      keyConstraints.find((row) => row.constraintName === 'domains_org_id_id_key')?.columnNames,
    ).toEqual(['org_id', 'id']);
    expect(definitionOf('domains_hostname_live_key')).toMatch(
      /UNIQUE INDEX .* \(hostname\) WHERE .*pending.*active.*drifted.*removing/,
    );
    expect(definitionOf('domains_org_project_idx')).toContain(
      '(org_id, project_id, created_at DESC NULLS LAST)',
    );
    expect(definitionOf('domains_due_idx')).toMatch(
      /\(next_check_at\) WHERE .*pending.*active.*drifted.*removing/,
    );
    expect(definitionOf('domains_serving_idx')).toMatch(/\(hostname\) WHERE .*active.*drifted/);
    expect(definitionOf('domains_serving_idx')).not.toMatch(/pending|removing/);

    const checks = await pool.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as "definition"
         from pg_constraint
        where conrelid = 'domains'::regclass and contype = 'c'
        order by conname`,
    );

    expect(checks.rows.map((row) => row.definition)).toEqual([
      expect.stringMatching(/'drifted'.*drifted_at IS NOT NULL/),
      expect.stringMatching(/'failed'.*'removed'.*edge_id IS NULL/),
      expect.stringMatching(/failure_count >= 0.*failure_count <= 3/),
      expect.stringMatching(
        /'failed'.*failure_reason IS NOT NULL.*'removed'.*failure_reason IS NULL/,
      ),
      expect.stringMatching(/char_length\(hostname\) <= 253.*lower\(hostname\)/),
      expect.stringMatching(/ownership_token ~ '\^\[a-z2-7\]\{32\}\$'/),
      expect.stringMatching(/'removing'.*removal_requested_at IS NOT NULL/),
      expect.stringMatching(
        /'active'.*'drifted'.*ownership_verified_at IS NOT NULL.*certificate_active_at IS NOT NULL.*activated_at IS NOT NULL.*edge_id IS NOT NULL/,
      ),
    ]);
  });

  /**
   * Spec 030 data-model §§ 2–5: the connection row generalised to every provider, and the three
   * binding tables' CHECKs and partial uniques, proved by the database refusing them. Seeded as the
   * migrator in one transaction and rolled back; each probe runs under a savepoint.
   */
  describe('connector bindings (spec 030)', () => {
    let client: pg.PoolClient;
    let orgId: string;
    let projectId: string;
    let userId: string;

    const refused = async (text: string, values: unknown[]): Promise<string | undefined> => {
      await client.query('savepoint probe');
      try {
        await client.query(text, values);
        return undefined;
      } catch (caught) {
        return (caught as pg.DatabaseError).constraint ?? (caught as pg.DatabaseError).code;
      } finally {
        await client.query('rollback to savepoint probe');
      }
    };

    beforeAll(async () => {
      client = await pool.connect();
      await client.query('begin');
      orgId = (
        await client.query<{ id: string }>(
          `insert into orgs (name, slug) values ('cn-probe', 'cn-probe-' || gen_random_uuid()) returning id`,
        )
      ).rows[0]!.id;
      await client.query(`select set_config('app.org_id', $1, true)`, [orgId]);
      userId = (
        await client.query<{ id: string }>(
          `insert into users (email) values ('cn-probe-' || gen_random_uuid() || '@example.test') returning id`,
        )
      ).rows[0]!.id;
      const workspaceId = (
        await client.query<{ id: string }>(
          `insert into workspaces (org_id, name) values ($1, 'w') returning id`,
          [orgId],
        )
      ).rows[0]!.id;
      projectId = (
        await client.query<{ id: string }>(
          `insert into projects (org_id, workspace_id, name, preview_label)
           values ($1, $2, 'p', 'cn-probe-' || gen_random_uuid()) returning id`,
          [orgId, workspaceId],
        )
      ).rows[0]!.id;
    });

    afterAll(async () => {
      await client.query('rollback');
      client.release();
    });

    it('refuses a GitHub connection without installation_id', async () => {
      expect(
        await refused(
          `insert into connections (org_id, provider, account_id, account_login, account_type, health, connected_by)
           values ($1, 'github', 1, 'octo', 'user', 'healthy', $2)`,
          [orgId, userId],
        ),
      ).toBe('connections_github_shape');
    });

    it('refuses a Neon connection without account_ref, and accepts one with it', async () => {
      expect(
        await refused(
          `insert into connections (org_id, provider, account_login, auth_type, health, connected_by)
           values ($1, 'neon', 'Acme', 'token', 'healthy', $2)`,
          [orgId, userId],
        ),
      ).toBe('connections_account_ref');
      expect(
        await refused(
          `insert into connections (org_id, provider, account_login, account_ref, auth_type, granted_scopes, health, connected_by)
           values ($1, 'neon', 'Acme', 'org-acme', 'token', '{projects:read}', 'healthy', $2)`,
          [orgId, userId],
        ),
      ).toBeUndefined();
    });

    it('refuses a GitHub binding and a bound binding with no connection', async () => {
      expect(
        await refused(
          `insert into connector_bindings (org_id, project_id, provider, config, state, bound_by)
           values ($1, $2, 'github', '{}', 'disconnected', $3)`,
          [orgId, projectId, userId],
        ),
      ).toBe('connector_bindings_not_github');
      expect(
        await refused(
          `insert into connector_bindings (org_id, project_id, provider, config, state, bound_by)
           values ($1, $2, 'neon', '{}', 'bound', $3)`,
          [orgId, projectId, userId],
        ),
      ).toBe('connector_bindings_state_check');
    });

    it('refuses two live resources per binding and kind, and a resource with the wrong owner', async () => {
      await client.query('savepoint seed');
      const bindingId = (
        await client.query<{ id: string }>(
          `insert into connector_bindings (org_id, project_id, provider, config, state, bound_by)
           values ($1, $2, 'neon', '{}', 'disconnected', $3) returning id`,
          [orgId, projectId, userId],
        )
      ).rows[0]!.id;
      await client.query(
        `insert into connector_resources (org_id, binding_id, kind, name, state)
         values ($1, $2, 'neon_branch', 'forge-preview-x', 'live')`,
        [orgId, bindingId],
      );

      expect(
        await refused(
          `insert into connector_resources (org_id, binding_id, kind, name, state)
           values ($1, $2, 'neon_branch', 'forge-preview-x', 'provisioning')`,
          [orgId, bindingId],
        ),
      ).toBe('connector_resources_one_live_per_binding');
      expect(
        await refused(
          `insert into connector_resources (org_id, binding_id, kind, name, state)
           values ($1, $2, 'neon_branch', 'forge-preview-x', 'released')`,
          [orgId, bindingId],
        ),
      ).toBeUndefined();
      expect(
        await refused(
          `insert into connector_resources (org_id, binding_id, kind, name, state)
           values ($1, $2, 'cloudflare_dns_record', '_forge.example.com', 'live')`,
          [orgId, bindingId],
        ),
      ).toBe('connector_resources_single_owner');
      await client.query('rollback to savepoint seed');
    });

    it('refuses a failed operation with no reason, a publish with no deployment, and two in flight', async () => {
      await client.query('savepoint seed');
      const bindingId = (
        await client.query<{ id: string }>(
          `insert into connector_bindings (org_id, project_id, provider, config, state, bound_by)
           values ($1, $2, 'neon', '{}', 'disconnected', $3) returning id`,
          [orgId, projectId, userId],
        )
      ).rows[0]!.id;

      expect(
        await refused(
          `insert into connector_operations (org_id, project_id, binding_id, kind, state)
           values ($1, $2, $3, 'neon_branch_reset', 'failed')`,
          [orgId, projectId, bindingId],
        ),
      ).toBe('connector_operations_reason_when_failed');
      expect(
        await refused(
          `insert into connector_operations (org_id, project_id, binding_id, kind, state)
           values ($1, $2, $3, 'netlify_publish', 'queued')`,
          [orgId, projectId, bindingId],
        ),
      ).toBe('connector_operations_publish_deployment');

      await client.query(
        `insert into connector_operations (org_id, project_id, binding_id, kind, state)
         values ($1, $2, $3, 'neon_branch_create', 'running')`,
        [orgId, projectId, bindingId],
      );
      expect(
        await refused(
          `insert into connector_operations (org_id, project_id, binding_id, kind, state)
           values ($1, $2, $3, 'neon_branch_reset', 'queued')`,
          [orgId, projectId, bindingId],
        ),
      ).toBe('connector_operations_one_in_flight');
      expect(
        await refused(
          `insert into connector_operations (org_id, project_id, binding_id, kind, state)
           values ($1, $2, $3, 'resource_release', 'queued')`,
          [orgId, projectId, bindingId],
        ),
      ).toBeUndefined();
      await client.query('rollback to savepoint seed');
    });

    it('keeps org_id on a resource whose binding is deleted, nulling only binding_id', async () => {
      await client.query('savepoint seed');
      const bindingId = (
        await client.query<{ id: string }>(
          `insert into connector_bindings (org_id, project_id, provider, config, state, bound_by)
           values ($1, $2, 'neon', '{}', 'disconnected', $3) returning id`,
          [orgId, projectId, userId],
        )
      ).rows[0]!.id;
      const resourceId = (
        await client.query<{ id: string }>(
          `insert into connector_resources (org_id, binding_id, kind, name, state)
           values ($1, $2, 'neon_branch', 'forge-preview-x', 'released') returning id`,
          [orgId, bindingId],
        )
      ).rows[0]!.id;

      await client.query('delete from connector_bindings where id = $1', [bindingId]);

      const survivor = await client.query(
        'select org_id, binding_id from connector_resources where id = $1',
        [resourceId],
      );

      expect(survivor.rows).toEqual([{ binding_id: null, org_id: orgId }]);
      await client.query('rollback to savepoint seed');
    });
  });

  it('lets sandboxes.workspace_root be null until the daemon answers work-dir', () => {
    const column = columns.find(
      (row) => row.tableName === 'sandboxes' && row.columnName === 'workspace_root',
    );

    expect(column?.isNullable).toBe('YES');
  });

  /**
   * Spec 014 § Invariants, as CHECKs (`0014_sandbox_pool_grants.sql`) so no repository method can
   * write a half-set transition, an undated hibernation, or an archive (FR-013 — spec 016 drops
   * the third).
   */
  it('checks the three sandbox invariants in the database', async () => {
    const checks = await pool.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as "definition"
         from pg_constraint
        where conrelid = 'sandboxes'::regclass and contype = 'c'
        order by conname`,
    );

    expect(checks.rows.map((row) => row.definition)).toEqual([
      expect.stringMatching(/state <> 'hibernated'.*hibernated_at IS NOT NULL/),
      expect.stringMatching(/state <> 'archived'/),
      expect.stringMatching(/transition IS NULL.*transition_since IS NOT NULL/),
    ]);
  });
});
