import { randomUUID } from 'node:crypto';

import { memberships, orgs, schema, users, workspaces } from '@repo/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { openPool } from '../../test/support/integration-database';
import type { ForgeDatabase } from './database.types';
import { TenantContext } from './tenant-context';
import {
  InvalidTenantIdError,
  InvalidUserIdError,
  TenantTransactionRunner,
} from './tenant-transaction';

const APP_URL = process.env.DATABASE_URL ?? '';
const BYPASS_URL = process.env.DATABASE_URL_BYPASS_RLS ?? '';

/** Probed once per run by `test/global-setup.ts`, which also owns the CI-must-not-skip rule. */
const reachable = inject('postgresReachable');

/**
 * `max: 1`, deliberately. Every request in this file is therefore served by the *same* Postgres
 * backend, which is the arrangement PgBouncer in transaction mode creates in production and the
 * only one in which a leaked session setting is observable at all. A larger pool would hand each
 * test a fresh connection and quietly pass whatever it was given.
 */
const appPool = reachable ? openPool(APP_URL, 1) : undefined;

/** `forge_bypass` holds BYPASSRLS, so it counts what is really in the table. */
const bypassPool = reachable ? openPool(BYPASS_URL, 1) : undefined;

/** Fixture writes, on their own connections, so setup never contends with the pool under test. */
const fixturePool = reachable ? openPool(APP_URL, 2) : undefined;

/** `extends Record<string, unknown>` because that is the constraint `execute<T>` places on `T`. */
interface Probe extends Record<string, unknown> {
  orgSetting: string | null;
  pid: number;
}

const PROBE = sql`select pg_backend_pid()                      as "pid",
                         current_setting('app.org_id', true)   as "orgSetting"`;

/** `extends Record<string, unknown>` for the same reason {@link Probe} does. */
interface UserProbe extends Record<string, unknown> {
  pid: number;
  userSetting: string | null;
}

const USER_PROBE = sql`select pg_backend_pid()                     as "pid",
                              current_setting('app.user_id', true) as "userSetting"`;

/** Fixture rows are written with raw SQL, so setup never depends on the unit under test. */
async function insertWorkspace(orgId: string, name: string): Promise<string> {
  const client = await fixturePool!.connect();

  try {
    await client.query('begin');
    await client.query(`select set_config('app.org_id', $1, true)`, [orgId]);

    const inserted = await client.query<{ id: string }>(
      'insert into workspaces (name, org_id) values ($1, $2) returning id',
      [name, orgId],
    );

    await client.query('commit');

    return inserted.rows[0]!.id;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/** A membership, written the same way: raw SQL under a tenant context this file does not produce. */
async function insertMembership(orgId: string, userId: string): Promise<void> {
  const client = await fixturePool!.connect();

  try {
    await client.query('begin');
    await client.query(`select set_config('app.org_id', $1, true)`, [orgId]);

    await client.query(
      `insert into memberships (org_id, user_id, role, accepted_at) values ($1, $2, 'owner', now())`,
      [orgId, userId],
    );

    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Drizzle wraps a driver failure in a `DrizzleQueryError` whose `cause` is the `pg` error, so the
 * SQLSTATE — the only part of a refusal worth asserting on — is one level down.
 */
function driverError(caught: unknown): pg.DatabaseError | undefined {
  const cause = (caught as { cause?: unknown }).cause;

  return (cause ?? caught) as pg.DatabaseError;
}

async function countWorkspacesBypassingRls(orgIds: readonly string[]): Promise<number> {
  const result = await bypassPool!.query<{ n: number }>(
    'select count(*)::int as n from workspaces where org_id = any($1::uuid[])',
    [orgIds],
  );

  return result.rows[0]!.n;
}

/**
 * §09, the whole task in one file.
 *
 * "With PgBouncer in transaction mode a connection is handed to another request the moment a
 * transaction commits. A plain SET would leak one tenant's context into the next request on that
 * connection — the exact bug RLS was meant to prevent. SET LOCAL / set_config(name, value, true) is
 * mandatory, and a test in CI asserts that a query issued outside a tenant transaction returns zero
 * rows rather than everything."
 *
 * PgBouncer itself is not in `compose.yaml` — the spec caps the stack at Postgres and two Redis, and
 * adding a service needs approval. What is asserted here is therefore the observable property rather
 * than the deployment: with `max: 1` the application pool reuses one backend exactly the way
 * transaction-mode pooling does, so a session-scoped setting would be just as visible.
 */
describe.skipIf(!reachable)('runInTenantTransaction', () => {
  let db: ForgeDatabase;
  let runner: TenantTransactionRunner;
  let orgA = '';
  let orgB = '';

  beforeAll(async () => {
    db = drizzle(appPool!, { schema });
    // The runner publishes the tenant context for `runInTenantScope`. `runInTenantTransaction`,
    // which is what this file is about, does not touch it.
    runner = new TenantTransactionRunner(db, new TenantContext());

    const suffix = randomUUID().slice(0, 8);

    const created = await db
      .insert(orgs)
      .values([
        { name: 'Tenant A', slug: `t06-a-${suffix}` },
        { name: 'Tenant B', slug: `t06-b-${suffix}` },
      ])
      .returning({ id: orgs.id });

    orgA = created[0]!.id;
    orgB = created[1]!.id;

    await insertWorkspace(orgA, 'A workspace');
    await insertWorkspace(orgB, 'B workspace');
  });

  afterAll(async () => {
    if (!reachable) {
      return;
    }

    // Deleting the orgs cascades to every tenant-owned row beneath them. Referential-integrity
    // actions are performed with row security disabled, so this needs no tenant context.
    await db.delete(orgs).where(inArray(orgs.id, [orgA, orgB]));
  });

  it('sets app.org_id for the life of the transaction and no longer', async () => {
    const inside = await runner.runInTenantTransaction(orgA, async (tx) => {
      const result = await tx.execute<Probe>(PROBE);

      return result.rows[0]!;
    });

    expect(inside.orgSetting).toBe(orgA);

    const after = await db.execute<Probe>(PROBE);

    expect(after.rows[0]!.pid, 'the test did not reuse the connection, so it proved nothing').toBe(
      inside.pid,
    );
    expect(after.rows[0]!.orgSetting).not.toBe(orgA);
  });

  it('commits the transaction when the callback resolves', async () => {
    const name = `committed-${randomUUID().slice(0, 8)}`;

    await runner.runInTenantTransaction(orgA, async (tx) => {
      await tx.insert(workspaces).values({ name, orgId: orgA });
    });

    const found = await runner.runInTenantTransaction(orgA, (tx) =>
      tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.name, name)),
    );

    expect(found).toHaveLength(1);
  });

  it('rolls the transaction back when the callback throws', async () => {
    const name = `rolled-back-${randomUUID().slice(0, 8)}`;

    await expect(
      runner.runInTenantTransaction(orgA, async (tx) => {
        await tx.insert(workspaces).values({ name, orgId: orgA });

        throw new Error('the caller failed after writing');
      }),
    ).rejects.toThrow('the caller failed after writing');

    const found = await runner.runInTenantTransaction(orgA, (tx) =>
      tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.name, name)),
    );

    expect(found).toEqual([]);
  });

  /**
   * The org id reaches the database as a bind parameter, so this is not about injection. It is
   * about the failure mode: an id that is not a uuid makes every policy predicate raise 22P02 deep
   * inside an unrelated query, and the message names a type cast rather than the caller.
   */
  it('refuses an org id that is not a uuid, before opening a transaction', async () => {
    await expect(
      runner.runInTenantTransaction('not-a-uuid', () => Promise.resolve(1)),
    ).rejects.toThrow(InvalidTenantIdError);

    let ran = false;

    await runner
      .runInTenantTransaction('', () => {
        ran = true;

        return Promise.resolve(1);
      })
      .catch(() => undefined);

    expect(ran).toBe(false);
  });

  // ── The four architecture requirements ──────────────────────────────────────────────────────

  it('PROOF 1 · returns zero rows for a query issued outside a tenant transaction', async () => {
    expect(
      await countWorkspacesBypassingRls([orgA, orgB]),
      'the fixture rows are missing, so zero rows below would prove nothing',
    ).toBeGreaterThanOrEqual(2);

    const onAFreshConnection = openPool(APP_URL, 1);

    try {
      const fresh = await drizzle(onAFreshConnection, { schema }).select().from(workspaces);

      expect(fresh, 'a connection that has never carried tenant context').toEqual([]);
    } finally {
      await onAFreshConnection.end();
    }

    // And again on the pool that has been serving tenant transactions all along. This is the case
    // that actually bites: setting a customised option creates it on the backend, and a
    // transaction-scoped set reverts its value to the empty string rather than to non-existence.
    // Before `migrations/0004_rls_null_tenant.sql` this raised 22P02 instead of returning nothing.
    await runner.runInTenantTransaction(orgA, (tx) => tx.select().from(workspaces));

    const onAUsedConnection = await db.select().from(workspaces);

    expect(onAUsedConnection, 'a connection that has already served a tenant').toEqual([]);
  });

  it('PROOF 2 · returns zero rows for a cross-tenant SELECT inside a tenant transaction', async () => {
    const { own, other } = await runner.runInTenantTransaction(orgA, async (tx) => ({
      other: await tx.select().from(workspaces).where(eq(workspaces.orgId, orgB)),
      own: await tx.select().from(workspaces).where(eq(workspaces.orgId, orgA)),
    }));

    expect(
      own.length,
      'tenant A cannot see its own rows, so this test is not measuring RLS',
    ).toBeGreaterThan(0);
    expect(other).toEqual([]);

    // Asking for B's rows by primary key, with no org predicate at all, is the same answer.
    const unfiltered = await runner.runInTenantTransaction(orgA, (tx) =>
      tx.select().from(workspaces).where(eq(workspaces.name, 'B workspace')),
    );

    expect(unfiltered).toEqual([]);
  });

  it('PROOF 3 · rejects a cross-tenant INSERT with WITH CHECK', async () => {
    const error = await runner
      .runInTenantTransaction(orgA, (tx) =>
        tx.insert(workspaces).values({ name: 'smuggled into B', orgId: orgB }),
      )
      .then(() => undefined)
      .catch(driverError);

    expect(error, 'the cross-tenant INSERT was NOT rejected').toBeDefined();
    // 42501 is insufficient_privilege, which is how Postgres reports a WITH CHECK violation. It is
    // a refusal to write the row, not a policy that filtered it away afterwards.
    expect(error?.code).toBe('42501');
    expect(error?.message).toMatch(
      /new row violates row-level security policy for table "workspaces"/,
    );

    // Rejected, not merely hidden: nothing landed under B either.
    expect(await countWorkspacesBypassingRls([orgB])).toBe(1);
  });

  it('PROOF 4 · does not leak tenant context between sequential users of one pooled connection', async () => {
    const first = await runner.runInTenantTransaction(orgA, async (tx) => ({
      probe: (await tx.execute<Probe>(PROBE)).rows[0]!,
      rows: await tx.select({ orgId: workspaces.orgId }).from(workspaces),
    }));

    const second = await runner.runInTenantTransaction(orgB, async (tx) => ({
      probe: (await tx.execute<Probe>(PROBE)).rows[0]!,
      rows: await tx.select({ orgId: workspaces.orgId }).from(workspaces),
    }));

    const between = await db.execute<Probe>(PROBE);

    // One backend served all three, which is what makes the rest of this test mean anything.
    expect(new Set([first.probe.pid, second.probe.pid, between.rows[0]!.pid]).size).toBe(1);

    expect(first.probe.orgSetting).toBe(orgA);
    expect(second.probe.orgSetting).toBe(orgB);

    expect(new Set(first.rows.map((row) => row.orgId))).toEqual(new Set([orgA]));
    expect(new Set(second.rows.map((row) => row.orgId))).toEqual(new Set([orgB]));

    // The setting does not survive into whatever runs next on that connection.
    expect(between.rows[0]!.orgSetting).not.toBe(orgA);
    expect(between.rows[0]!.orgSetting).not.toBe(orgB);
    expect(await db.select().from(workspaces)).toEqual([]);
  });
});

/**
 * The user-rooted scope `GET /api/v1/orgs` runs in (ADR 023).
 *
 * Everything above is about a transaction that knows an organisation. This is the one that knows a
 * *person* and no organisation, and the four assertions below are its whole contract: it can read
 * that person's membership edges across every tenant, it can read nothing else, it can write
 * nothing outside a tenant, and the setting it uses does not outlive the transaction that set it.
 *
 * The last one is not paranoia. `migrations/0004_rls_null_tenant.sql` measured what a
 * transaction-scoped set actually reverts to — the empty string, not non-existence — and every
 * connection is a reused connection after the first request. A second GUC is a second chance to
 * make that mistake, which is why `app.user_id` is wrapped in the same `NULLIF` and why this file
 * runs on `max: 1`.
 */
describe.skipIf(!reachable)('runInUserTransaction', () => {
  let db: ForgeDatabase;
  let runner: TenantTransactionRunner;
  let orgA = '';
  let orgB = '';
  let memberId = '';
  let strangerId = '';

  beforeAll(async () => {
    db = drizzle(appPool!, { schema });
    runner = new TenantTransactionRunner(db, new TenantContext());

    const suffix = randomUUID().slice(0, 8);

    const created = await db
      .insert(orgs)
      .values([
        { name: 'Tenant A', slug: `t06u-a-${suffix}` },
        { name: 'Tenant B', slug: `t06u-b-${suffix}` },
      ])
      .returning({ id: orgs.id });

    orgA = created[0]!.id;
    orgB = created[1]!.id;

    const people = await db
      .insert(users)
      .values([
        { email: `t06u-member-${suffix}@example.test`, passwordHash: 'x' },
        { email: `t06u-stranger-${suffix}@example.test`, passwordHash: 'x' },
      ])
      .returning({ id: users.id });

    memberId = people[0]!.id;
    strangerId = people[1]!.id;

    await insertWorkspace(orgA, 'A workspace');
    await insertMembership(orgA, memberId);
    await insertMembership(orgB, memberId);
    await insertMembership(orgA, strangerId);
  });

  afterAll(async () => {
    if (!reachable) {
      return;
    }

    await db.delete(orgs).where(inArray(orgs.id, [orgA, orgB]));
    await db.delete(users).where(inArray(users.id, [memberId, strangerId]));
  });

  it('refuses a user id that is not a uuid, before opening a transaction', async () => {
    let ran = false;

    await expect(
      runner.runInUserTransaction('not-a-uuid', () => {
        ran = true;

        return Promise.resolve(1);
      }),
    ).rejects.toThrow(InvalidUserIdError);

    expect(ran).toBe(false);
  });

  it('reads the caller’s membership rows in every organisation they belong to', async () => {
    const rows = await runner.runInUserTransaction(memberId, (tx) =>
      tx.select({ orgId: memberships.orgId }).from(memberships),
    );

    expect(new Set(rows.map((row) => row.orgId))).toEqual(new Set([orgA, orgB]));
  });

  /**
   * The half that makes the clause narrow enough to be safe. The caller is a member of `orgA` and
   * so is the stranger, and an unfiltered `select` in this scope still returns only the caller's own
   * row — the policy filters by `user_id`, not by "an organisation you happen to be in".
   */
  it('reads nobody else’s, not even in an organisation they share', async () => {
    const rows = await runner.runInUserTransaction(memberId, (tx) =>
      tx.select({ userId: memberships.userId }).from(memberships),
    );

    expect(new Set(rows.map((row) => row.userId))).toEqual(new Set([memberId]));

    // And asking for the stranger's row by name is the same answer, rather than a refusal that
    // would confirm it exists.
    const named = await runner.runInUserTransaction(memberId, (tx) =>
      tx
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(and(eq(memberships.orgId, orgA), eq(memberships.userId, strangerId))),
    );

    expect(named).toEqual([]);
  });

  /**
   * `app.user_id` is named by one clause of one policy. Every other tenant-owned table is exactly as
   * empty in this scope as it is outside a transaction altogether — which is what stops this being
   * a general-purpose read of the database wearing a user id.
   */
  it('reads nothing at all from any other tenant-owned table', async () => {
    const seen = await runner.runInUserTransaction(memberId, async (tx) => ({
      workspaces: await tx.select().from(workspaces),
    }));

    expect(seen).toEqual({ workspaces: [] });

    // And the rows are there, so the emptiness above is the policy rather than an empty database.
    const inTenant = await runner.runInTenantTransaction(orgA, (tx) =>
      tx.select().from(workspaces),
    );

    expect(inTenant.length).toBeGreaterThan(0);
  });

  /** `WITH CHECK` was left alone, so this scope cannot file a membership under any organisation. */
  it('cannot write a membership, because WITH CHECK still asks for a tenant', async () => {
    const error = await runner
      .runInUserTransaction(memberId, (tx) =>
        tx.insert(memberships).values({ orgId: orgA, role: 'owner', userId: memberId }),
      )
      .then(() => undefined)
      .catch(driverError);

    expect(error, 'the tenant-less INSERT was NOT rejected').toBeDefined();
    expect(error?.code).toBe('42501');
    expect(error?.message).toMatch(
      /new row violates row-level security policy for table "memberships"/,
    );
  });

  /**
   * The 0004 hazard, re-run for the second setting. After a user transaction commits the value
   * reverts to `''` rather than to non-existence, so without the `NULLIF` in the policy every later
   * query on this backend would raise 22P02 instead of returning nothing.
   */
  it('does not leave the setting behind for whatever runs next on that connection', async () => {
    const inside = await runner.runInUserTransaction(memberId, async (tx) => {
      const result = await tx.execute<UserProbe>(USER_PROBE);

      return result.rows[0]!;
    });

    expect(inside.userSetting).toBe(memberId);

    const after = await db.execute<UserProbe>(USER_PROBE);

    expect(after.rows[0]!.pid, 'the test did not reuse the connection, so it proved nothing').toBe(
      inside.pid,
    );
    expect(after.rows[0]!.userSetting).not.toBe(memberId);

    // The property that matters, on the connection that has just carried a user: zero rows, not an
    // error and not everything.
    expect(await db.select().from(memberships)).toEqual([]);
  });
});

/**
 * The pools outlive both suites, so they are closed here rather than in either one's `afterAll`.
 *
 * Vitest runs a file's suites in order and drains each one's hooks before starting the next, so
 * ending them inside the first would leave the second holding a closed pool — and `max: 1` is the
 * whole point of these connections: both suites have to be served by the same backend for a leaked
 * setting to be observable at all.
 */
afterAll(async () => {
  if (!reachable) {
    return;
  }

  await Promise.all([appPool!.end(), bypassPool!.end(), fixturePool!.end()]);
});
