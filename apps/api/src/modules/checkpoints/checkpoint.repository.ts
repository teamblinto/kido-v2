import { Injectable } from '@nestjs/common';
import type { RunStatus } from '@repo/contracts';
import {
  agentRuns,
  type Checkpoint,
  checkpoints,
  type NewCheckpoint,
  projects,
  sandboxes,
} from '@repo/db';
import { and, desc, eq, gt, isNotNull, lt, notInArray, or, sql } from 'drizzle-orm';

import { DomainError } from '../../common/errors/domain-error';
import type { TenantTransaction } from '../../database/database.types';

/** A page of the history, newest first, and where the next page starts (contracts § 2). */
export interface CheckpointPage {
  readonly items: Checkpoint[];
  readonly nextCursor: string | null;
}

/**
 * A run in one of these holds no writer on the workspace. Spelled out here rather than imported
 * from `agent/run-state-machine`: `agent → checkpoints` is the edge the turn-end commit needs, so
 * the reverse would be a cycle (research R4).
 */
const TERMINAL_RUN_STATUSES: RunStatus[] = ['cancelled', 'failed', 'succeeded'];

/** `(created_at, id)` as one opaque token: the ISO instant and the uuid, base64url. */
function encodeCursor(row: Pick<Checkpoint, 'createdAt' | 'id'>): string {
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
 * The one thing that touches `checkpoints` (spec 016, data-model.md). Every method takes the
 * transaction it runs in, as `RunStore` does, so the caller decides what commits together — the
 * row and its outbox event, the revert's check and its insert. Insert-only: `mirrored_at` is the
 * one column an update may name, and the grant says so
 * (`migrations/0018_checkpoints_are_append_only.sql`).
 */
@Injectable()
export class CheckpointRepository {
  /**
   * The project's one writer, for the rest of `tx`: read-head → git → insert (and bundle → PUT)
   * runs whole before the next worker's, on any number of API processes. Nothing else serialises
   * runs of one project (008 does not), so the linear chain of FR-004/FR-010 rests on this.
   */
  async lockProject(tx: TenantTransaction, projectId: string): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${projectId}))`);
  }

  /**
   * `on conflict (org_id, project_id, git_sha) do nothing`, then read the row by sha: a resumed
   * attempt re-commits to the same sha and lands on the same row (research R5).
   */
  async insertOrGetBySha(tx: TenantTransaction, row: NewCheckpoint): Promise<Checkpoint> {
    const [inserted] = await tx.insert(checkpoints).values(row).onConflictDoNothing().returning();

    if (inserted !== undefined) return inserted;

    const [existing] = await tx
      .select()
      .from(checkpoints)
      .where(
        and(
          eq(checkpoints.orgId, row.orgId),
          eq(checkpoints.projectId, row.projectId),
          eq(checkpoints.gitSha, row.gitSha),
        ),
      );

    return existing!;
  }

  /** The project's newest row by `(created_at, id)` — the head (data-model § Derived state). */
  async head(tx: TenantTransaction, orgId: string, projectId: string): Promise<Checkpoint | null> {
    const [row] = await tx
      .select()
      .from(checkpoints)
      .where(and(eq(checkpoints.orgId, orgId), eq(checkpoints.projectId, projectId)))
      .orderBy(desc(checkpoints.createdAt), desc(checkpoints.id))
      .limit(1);

    return row ?? null;
  }

  async byId(tx: TenantTransaction, orgId: string, id: string): Promise<Checkpoint | null> {
    const [row] = await tx
      .select()
      .from(checkpoints)
      .where(and(eq(checkpoints.orgId, orgId), eq(checkpoints.id, id)));

    return row ?? null;
  }

  /** Newest first, keyset on `(created_at, id)` over the list index; `limit + 1` decides the cursor. */
  async list(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
    page: { cursor?: string; limit: number },
  ): Promise<CheckpointPage> {
    const after = page.cursor === undefined ? undefined : decodeCursor(page.cursor);
    const rows = await tx
      .select()
      .from(checkpoints)
      .where(
        and(
          eq(checkpoints.orgId, orgId),
          eq(checkpoints.projectId, projectId),
          after === undefined
            ? undefined
            : or(
                lt(checkpoints.createdAt, after.at),
                and(eq(checkpoints.createdAt, after.at), lt(checkpoints.id, after.id)),
              ),
        ),
      )
      .orderBy(desc(checkpoints.createdAt), desc(checkpoints.id))
      .limit(page.limit + 1);
    const items = rows.slice(0, page.limit);

    return {
      items,
      nextCursor: rows.length > page.limit ? encodeCursor(items.at(-1)!) : null,
    };
  }

  /**
   * Sets `mirrored_at` once; a row already marked is left as it was (FR-019). Raw SQL rather than
   * `tx.update`, which would also bump `updated_at` (`timestamps.$onUpdate`) — a column the grant
   * does not let the app role touch (42501).
   */
  async markMirrored(tx: TenantTransaction, orgId: string, id: string, at: Date): Promise<void> {
    await tx.execute(sql`
      update ${checkpoints} set mirrored_at = ${at}
      where org_id = ${orgId} and id = ${id} and mirrored_at is null
    `);
  }

  /** A later checkpoint of the same project is mirrored, so its bundle already carries this one (FR-019). */
  async laterMirroredExists(tx: TenantTransaction, row: Checkpoint): Promise<boolean> {
    const [later] = await tx
      .select({ id: checkpoints.id })
      .from(checkpoints)
      .where(
        and(
          eq(checkpoints.orgId, row.orgId),
          eq(checkpoints.projectId, row.projectId),
          isNotNull(checkpoints.mirroredAt),
          or(
            gt(checkpoints.createdAt, row.createdAt),
            and(eq(checkpoints.createdAt, row.createdAt), gt(checkpoints.id, row.id)),
          ),
        ),
      )
      .limit(1);

    return later !== undefined;
  }

  /**
   * Whether a run of the project is non-terminal — the revert's one-writer check. Reads
   * `agent_runs` through the `@repo/db` schema, not through `agent`'s store: the constitution
   * forbids the repository file, not the shared table, and the other direction is a cycle (R4).
   */
  async activeRunExists(tx: TenantTransaction, orgId: string, projectId: string): Promise<boolean> {
    const [run] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, orgId),
          eq(agentRuns.projectId, projectId),
          notInArray(agentRuns.status, TERMINAL_RUN_STATUSES),
        ),
      )
      .limit(1);

    return run !== undefined;
  }

  /**
   * The baseline label's two halves: `projects.template` and the sandbox's `template_snapshot`,
   * read through the schema for R4's reason (research R10). Each half null when the project has
   * no sandbox yet or pre-dates the catalogue; the whole null when there is no such project.
   */
  async projectTemplate(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
  ): Promise<{ snapshot: string | null; template: string | null } | null> {
    const [row] = await tx
      .select({ snapshot: sandboxes.templateSnapshot, template: projects.template })
      .from(projects)
      .leftJoin(
        sandboxes,
        and(eq(sandboxes.orgId, projects.orgId), eq(sandboxes.projectId, projects.id)),
      )
      .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)));

    return row === undefined ? null : { snapshot: row.snapshot, template: row.template };
  }
}
