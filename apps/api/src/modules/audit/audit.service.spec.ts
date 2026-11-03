import { randomUUID } from 'node:crypto';

import { orgs, schema, workspaces } from '@repo/db';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { FakeClock } from '../../common/clock/fake-clock';
import type { ForgeDatabase } from '../../database/database.types';
import { TenantContext } from '../../database/tenant-context';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { openPool } from '../../../test/support/integration-database';
import { AuditService } from './audit.service';

const APP_URL = process.env.DATABASE_URL ?? '';
const BYPASS_URL = process.env.DATABASE_URL_BYPASS_RLS ?? '';

/** Probed once per run by `test/global-setup.ts`, which also owns the CI-must-not-skip rule. */
const reachable = inject('postgresReachable');

const appPool = reachable ? openPool(APP_URL, 1) : undefined;

/**
 * `forge_bypass` holds BYPASSRLS, so it counts what is really in the table rather than what the
 * writing tenant is allowed to see. A rollback proof read back through RLS could not tell "the row
 * was never committed" apart from "the row is committed and hidden", which are the two answers the
 * proof exists to separate.
 */
const bypassPool = reachable ? openPool(BYPASS_URL, 1) : undefined;

/** A fixed instant, so `at` is an assertion about the code rather than about the host clock. */
const FROZEN = new Date('2026-03-01T12:00:00.000Z');

/**
 * Drizzle wraps a driver failure in a `DrizzleQueryError` whose `cause` is the `pg` error, so the
 * SQLSTATE — the only part of a refusal worth asserting on — is one level down.
 */
function driverError(caught: unknown): pg.DatabaseError | undefined {
  const cause = (caught as { cause?: unknown }).cause;

  return (cause ?? caught) as pg.DatabaseError;
}

interface AuditRow extends Record<string, unknown> {
  action: string;
  actorId: string | null;
  at: Date;
  metadata: Record<string, unknown>;
  orgId: string;
  target: string;
}

/** Reads the trail with RLS bypassed: what is really committed, for any tenant. */
async function auditRowsFor(target: string): Promise<AuditRow[]> {
  const result = await bypassPool!.query<AuditRow>(
    `select action, actor_id as "actorId", at, metadata, org_id as "orgId", target
       from audit_log
      where target = $1
      order by at`,
    [target],
  );

  return result.rows;
}

/**
 * T10 · §09 · "audit_log — monthly partitions, append-only. Never updated or deleted by application
 * code."
 *
 * The property under test is narrower and more important than "the service inserts a row": the row
 * has to share the fate of the transaction that wrote it. An audit log that survives a rollback is
 * a log of things that did not happen, and one that can be written after its mutation failed is
 * worse than no log — it is a confident record of a state change that never landed.
 *
 * Everything here runs against real Postgres. A rollback is a database behaviour, and a mocked
 * transaction would prove only that the mock was written to agree with the test.
 */
describe.skipIf(!reachable)('AuditService', () => {
  let db: ForgeDatabase;
  let runner: TenantTransactionRunner;
  let audit: AuditService;
  let clock: FakeClock;
  let orgA = '';
  let orgB = '';

  beforeAll(async () => {
    db = drizzle(appPool!, { schema });
    runner = new TenantTransactionRunner(db, new TenantContext());
    clock = new FakeClock(FROZEN);
    audit = new AuditService(clock);

    const suffix = randomUUID().slice(0, 8);

    const created = await db
      .insert(orgs)
      .values([
        { name: 'Tenant A', slug: `t10-a-${suffix}` },
        { name: 'Tenant B', slug: `t10-b-${suffix}` },
      ])
      .returning({ id: orgs.id });

    orgA = created[0]!.id;
    orgB = created[1]!.id;
  });

  afterAll(async () => {
    if (!reachable) {
      return;
    }

    // Deleting the orgs cascades to every tenant-owned row beneath them, `audit_log` included —
    // referential actions run with row security disabled and are not the application's DELETE.
    await db.delete(orgs).where(inArray(orgs.id, [orgA, orgB]));

    await Promise.all([appPool!.end(), bypassPool!.end()]);
  });

  it('PROOF · a transaction that fails leaves no audit row', async () => {
    const rolledBack = `workspace:rolled-back-${randomUUID()}`;
    const committed = `workspace:committed-${randomUUID()}`;

    await expect(
      runner.runInTenantTransaction(orgA, async (tx) => {
        await tx.insert(workspaces).values({ name: rolledBack, orgId: orgA });

        await audit.record(tx, {
          action: 'workspace.created',
          actorId: null,
          orgId: orgA,
          target: rolledBack,
        });

        throw new Error('the mutation failed after auditing');
      }),
    ).rejects.toThrow('the mutation failed after auditing');

    expect(await auditRowsFor(rolledBack), 'the audit row outlived the transaction').toEqual([]);

    // Paired, because the state change and its record have to share one fate in both directions.
    const survivors = await runner.runInTenantTransaction(orgA, (tx) =>
      tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.name, rolledBack)),
    );

    expect(survivors, 'the workspace outlived the transaction').toEqual([]);

    // The control. Without it every assertion above is satisfied by a `record()` that writes
    // nothing at all, and this file would pass against an empty method body.
    await runner.runInTenantTransaction(orgA, async (tx) => {
      await tx.insert(workspaces).values({ name: committed, orgId: orgA });

      await audit.record(tx, {
        action: 'workspace.created',
        actorId: null,
        orgId: orgA,
        target: committed,
      });
    });

    expect(
      await auditRowsFor(committed),
      'record() writes nothing even when the transaction commits, so the proof above is vacuous',
    ).toHaveLength(1);
  });

  /**
   * The other direction of the same coupling, and the one that is easy to lose later: a `try`/
   * `catch` around the append would turn a refused audit write into a state change that committed
   * unrecorded. Nothing here catches, so the failed statement poisons the caller's transaction and
   * takes the mutation with it.
   *
   * The failure is provoked the way it would really arrive — an entry filed under the wrong tenant,
   * which `tenant_isolation`'s `WITH CHECK` refuses with 42501.
   */
  it('fails the mutation when the audit write is refused', async () => {
    const name = `workspace:unaudited-${randomUUID()}`;

    const error = await runner
      .runInTenantTransaction(orgA, async (tx) => {
        await tx.insert(workspaces).values({ name, orgId: orgA });

        await audit.record(tx, {
          action: 'workspace.created',
          actorId: null,
          orgId: orgB,
          target: name,
        });
      })
      .then(() => undefined)
      .catch(driverError);

    expect(error, 'the refused audit write did not fail the mutation').toBeDefined();
    expect(error?.code).toBe('42501');

    const survivors = await runner.runInTenantTransaction(orgA, (tx) =>
      tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.name, name)),
    );

    expect(survivors, 'a state change committed without the audit row it needed').toEqual([]);
    expect(await auditRowsFor(name), 'the misfiled entry landed under the wrong tenant').toEqual(
      [],
    );
  });

  it('stamps `at` from the injected clock, never the host clock', async () => {
    const target = `workspace:clocked-${randomUUID()}`;

    await runner.runInTenantTransaction(orgA, (tx) =>
      audit.record(tx, {
        action: 'workspace.created',
        actorId: null,
        orgId: orgA,
        target,
      }),
    );

    const [row] = await auditRowsFor(target);

    expect(row!.at).toEqual(FROZEN);
  });

  it('records the org, actor, action, target and metadata it was given', async () => {
    const target = `membership:${randomUUID()}`;
    const actorId = randomUUID();

    await runner.runInTenantTransaction(orgA, (tx) =>
      audit.record(tx, {
        action: 'membership.role-changed',
        actorId,
        metadata: { from: 'member', to: 'admin' },
        orgId: orgA,
        target,
      }),
    );

    const [row] = await auditRowsFor(target);

    expect(row).toMatchObject({
      action: 'membership.role-changed',
      actorId,
      metadata: { from: 'member', to: 'admin' },
      orgId: orgA,
      target,
    });
  });

  /**
   * `not null default '{}'`, so an omitted `metadata` has to arrive as an empty object rather than
   * as `null` — a reader that has to handle both is a reader that will handle one of them wrongly.
   */
  it('writes an empty metadata object when the caller omits it', async () => {
    const target = `workspace:bare-${randomUUID()}`;

    await runner.runInTenantTransaction(orgA, (tx) =>
      audit.record(tx, {
        action: 'workspace.deleted',
        actorId: null,
        orgId: orgA,
        target,
      }),
    );

    const [row] = await auditRowsFor(target);

    expect(row!.metadata).toEqual({});
  });
});
