import { Injectable } from '@nestjs/common';
import type { DeploymentFailureReason } from '@repo/contracts';
import { type Deployment, schema } from '@repo/db';
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';

import { DomainError } from '../../common/errors/domain-error';
import type { TenantTransaction } from '../../database/database.types';
import { IN_FLIGHT_STATES, QUEUED_STALE_AFTER_MS } from './deploy.constants';

const deployments = schema.deployments;

/** Postgres's `unique_violation` (copied from `connectors/sync.repository.ts`; no edge to it). */
const UNIQUE_VIOLATION = '23505';

/** Drizzle wraps the driver error; the SQLSTATE is a bounded `cause` walk away. */
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

/** What a request writes; the rest are column defaults (`queued`, epoch 0, `forge-static`). */
export interface QueuedDeploymentDraft {
  readonly checkpointId: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly requestedBy: string;
  readonly template: string;
}

export interface DeploymentPage {
  readonly items: Deployment[];
  readonly nextCursor: string | null;
}

/** A row the sweep settled — enough for its `deploy.failed` event. */
export interface SweptDeployment {
  readonly checkpointId: string;
  readonly id: string;
  readonly projectId: string;
}

/** The states a claimed worker is in; every fenced write needs one of these as well as its epoch. */
const CLAIMED_STATES = ['building', 'uploading'] as const;

/**
 * `(created_at, id)` as one opaque token. Copied from `connectors/sync.repository.ts` rather than
 * shared: each module owns its cursor, as the checkpoint and sync lists each do.
 */
function encodeCursor(row: Pick<Deployment, 'createdAt' | 'id'>): string {
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
 * The `deployments` rows (spec 027, data-model.md, research R8). One in flight per project, held
 * by the partial unique index `deployments_one_in_flight`. A worker `claim`s (epoch + 1) and every
 * later write carries `lease_epoch = $epoch`: zero rows means fenced out. Every write also names
 * the states it may leave, so a terminal row (`succeeded`, `failed`, `cancelled`) is never
 * updated again. The fenced writes answer `true` when they landed.
 */
@Injectable()
export class DeploymentRepository {
  /**
   * Inserts the `queued` row, or answers `undefined` when another deployment of the project is in
   * flight (`23505` on `deployments_one_in_flight`, FR-004's second net). The insert runs in a
   * savepoint so the refusal leaves the caller's transaction usable for the `deploy-active`
   * answer's `inFlight` read.
   */
  async insertQueued(
    tx: TenantTransaction,
    draft: QueuedDeploymentDraft,
  ): Promise<Deployment | undefined> {
    try {
      return await tx.transaction(async (savepoint) => {
        const [row] = await savepoint
          .insert(deployments)
          .values({ ...draft, state: 'queued' })
          .returning();

        return row!;
      });
    } catch (error) {
      if (isUniqueViolation(error)) return undefined;
      throw error;
    }
  }

  async inFlight(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
  ): Promise<Deployment | undefined> {
    const [row] = await tx
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.orgId, orgId),
          eq(deployments.projectId, projectId),
          inArray(deployments.state, [...IN_FLIGHT_STATES]),
        ),
      )
      .limit(1);

    return row;
  }

  async byId(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
    id: string,
  ): Promise<Deployment | undefined> {
    const [row] = await tx
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.orgId, orgId),
          eq(deployments.projectId, projectId),
          eq(deployments.id, id),
        ),
      );

    return row;
  }

  /** Newest first, keyset on `(created_at, id)` over the list index; `limit + 1` decides the cursor. */
  async list(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
    page: { cursor?: string | undefined; limit: number },
  ): Promise<DeploymentPage> {
    const after = page.cursor === undefined ? undefined : decodeCursor(page.cursor);
    const rows = await tx
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.orgId, orgId),
          eq(deployments.projectId, projectId),
          after === undefined
            ? undefined
            : or(
                lt(deployments.createdAt, after.at),
                and(eq(deployments.createdAt, after.at), lt(deployments.id, after.id)),
              ),
        ),
      )
      .orderBy(desc(deployments.createdAt), desc(deployments.id))
      .limit(page.limit + 1);
    const items = rows.slice(0, page.limit);

    return { items, nextCursor: rows.length > page.limit ? encodeCursor(items.at(-1)!) : null };
  }

  /**
   * R8's claim: `queued` or a re-delivered `building` row moves to `building` with a new epoch and
   * one more attempt; `started_at` is this claim's, so the stale sweep measures the attempt that is
   * running rather than the first one. A row past the upload boundary (`upload_started_at` set), a
   * terminal row or an unknown id answers `undefined`.
   */
  async claim(
    tx: TenantTransaction,
    orgId: string,
    id: string,
    now: Date,
  ): Promise<Deployment | undefined> {
    const [row] = await tx
      .update(deployments)
      .set({
        attempts: sql`${deployments.attempts} + 1`,
        leaseEpoch: sql`${deployments.leaseEpoch} + 1`,
        startedAt: now,
        state: 'building',
      })
      .where(
        and(
          eq(deployments.orgId, orgId),
          eq(deployments.id, id),
          inArray(deployments.state, ['queued', 'building']),
          isNull(deployments.uploadStartedAt),
        ),
      )
      .returning();

    return row;
  }

  /** FR-012's toolchain pin, written by the claimed worker once it knows the snapshot. */
  async recordToolchain(
    tx: TenantTransaction,
    orgId: string,
    id: string,
    epoch: number,
    pin: { templateDigest: string; templateSnapshot: string },
  ): Promise<boolean> {
    return this.fenced(tx, orgId, id, epoch, ['building'], pin);
  }

  /** The retry boundary (R8): written, fenced, before the first object PUT. */
  async markUploading(
    tx: TenantTransaction,
    orgId: string,
    id: string,
    epoch: number,
    now: Date,
  ): Promise<boolean> {
    return this.fenced(tx, orgId, id, epoch, ['building'], {
      state: 'uploading',
      uploadStartedAt: now,
    });
  }

  /** The scrubbed tail (≤ 64 KiB — the caller caps and scrubs; the CHECK refuses anything longer). */
  async writeLog(
    tx: TenantTransaction,
    orgId: string,
    id: string,
    epoch: number,
    logTail: string,
  ): Promise<boolean> {
    return this.fenced(tx, orgId, id, epoch, CLAIMED_STATES, { logTail });
  }

  /** The go-live transaction's fenced flip; only an `uploading` row can succeed. */
  async succeed(
    tx: TenantTransaction,
    orgId: string,
    id: string,
    epoch: number,
    outcome: {
      artifactSha: string;
      fileCount: number;
      finishedAt: Date;
      logTail?: string;
      totalBytes: number;
    },
  ): Promise<boolean> {
    return this.fenced(tx, orgId, id, epoch, ['uploading'], { ...outcome, state: 'succeeded' });
  }

  /** The claimed worker's own settle: a user failure, or `platform` on its last attempt. */
  async fail(
    tx: TenantTransaction,
    orgId: string,
    id: string,
    epoch: number,
    outcome: { finishedAt: Date; logTail?: string; reason: DeploymentFailureReason },
  ): Promise<boolean> {
    const { reason, ...rest } = outcome;

    return this.fenced(tx, orgId, id, epoch, CLAIMED_STATES, {
      ...rest,
      failureReason: reason,
      state: 'failed',
    });
  }

  /**
   * FR-015: a re-delivered job whose row is past the upload boundary is not retried — it is settled
   * `failed / platform` here, with an epoch bump so the stalled worker that held it writes nothing.
   */
  async failPastUpload(
    tx: TenantTransaction,
    orgId: string,
    id: string,
    now: Date,
  ): Promise<boolean> {
    const rows = await tx
      .update(deployments)
      .set({
        failureReason: 'platform',
        finishedAt: now,
        leaseEpoch: sql`${deployments.leaseEpoch} + 1`,
        state: 'failed',
      })
      .where(
        and(
          eq(deployments.orgId, orgId),
          eq(deployments.id, id),
          inArray(deployments.state, [...CLAIMED_STATES]),
          isNotNull(deployments.uploadStartedAt),
        ),
      )
      .returning({ id: deployments.id });

    return rows.length > 0;
  }

  /**
   * `handle`'s own fault (research R8): a row still in flight — whatever the failed attempt had
   * reached — is settled `failed / platform` with an epoch bump, so it does not sit `queued` or
   * `building` holding the in-flight slot after its job was dead-lettered.
   */
  async failInFlight(
    tx: TenantTransaction,
    orgId: string,
    id: string,
    now: Date,
  ): Promise<boolean> {
    const rows = await tx
      .update(deployments)
      .set({
        failureReason: 'platform',
        finishedAt: now,
        leaseEpoch: sql`${deployments.leaseEpoch} + 1`,
        state: 'failed',
      })
      .where(
        and(
          eq(deployments.orgId, orgId),
          eq(deployments.id, id),
          inArray(deployments.state, [...IN_FLIGHT_STATES]),
        ),
      )
      .returning({ id: deployments.id });

    return rows.length > 0;
  }

  /** Archive / offline (US5): the project's in-flight row is `cancelled` and its epoch bumped. */
  async cancelInFlight(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
    now: Date,
  ): Promise<string[]> {
    const rows = await tx
      .update(deployments)
      .set({
        finishedAt: now,
        leaseEpoch: sql`${deployments.leaseEpoch} + 1`,
        state: 'cancelled',
      })
      .where(
        and(
          eq(deployments.orgId, orgId),
          eq(deployments.projectId, projectId),
          inArray(deployments.state, [...IN_FLIGHT_STATES]),
        ),
      )
      .returning({ id: deployments.id });

    return rows.map((row) => row.id);
  }

  /**
   * R8's sweep (`deploy.sweep`): `building`/`uploading` rows whose current attempt was claimed
   * before `olderThan`, and `queued` rows created more than `QUEUED_STALE_AFTER_MS` ago by the
   * database's clock (a job lost or dead-lettered before any claim), are failed `platform` with an
   * epoch bump, so a dead job stops holding the in-flight slot.
   */
  async failStale(
    tx: TenantTransaction,
    orgId: string,
    olderThan: Date,
    now: Date,
  ): Promise<SweptDeployment[]> {
    return tx
      .update(deployments)
      .set({
        failureReason: 'platform',
        finishedAt: now,
        leaseEpoch: sql`${deployments.leaseEpoch} + 1`,
        state: 'failed',
      })
      .where(
        and(
          eq(deployments.orgId, orgId),
          or(
            and(
              inArray(deployments.state, [...CLAIMED_STATES]),
              lt(deployments.startedAt, olderThan),
            ),
            and(
              eq(deployments.state, 'queued'),
              lt(
                deployments.createdAt,
                sql`now() - ${sql.raw(`interval '${String(QUEUED_STALE_AFTER_MS)} milliseconds'`)}`,
              ),
            ),
          ),
        ),
      )
      .returning({
        checkpointId: deployments.checkpointId,
        id: deployments.id,
        projectId: deployments.projectId,
      });
  }

  private async fenced(
    tx: TenantTransaction,
    orgId: string,
    id: string,
    epoch: number,
    from: readonly Deployment['state'][],
    values: Partial<typeof deployments.$inferInsert>,
  ): Promise<boolean> {
    const rows = await tx
      .update(deployments)
      .set(values)
      .where(
        and(
          eq(deployments.orgId, orgId),
          eq(deployments.id, id),
          eq(deployments.leaseEpoch, epoch),
          inArray(deployments.state, [...from]),
        ),
      )
      .returning({ id: deployments.id });

    return rows.length > 0;
  }
}
