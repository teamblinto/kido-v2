import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrationDatabaseUrl } from '../env';

const { Pool } = pg;

/** Postgres' SQLSTATE for a violated CHECK — what every refusal below must be, and not a 23502. */
const CHECK_VIOLATION = '23514';

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

const databaseReachable = await isReachable();

if (!databaseReachable) {
  if (process.env.EXPECT_INTEGRATION === '1') {
    await pool.end();
    throw new Error(
      `EXPECT_INTEGRATION=1 but Postgres is unreachable as forge_migrator at ${redactedUrl()} — ` +
        'CI must not skip the checkpoint-shape gate.',
    );
  }

  console.warn(
    [
      '',
      '='.repeat(100),
      `SKIPPING the checkpoint-shape gate: Postgres is unreachable at ${redactedUrl()}.`,
      'Start it with `docker compose up -d postgres`, then `pnpm --filter @repo/db db:migrate`.',
      'CI runs this suite with EXPECT_INTEGRATION=1, where an unreachable database is a failure.',
      '='.repeat(100),
      '',
    ].join('\n'),
  );

  await pool.end();
}

/**
 * The five shape CHECKs on `checkpoints`, asserted against a real database.
 *
 * Each says "this kind, and only this kind, carries these" (spec 016 data-model § checkpoints;
 * spec 024 data-model § 1 adds the fifth). None of them is expressible in the TypeScript schema in
 * a way that proves anything: `drizzle-kit` cannot diff a CHECK, the `edit` one is hand-written in
 * `migrations/0030_an_edit_names_its_author_and_no_run.sql`, and a constraint only means what the
 * database enforces. So the proof is an insert the database has to refuse.
 *
 * Every case runs inside one transaction that is rolled back, so the fixtures leave nothing behind
 * — the same shape `rls.spec.ts` uses for its FK probe.
 */
describe.skipIf(!databaseReachable)('checkpoint shape CHECKs', () => {
  let client: pg.PoolClient;
  let orgId: string;
  let projectId: string;
  let userId: string;
  let runId: string;
  let baselineId: string;

  beforeAll(async () => {
    client = await pool.connect();
    await client.query('begin');

    orgId = (
      await client.query<{ id: string }>(
        `insert into orgs (name, slug) values ('cp-probe', 'cp-probe-' || gen_random_uuid()) returning id`,
      )
    ).rows[0]!.id;
    await client.query(`select set_config('app.org_id', $1, true)`, [orgId]);

    userId = (
      await client.query<{ id: string }>(
        `insert into users (email) values ('cp-probe-' || gen_random_uuid() || '@example.test') returning id`,
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
         values ($1, $2, 'p', 'cp-probe-' || gen_random_uuid()) returning id`,
        [orgId, workspaceId],
      )
    ).rows[0]!.id;
    runId = (
      await client.query<{ id: string }>(
        `insert into agent_runs (org_id, project_id, user_id, model)
         values ($1, $2, $3, 'probe-model') returning id`,
        [orgId, projectId, userId],
      )
    ).rows[0]!.id;

    // The root of the chain every other row below hangs off: the one kind with no parent.
    baselineId = (
      await client.query<{ id: string }>(
        `insert into checkpoints (org_id, project_id, kind, git_sha, label, files)
         values ($1, $2, 'baseline', repeat('a', 40), 'Baseline', '[]'::jsonb) returning id`,
        [orgId, projectId],
      )
    ).rows[0]!.id;
  });

  afterAll(async () => {
    if (databaseReachable) {
      await client.query('rollback');
      client.release();
      await pool.end();
    }
  });

  /**
   * One insert, attempted and undone. A savepoint rather than a transaction: the fixtures above
   * are in the outer transaction and a refused insert aborts only back to here.
   */
  async function insert(columns: Record<string, unknown>): Promise<string | null> {
    const names = Object.keys(columns);
    const placeholders = names.map((_name, index) => `$${index + 1}`);

    await client.query('savepoint probe');
    try {
      await client.query(
        `insert into checkpoints (${names.map((name) => `"${name}"`).join(', ')})
         values (${placeholders.join(', ')})`,
        Object.values(columns),
      );
      await client.query('release savepoint probe');
      return null;
    } catch (error) {
      await client.query('rollback to savepoint probe');
      return (error as { code?: string }).code ?? 'unknown';
    }
  }

  /** The columns every row needs, with a sha unique per call so identity never masks a CHECK. */
  function row(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      files: '[]',
      git_sha: Math.random().toString(16).slice(2).padEnd(40, '0').slice(0, 40),
      label: 'probe',
      org_id: orgId,
      project_id: projectId,
      ...overrides,
    };
  }

  describe('the edit CHECK (spec 024)', () => {
    it('accepts an edit that names its author and no run', async () => {
      await expect(
        insert(row({ actor_id: userId, kind: 'edit', parent_id: baselineId })),
      ).resolves.toBeNull();
    });

    it('refuses an edit carrying a run_id', async () => {
      await expect(
        insert(row({ actor_id: userId, kind: 'edit', parent_id: baselineId, run_id: runId })),
      ).resolves.toBe(CHECK_VIOLATION);
    });

    it('refuses an edit with no actor_id', async () => {
      await expect(insert(row({ kind: 'edit', parent_id: baselineId }))).resolves.toBe(
        CHECK_VIOLATION,
      );
    });

    it('refuses another kind wearing an edit row shape, so the CHECK holds both ways', async () => {
      // A `pull` carries an actor and no run too — but it also carries a sync operation, and the
      // biconditional is false the moment a non-`edit` row matches the right-hand side alone.
      await expect(
        insert(row({ actor_id: userId, kind: 'pull', parent_id: baselineId })),
      ).resolves.toBe(CHECK_VIOLATION);
    });
  });

  describe('the four kinds that were already checked', () => {
    it('still refuses a baseline with a parent, and a non-baseline without one', async () => {
      await expect(insert(row({ kind: 'baseline', parent_id: baselineId }))).resolves.toBe(
        CHECK_VIOLATION,
      );
      await expect(insert(row({ kind: 'turn', run_id: runId, turn: 1 }))).resolves.toBe(
        CHECK_VIOLATION,
      );
    });

    it('still refuses a turn missing its run or its turn number', async () => {
      await expect(insert(row({ kind: 'turn', parent_id: baselineId, turn: 1 }))).resolves.toBe(
        CHECK_VIOLATION,
      );
      await expect(
        insert(row({ kind: 'turn', parent_id: baselineId, run_id: runId })),
      ).resolves.toBe(CHECK_VIOLATION);
    });

    it('still refuses a revert missing its actor or the checkpoint it restores', async () => {
      await expect(
        insert(row({ kind: 'revert', parent_id: baselineId, reverts_id: baselineId })),
      ).resolves.toBe(CHECK_VIOLATION);
      await expect(
        insert(row({ actor_id: userId, kind: 'revert', parent_id: baselineId })),
      ).resolves.toBe(CHECK_VIOLATION);
    });

    it('still accepts the four well-formed kinds', async () => {
      await expect(
        insert(row({ kind: 'turn', parent_id: baselineId, run_id: runId, turn: 1 })),
      ).resolves.toBeNull();
      await expect(
        insert(
          row({
            actor_id: userId,
            kind: 'revert',
            parent_id: baselineId,
            reverts_id: baselineId,
          }),
        ),
      ).resolves.toBeNull();
    });
  });
});
