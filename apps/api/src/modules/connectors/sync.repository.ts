import { Injectable } from '@nestjs/common';
import type { SyncFailureReason } from '@repo/contracts';
import { type NewSyncOperation, schema, type SyncOperation } from '@repo/db';
import { and, desc, eq, getTableColumns, inArray, lt, or } from 'drizzle-orm';

import { DomainError } from '../../common/errors/domain-error';
import type { TenantTransaction } from '../../database/database.types';

/** A `sync_operations` row with the one derived column the contract needs: who asked. */
export interface SyncRecord extends SyncOperation {
  readonly requestedByName: string;
}

export interface SyncPage {
  readonly items: SyncRecord[];
  readonly nextCursor: string | null;
}

/** Postgres's `unique_violation`: the partial index `sync_operations_one_in_flight` held (R7). */
const UNIQUE_VIOLATION = '23505';

/** Drizzle wraps the driver error; the SQLSTATE is a bounded `cause` walk away (as `SandboxClaim`). */
export function isUniqueViolation(error: unknown): boolean {
  for (
    let cause = error, depth = 0;
    typeof cause === 'object' && cause !== null && depth < 5;
    depth++
  ) {
    if ((cause as { code?: unknown }).code === UNIQUE_VIOLATION) return true;
    cause = (cause as { cause?: unknown }).cause;
  }

  return false;
}

/** `(created_at, id)` as one opaque token, as the checkpoint list's. */
function encodeCursor(row: Pick<SyncOperation, 'createdAt' | 'id'>): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url');
}

function decodeCursor(cursor: string): { at: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const at = new Date(iso ?? '');

  if (id === undefined || Number.isNaN(at.getTime())) {
    throw new DomainError('bad-request', 'The cursor is not one this list issued.');
  }

  return { at, id };
}

/**
 * The `sync_operations` rows (spec 018, data-model.md): one `queued`/`running` per project, held
 * by the partial unique index; the consumers move a row forward, never back.
 */
@Injectable()
export class SyncRepository {
  private query(tx: TenantTransaction) {
    return tx
      .select({ ...getTableColumns(schema.syncOperations), requestedByName: schema.users.email })
      .from(schema.syncOperations)
      .innerJoin(schema.users, eq(schema.users.id, schema.syncOperations.requestedBy));
  }

  /** Throws the driver's unique violation when another operation is in flight; the caller maps it. */
  async insertQueued(
    tx: TenantTransaction,
    draft: Omit<NewSyncOperation, 'state'>,
  ): Promise<SyncOperation> {
    const [row] = await tx
      .insert(schema.syncOperations)
      .values({ ...draft, state: 'queued' })
      .returning();

    return row!;
  }

  async markRunning(tx: TenantTransaction, orgId: string, id: string, now: Date): Promise<void> {
    await tx
      .update(schema.syncOperations)
      .set({ startedAt: now, state: 'running' })
      .where(and(eq(schema.syncOperations.orgId, orgId), eq(schema.syncOperations.id, id)));
  }

  async markDone(
    tx: TenantTransaction,
    orgId: string,
    id: string,
    outcome: {
      commits?: number;
      finishedAt: Date;
      fromSha?: string | null;
      reason: SyncFailureReason | null;
      state: 'failed' | 'succeeded';
      toSha?: string | null;
    },
  ): Promise<number> {
    // Only an open row closes: the sweep may have closed it `timed-out` while the effect ran.
    const rows = await tx
      .update(schema.syncOperations)
      .set(outcome)
      .where(
        and(
          eq(schema.syncOperations.orgId, orgId),
          eq(schema.syncOperations.id, id),
          inArray(schema.syncOperations.state, ['queued', 'running']),
        ),
      )
      .returning({ id: schema.syncOperations.id });

    return rows.length;
  }

  async byId(tx: TenantTransaction, orgId: string, id: string): Promise<SyncRecord | undefined> {
    const [row] = await this.query(tx).where(
      and(eq(schema.syncOperations.orgId, orgId), eq(schema.syncOperations.id, id)),
    );

    return row;
  }

  /** Newest first, keyset on `(created_at, id)` over the list index; `limit + 1` decides the cursor. */
  async list(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
    page: { cursor?: string; limit: number },
  ): Promise<SyncPage> {
    const after = page.cursor === undefined ? undefined : decodeCursor(page.cursor);
    const rows = await this.query(tx)
      .where(
        and(
          eq(schema.syncOperations.orgId, orgId),
          eq(schema.syncOperations.projectId, projectId),
          after === undefined
            ? undefined
            : or(
                lt(schema.syncOperations.createdAt, after.at),
                and(
                  eq(schema.syncOperations.createdAt, after.at),
                  lt(schema.syncOperations.id, after.id),
                ),
              ),
        ),
      )
      .orderBy(desc(schema.syncOperations.createdAt), desc(schema.syncOperations.id))
      .limit(page.limit + 1);
    const items = rows.slice(0, page.limit);

    return { items, nextCursor: rows.length > page.limit ? encodeCursor(items.at(-1)!) : null };
  }

  async inFlightExists(tx: TenantTransaction, orgId: string, projectId: string): Promise<boolean> {
    const [row] = await tx
      .select({ id: schema.syncOperations.id })
      .from(schema.syncOperations)
      .where(
        and(
          eq(schema.syncOperations.orgId, orgId),
          eq(schema.syncOperations.projectId, projectId),
          inArray(schema.syncOperations.state, ['queued', 'running']),
        ),
      )
      .limit(1);

    return row !== undefined;
  }

  /** R7: `running` rows started before `olderThan` — the daily job closes them as `timed-out`. */
  async staleRunning(
    tx: TenantTransaction,
    orgId: string,
    olderThan: Date,
  ): Promise<SyncOperation[]> {
    return tx
      .select()
      .from(schema.syncOperations)
      .where(
        and(
          eq(schema.syncOperations.orgId, orgId),
          eq(schema.syncOperations.state, 'running'),
          lt(schema.syncOperations.startedAt, olderThan),
        ),
      );
  }
}
