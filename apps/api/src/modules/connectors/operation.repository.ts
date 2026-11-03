import { Injectable } from '@nestjs/common';
import type { ConnectorOpReason } from '@repo/contracts';
import { type ConnectorOperation, type NewConnectorOperation, schema } from '@repo/db';
import { and, desc, eq, inArray, lt, ne, or, sql } from 'drizzle-orm';

import { DomainError } from '../../common/errors/domain-error';
import type { TenantTransaction } from '../../database/database.types';
import { connectorRefusal } from './connectors.errors';
import { isUniqueViolation } from './sync.repository';

/**
 * data-model § 5: a Netlify publish is timed out after 30 minutes, not the sweep's default, as its
 * upload time scales with the release. Re-exported by `connector-ops.consumer.ts`.
 */
export const STALE_PUBLISH_MS = 30 * 60_000;

export interface OperationPage {
  readonly items: ConnectorOperation[];
  readonly nextCursor: string | null;
}

/** `(created_at, id)` as one opaque token, as the sync list's. */
function encodeCursor(row: Pick<ConnectorOperation, 'createdAt' | 'id'>): string {
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

const OPEN = ['queued', 'running'] as const;

/**
 * The `connector_operations` rows (spec 030 data-model § 5): `queued → running → succeeded |
 * failed`, forward only — every write names the states it may leave, so a row the timeout sweep
 * already closed stays closed. One publish or branch change in flight per binding, held by the
 * partial unique index and surfaced as `in-flight`.
 */
@Injectable()
export class OperationRepository {
  /**
   * Inserts a `queued` row. The insert runs under a savepoint, so the in-flight index refusing it
   * answers `409 in-flight` and leaves the caller's transaction usable.
   */
  async insertQueued(
    tx: TenantTransaction,
    draft: Omit<NewConnectorOperation, 'reason' | 'state'>,
  ): Promise<ConnectorOperation> {
    try {
      return await tx.transaction(async (savepoint) => {
        const [row] = await savepoint
          .insert(schema.connectorOperations)
          .values({
            // clock_timestamp(), not now(): two requests in one transaction must still
            // order by creation, or latestForBindings breaks the tie on a random id.
            createdAt: sql`clock_timestamp()`,
            ...draft,
            state: 'queued',
          })
          .returning();

        return row!;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw connectorRefusal('in-flight');
      }

      throw error;
    }
  }

  async byId(
    tx: TenantTransaction,
    orgId: string,
    id: string,
  ): Promise<ConnectorOperation | undefined> {
    const [row] = await tx
      .select()
      .from(schema.connectorOperations)
      .where(
        and(eq(schema.connectorOperations.orgId, orgId), eq(schema.connectorOperations.id, id)),
      );

    return row;
  }

  /** `queued → running`; false when the row had already moved on. */
  async markRunning(tx: TenantTransaction, orgId: string, id: string, now: Date): Promise<boolean> {
    const rows = await tx
      .update(schema.connectorOperations)
      .set({ startedAt: now, state: 'running', updatedAt: now })
      .where(
        and(
          eq(schema.connectorOperations.orgId, orgId),
          eq(schema.connectorOperations.id, id),
          eq(schema.connectorOperations.state, 'queued'),
        ),
      )
      .returning({ id: schema.connectorOperations.id });

    return rows.length > 0;
  }

  /** An open row closes, `failed` with its reason or `succeeded` with none; false when already closed. */
  async markDone(
    tx: TenantTransaction,
    orgId: string,
    id: string,
    outcome:
      | { readonly state: 'succeeded'; readonly finishedAt: Date }
      | { readonly state: 'failed'; readonly reason: ConnectorOpReason; readonly finishedAt: Date },
  ): Promise<boolean> {
    const rows = await tx
      .update(schema.connectorOperations)
      .set({
        finishedAt: outcome.finishedAt,
        reason: outcome.state === 'failed' ? outcome.reason : null,
        state: outcome.state,
        updatedAt: outcome.finishedAt,
      })
      .where(
        and(
          eq(schema.connectorOperations.orgId, orgId),
          eq(schema.connectorOperations.id, id),
          inArray(schema.connectorOperations.state, [...OPEN]),
        ),
      )
      .returning({ id: schema.connectorOperations.id });

    return rows.length > 0;
  }

  /** R11: the provider's own id for the write, recorded as soon as it is known. */
  async setProgress(
    tx: TenantTransaction,
    orgId: string,
    id: string,
    progress: { readonly externalRef?: string; readonly providerState?: string },
  ): Promise<void> {
    await tx
      .update(schema.connectorOperations)
      .set(progress)
      .where(
        and(
          eq(schema.connectorOperations.orgId, orgId),
          eq(schema.connectorOperations.id, id),
          inArray(schema.connectorOperations.state, [...OPEN]),
        ),
      );
  }

  /** A project's operations, newest first, keyset on `(created_at, id)`; `limit + 1` decides the cursor. */
  async listForProject(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
    page: { cursor?: string; kind?: ConnectorOperation['kind']; limit: number },
  ): Promise<OperationPage> {
    const after = page.cursor === undefined ? undefined : decodeCursor(page.cursor);
    const table = schema.connectorOperations;
    const rows = await tx
      .select()
      .from(table)
      .where(
        and(
          eq(table.orgId, orgId),
          eq(table.projectId, projectId),
          page.kind === undefined ? undefined : eq(table.kind, page.kind),
          after === undefined
            ? undefined
            : or(
                lt(table.createdAt, after.at),
                and(eq(table.createdAt, after.at), lt(table.id, after.id)),
              ),
        ),
      )
      .orderBy(desc(table.createdAt), desc(table.id))
      .limit(page.limit + 1);
    const items = rows.slice(0, page.limit);

    return { items, nextCursor: rows.length > page.limit ? encodeCursor(items.at(-1)!) : null };
  }

  /** The latest operation of each of these bindings (the bindings list shows one each). */
  async latestForBindings(
    tx: TenantTransaction,
    orgId: string,
    bindingIds: readonly string[],
  ): Promise<Map<string, ConnectorOperation>> {
    if (bindingIds.length === 0) return new Map();

    const rows = await tx
      .selectDistinctOn([schema.connectorOperations.bindingId])
      .from(schema.connectorOperations)
      .where(
        and(
          eq(schema.connectorOperations.orgId, orgId),
          inArray(schema.connectorOperations.bindingId, [...bindingIds]),
        ),
      )
      .orderBy(
        schema.connectorOperations.bindingId,
        desc(schema.connectorOperations.createdAt),
        desc(schema.connectorOperations.id),
      );

    return new Map(rows.map((row) => [row.bindingId!, row]));
  }

  async listForDomain(
    tx: TenantTransaction,
    orgId: string,
    domainId: string,
  ): Promise<ConnectorOperation[]> {
    return tx
      .select()
      .from(schema.connectorOperations)
      .where(
        and(
          eq(schema.connectorOperations.orgId, orgId),
          eq(schema.connectorOperations.domainId, domainId),
        ),
      )
      .orderBy(desc(schema.connectorOperations.createdAt));
  }

  /**
   * The timeout sweep's arm: `running` rows of the organisation started before `olderThan` — and,
   * for a Netlify publish, also more than `STALE_PUBLISH_MS` ago by the database's clock.
   */
  async staleRunning(
    tx: TenantTransaction,
    orgId: string,
    olderThan: Date,
  ): Promise<ConnectorOperation[]> {
    return tx
      .select()
      .from(schema.connectorOperations)
      .where(
        and(
          eq(schema.connectorOperations.orgId, orgId),
          eq(schema.connectorOperations.state, 'running'),
          lt(schema.connectorOperations.startedAt, olderThan),
          or(
            ne(schema.connectorOperations.kind, 'netlify_publish'),
            lt(
              schema.connectorOperations.startedAt,
              sql`now() - ${sql.raw(`interval '${String(STALE_PUBLISH_MS)} milliseconds'`)}`,
            ),
          ),
        ),
      );
  }
}
