import { Injectable } from '@nestjs/common';
import type { WebhookAttemptFailure, WebhookDeliveryState } from '@repo/contracts';
import { schema, type WebhookSend, type WebhookSendAttempt } from '@repo/db';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';

import { DomainError } from '../../../common/errors/domain-error';
import type { ForgeDatabase, TenantTransaction } from '../../../database/database.types';
import {
  BODY_RETENTION_DAYS,
  CLAIM_LEASE_MS,
  DELIVERY_PAGE_SIZE,
  IN_FLIGHT_PER_ORG,
  ROW_RETENTION_DAYS,
} from '../webhooks.constants';

/** How long a fairness deferral moves a send (research R9). */
export const FAIRNESS_DEFER_MS = 5_000;

const { webhookEndpoints, webhookSendAttempts, webhookSends } = schema;

export type SendRow = WebhookSend;
export type AttemptRow = WebhookSendAttempt;

/** The log's filters and position (research R11). */
export interface LogQuery {
  readonly cursor?: string | undefined;
  readonly eventType?: string | undefined;
  readonly state?: WebhookDeliveryState | undefined;
}

export interface OutboundRetentionReport {
  readonly bodiesNulled: number;
  readonly responsesNulled: number;
  readonly sendsDeleted: number;
}

export interface SendPage {
  readonly items: SendRow[];
  readonly nextCursor: string | null;
}

const DAY_MS = 86_400_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * `(created_at, id)` as one opaque token. Copied from `deploy/deployment.repository.ts` rather
 * than shared: each module owns its cursor.
 */
function encodeCursor(row: Pick<SendRow, 'createdAt' | 'id'>): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url');
}

function decodeCursor(cursor: string): { at: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const at = new Date(iso ?? '');

  if (id === undefined || !UUID.test(id) || Number.isNaN(at.getTime())) {
    throw new DomainError('bad-request', 'The cursor is not one this list issued.');
  }

  return { at, id };
}

/** The start of the log's 30-day window at `now` (FR-028). */
export function logWindowStart(now: Date): Date {
  return new Date(now.getTime() - ROW_RETENTION_DAYS * DAY_MS);
}

/** One row the fan-out (or send test) creates: `pending` when the endpoint is enabled. */
export interface SendDraft {
  readonly body: string;
  readonly endpointId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly now: Date;
  readonly occurredAt: Date;
  readonly orgId: string;
  readonly projectId: string | null;
  readonly state: 'not_sent' | 'pending';
}

export interface AttemptDraft {
  readonly address: string | null;
  readonly attemptedAt: Date;
  readonly durationMs: number;
  readonly failure: WebhookAttemptFailure | null;
  readonly manual: boolean;
  readonly orgId: string;
  readonly responseBody: string | null;
  readonly responseHeaders: Readonly<Record<string, string>> | null;
  readonly sendId: string;
  readonly status: number | null;
}

/**
 * How an attempt ended the send: `succeeded`, `failed`, or `pending` again with the schedule's
 * `nextAttemptAt` (research R7).
 */
export type SettleResult = {
  readonly failure: WebhookAttemptFailure | null;
  readonly manual: boolean;
  readonly now: Date;
} & (
  | { readonly state: 'failed' | 'succeeded' }
  | { readonly nextAttemptAt: Date; readonly state: 'pending' }
);

/** What the claim did: a lease on the row, a fairness deferral, or nothing to claim. */
export type ClaimResult =
  | { readonly kind: 'claimed'; readonly send: SendRow }
  | { readonly kind: 'deferred' }
  | { readonly kind: 'none' };

/** One due send the redelivery probe found, in the columns `forge_bypass` may read. */
export interface DueSend {
  readonly id: string;
  readonly orgId: string;
}

/**
 * `webhook_sends` and `webhook_send_attempts` (spec 029 data-model.md §§ 2–3). Every statement
 * runs on the caller's tenant transaction and names the org.
 */
@Injectable()
export class SendRepository {
  /**
   * One row per draft, deduplicated on `(endpoint_id, event_id)` (FR-011, SC-003): a redelivered
   * event inserts nothing and returns nothing, so it appends no second attempt.
   */
  async insertFanout(
    tx: TenantTransaction,
    drafts: readonly SendDraft[],
  ): Promise<Pick<SendRow, 'endpointId' | 'id' | 'state'>[]> {
    if (drafts.length === 0) return [];

    return tx
      .insert(webhookSends)
      .values(
        drafts.map((draft) => ({
          body: draft.body,
          createdAt: draft.now,
          endpointId: draft.endpointId,
          eventId: draft.eventId,
          eventType: draft.eventType,
          nextAttemptAt: draft.state === 'pending' ? draft.now : null,
          occurredAt: draft.occurredAt,
          orgId: draft.orgId,
          projectId: draft.projectId,
          state: draft.state,
          updatedAt: draft.now,
        })),
      )
      .onConflictDoNothing({ target: [webhookSends.endpointId, webhookSends.eventId] })
      .returning({
        endpointId: webhookSends.endpointId,
        id: webhookSends.id,
        state: webhookSends.state,
      });
  }

  async byId(tx: TenantTransaction, orgId: string, id: string): Promise<SendRow | undefined> {
    const [row] = await tx
      .select()
      .from(webhookSends)
      .where(and(eq(webhookSends.orgId, orgId), eq(webhookSends.id, id)));

    return row;
  }

  /**
   * The attempt lease (research R6): a `pending` send that no live lease holds gets
   * `claimed_until = now + 30 s`. The conditional `update` is the whole check, so of two
   * concurrent claims exactly one returns the row.
   *
   * Fairness first (research R9): when the org already has `IN_FLIGHT_PER_ORG` live leases, the
   * send is moved 5 s later instead, and no attempt is consumed.
   */
  async claim(
    tx: TenantTransaction,
    orgId: string,
    sendId: string,
    now: Date,
  ): Promise<ClaimResult> {
    // The endpoint before the send, the order a delete takes them in (see `lockEndpointsOf`).
    await this.lockEndpointsOf(tx, orgId, [sendId]);
    const unclaimed = or(isNull(webhookSends.claimedUntil), lt(webhookSends.claimedUntil, now));
    const [inFlight] = await tx
      .select({ total: count() })
      .from(webhookSends)
      .where(
        and(
          eq(webhookSends.orgId, orgId),
          gt(webhookSends.claimedUntil, now),
          ne(webhookSends.id, sendId),
        ),
      );

    if (inFlight!.total >= IN_FLIGHT_PER_ORG) {
      const deferred = await tx
        .update(webhookSends)
        .set({ nextAttemptAt: new Date(now.getTime() + FAIRNESS_DEFER_MS), updatedAt: now })
        .where(
          and(
            eq(webhookSends.orgId, orgId),
            eq(webhookSends.id, sendId),
            eq(webhookSends.state, 'pending'),
            unclaimed,
          ),
        )
        .returning({ id: webhookSends.id });

      return deferred.length > 0 ? { kind: 'deferred' } : { kind: 'none' };
    }

    const [row] = await tx
      .update(webhookSends)
      .set({ claimedUntil: new Date(now.getTime() + CLAIM_LEASE_MS), updatedAt: now })
      .where(
        and(
          eq(webhookSends.orgId, orgId),
          eq(webhookSends.id, sendId),
          eq(webhookSends.state, 'pending'),
          unclaimed,
        ),
      )
      .returning();

    return row === undefined ? { kind: 'none' } : { kind: 'claimed', send: row };
  }

  /** Drops a claim without an attempt, the send due again at `nextAttemptAt` (an open circuit). */
  async release(
    tx: TenantTransaction,
    orgId: string,
    sendId: string,
    nextAttemptAt: Date,
    now: Date,
  ): Promise<void> {
    await tx
      .update(webhookSends)
      .set({ claimedUntil: null, nextAttemptAt, updatedAt: now })
      .where(
        and(
          eq(webhookSends.orgId, orgId),
          eq(webhookSends.id, sendId),
          eq(webhookSends.state, 'pending'),
        ),
      );
  }

  /** The pause (data-model § 1): every `pending` send of the endpoint becomes `not_sent`. */
  async moveEndpointPendingToNotSent(
    tx: TenantTransaction,
    orgId: string,
    endpointId: string,
    now: Date,
  ): Promise<number> {
    const moved = await tx
      .update(webhookSends)
      .set({ claimedUntil: null, nextAttemptAt: null, state: 'not_sent', updatedAt: now })
      .where(
        and(
          eq(webhookSends.orgId, orgId),
          eq(webhookSends.endpointId, endpointId),
          eq(webhookSends.state, 'pending'),
        ),
      )
      .returning({ id: webhookSends.id });

    return moved.length;
  }

  /**
   * The org's dispatch lock (research R9), held to the end of `tx`: fan-out's budget check and an
   * attempt's dispatch of the next send run one at a time per org, so a send left undispatched is
   * always seen by the next attempt to finish, or by the sweep.
   */
  async lockDispatch(tx: TenantTransaction, orgId: string): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('webhook-dispatch:' || ${orgId}::text))`,
    );
  }

  /** The org's hot backlog: `pending` sends in flight, due, or dispatched within a lease. */
  async backlog(tx: TenantTransaction, orgId: string, now: Date): Promise<number> {
    const [row] = await tx
      .select({ total: count() })
      .from(webhookSends)
      .where(
        and(
          eq(webhookSends.orgId, orgId),
          eq(webhookSends.state, 'pending'),
          or(
            gt(webhookSends.claimedUntil, now),
            lte(webhookSends.nextAttemptAt, new Date(now.getTime() + CLAIM_LEASE_MS)),
          ),
        ),
      );

    return row!.total;
  }

  /**
   * The org's oldest due, unclaimed `pending` sends, oldest due first, locked; a row another
   * transaction holds is skipped (it is being claimed or dispatched there).
   */
  async nextDue(tx: TenantTransaction, orgId: string, now: Date, limit: number): Promise<string[]> {
    const rows = await tx
      .select({ id: webhookSends.id })
      .from(webhookSends)
      .where(
        and(
          eq(webhookSends.orgId, orgId),
          eq(webhookSends.state, 'pending'),
          lte(webhookSends.nextAttemptAt, now),
          or(isNull(webhookSends.claimedUntil), lt(webhookSends.claimedUntil, now)),
        ),
      )
      .orderBy(asc(webhookSends.nextAttemptAt), asc(webhookSends.id))
      .limit(limit)
      .for('update', { skipLocked: true });

    return rows.map((row) => row.id);
  }

  /**
   * The redelivery probe (research R6), on `forge_bypass`, reading only the columns granted to it
   * (data-model § 4): due, unclaimed `pending` sends across every org, oldest due first, at most
   * `batch` in all and `perOrg` for any one org.
   */
  async dueProbe(
    bypass: ForgeDatabase,
    now: Date,
    batch: number,
    perOrg: number,
    orgIds?: readonly string[],
  ): Promise<DueSend[]> {
    const ranked = bypass
      .select({
        id: webhookSends.id,
        nextAttemptAt: webhookSends.nextAttemptAt,
        orgId: webhookSends.orgId,
        rank: sql<number>`row_number() over (partition by ${webhookSends.orgId} order by ${webhookSends.nextAttemptAt}, ${webhookSends.id})`.as(
          'rank',
        ),
      })
      .from(webhookSends)
      .where(
        and(
          eq(webhookSends.state, 'pending'),
          lte(webhookSends.nextAttemptAt, now),
          or(isNull(webhookSends.claimedUntil), lt(webhookSends.claimedUntil, now)),
          orgIds === undefined ? undefined : inArray(webhookSends.orgId, [...orgIds]),
        ),
      )
      .as('ranked');

    return bypass
      .select({ id: ranked.id, orgId: ranked.orgId })
      .from(ranked)
      .where(lte(ranked.rank, perOrg))
      .orderBy(asc(ranked.nextAttemptAt), asc(ranked.id))
      .limit(batch);
  }

  /**
   * The sweep's claim on due sends of one org: `next_attempt_at` moves one lease ahead, so the next
   * tick does not append a second `attempt-due` while this one is on its way. Only the rows still
   * due and unclaimed are returned.
   */
  async claimDue(
    tx: TenantTransaction,
    orgId: string,
    sendIds: readonly string[],
    now: Date,
  ): Promise<string[]> {
    if (sendIds.length === 0) return [];

    // A send whose endpoint a delete holds is skipped rather than waited on: the caller may hold
    // the send rows already (`nextDue`), and the delete is about to cascade to them.
    const endpointIds = await this.lockEndpointsOf(tx, orgId, sendIds, { skipLocked: true });
    if (endpointIds.length === 0) return [];

    const rows = await tx
      .update(webhookSends)
      .set({ nextAttemptAt: new Date(now.getTime() + CLAIM_LEASE_MS), updatedAt: now })
      .where(
        and(
          eq(webhookSends.orgId, orgId),
          inArray(webhookSends.id, [...sendIds]),
          inArray(webhookSends.endpointId, endpointIds),
          eq(webhookSends.state, 'pending'),
          lte(webhookSends.nextAttemptAt, now),
          or(isNull(webhookSends.claimedUntil), lt(webhookSends.claimedUntil, now)),
        ),
      )
      .returning({ id: webhookSends.id });

    return rows.map((row) => row.id);
  }

  /**
   * `FOR KEY SHARE` on the endpoints of `sendIds`, in id order; returns the ids locked.
   *
   * Lock order (Postgres 40P01): a delete locks the endpoint row, then cascades to its sends. An
   * update of a send re-checks its foreign key, taking `KEY SHARE` on the endpoint *after* the send
   * row — the opposite order, so a claim racing a delete deadlocked. Taking the endpoint first puts
   * every writer of a send in the delete's order. `KEY SHARE` conflicts only with a delete (or a
   * key change), not with the settle's `NO KEY UPDATE`, so attempts of one endpoint still overlap.
   * With `skipLocked`, an endpoint a delete holds is left out instead of waited on.
   */
  async lockEndpointsOf(
    tx: TenantTransaction,
    orgId: string,
    sendIds: readonly string[],
    options: { readonly skipLocked?: boolean } = {},
  ): Promise<string[]> {
    const rows = await tx
      .select({ id: webhookEndpoints.id })
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.orgId, orgId),
          inArray(
            webhookEndpoints.id,
            tx
              .select({ id: webhookSends.endpointId })
              .from(webhookSends)
              .where(and(eq(webhookSends.orgId, orgId), inArray(webhookSends.id, [...sendIds]))),
          ),
        ),
      )
      .orderBy(asc(webhookEndpoints.id))
      .for('key share', options.skipLocked === true ? { skipLocked: true } : undefined);

    return rows.map((row) => row.id);
  }

  /** A claimed send whose endpoint is no longer enabled: it will not be sent. */
  async markNotSent(
    tx: TenantTransaction,
    orgId: string,
    sendId: string,
    now: Date,
  ): Promise<void> {
    await tx
      .update(webhookSends)
      .set({ claimedUntil: null, nextAttemptAt: null, state: 'not_sent', updatedAt: now })
      .where(and(eq(webhookSends.orgId, orgId), eq(webhookSends.id, sendId)));
  }

  /**
   * The attempt's end: the state, the lease released, and a scheduled attempt counted. A manual
   * attempt (a replay, research R11) is outside the schedule: it is not counted, does not anchor
   * the 24 h window, and never goes back to `pending`; whatever did not succeed ends `failed`.
   */
  async settle(
    tx: TenantTransaction,
    orgId: string,
    sendId: string,
    result: SettleResult,
  ): Promise<SendRow | undefined> {
    const state = result.manual && result.state === 'pending' ? 'failed' : result.state;
    const [row] = await tx
      .update(webhookSends)
      .set({
        attempts: result.manual ? webhookSends.attempts : sql`${webhookSends.attempts} + 1`,
        claimedUntil: null,
        firstAttemptAt: result.manual
          ? webhookSends.firstAttemptAt
          : sql`coalesce(${webhookSends.firstAttemptAt}, ${result.now.toISOString()}::timestamptz)`,
        lastFailure: result.failure,
        nextAttemptAt:
          state === 'pending' && result.state === 'pending' ? result.nextAttemptAt : null,
        state,
        updatedAt: result.now,
      })
      .where(and(eq(webhookSends.orgId, orgId), eq(webhookSends.id, sendId)))
      .returning();

    return row;
  }

  /** The failure of the endpoint's latest failed attempt, for the paused mail. */
  async lastFailure(
    tx: TenantTransaction,
    orgId: string,
    endpointId: string,
  ): Promise<WebhookAttemptFailure | null> {
    const [row] = await tx
      .select({ failure: webhookSendAttempts.failure })
      .from(webhookSendAttempts)
      .innerJoin(
        webhookSends,
        and(
          eq(webhookSends.orgId, webhookSendAttempts.orgId),
          eq(webhookSends.id, webhookSendAttempts.sendId),
        ),
      )
      .where(
        and(
          eq(webhookSendAttempts.orgId, orgId),
          eq(webhookSends.endpointId, endpointId),
          isNotNull(webhookSendAttempts.failure),
        ),
      )
      .orderBy(desc(webhookSendAttempts.attemptedAt))
      .limit(1);

    return (row?.failure as WebhookAttemptFailure | undefined) ?? null;
  }

  /**
   * One page of an endpoint's log (research R11): newest first, keyset on `(created_at, id)` over
   * `webhook_sends_log_idx`, inside the 30-day window. A row inserted after the first page is
   * newer than every cursor, so it never shifts a later page.
   */
  async page(
    tx: TenantTransaction,
    orgId: string,
    endpointId: string,
    query: LogQuery,
    now: Date,
  ): Promise<SendPage> {
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    const rows = await tx
      .select()
      .from(webhookSends)
      .where(
        and(
          eq(webhookSends.orgId, orgId),
          eq(webhookSends.endpointId, endpointId),
          gte(webhookSends.createdAt, logWindowStart(now)),
          query.state === undefined ? undefined : eq(webhookSends.state, query.state),
          query.eventType === undefined ? undefined : eq(webhookSends.eventType, query.eventType),
          after === undefined
            ? undefined
            : or(
                lt(webhookSends.createdAt, after.at),
                and(eq(webhookSends.createdAt, after.at), lt(webhookSends.id, after.id)),
              ),
        ),
      )
      .orderBy(desc(webhookSends.createdAt), desc(webhookSends.id))
      .limit(DELIVERY_PAGE_SIZE + 1);
    const items = rows.slice(0, DELIVERY_PAGE_SIZE);

    return {
      items,
      nextCursor: rows.length > DELIVERY_PAGE_SIZE ? encodeCursor(items.at(-1)!) : null,
    };
  }

  /**
   * One send of the endpoint inside the 30-day window, with its attempts newest first; undefined
   * for another endpoint's, an unknown one, or one past the window.
   */
  async withAttempts(
    tx: TenantTransaction,
    orgId: string,
    endpointId: string,
    sendId: string,
    now: Date,
  ): Promise<{ attempts: AttemptRow[]; send: SendRow } | undefined> {
    const [send] = await tx
      .select()
      .from(webhookSends)
      .where(
        and(
          eq(webhookSends.orgId, orgId),
          eq(webhookSends.endpointId, endpointId),
          eq(webhookSends.id, sendId),
          gte(webhookSends.createdAt, logWindowStart(now)),
        ),
      );
    if (send === undefined) return undefined;

    const attempts = await tx
      .select()
      .from(webhookSendAttempts)
      .where(and(eq(webhookSendAttempts.orgId, orgId), eq(webhookSendAttempts.sendId, sendId)))
      .orderBy(desc(webhookSendAttempts.attemptedAt), desc(webhookSendAttempts.id));

    return { attempts, send };
  }

  /**
   * The replay's move (research R11): a settled send whose body is held becomes `pending`, due
   * one lease ahead as the sweep's claim leaves it, so the sweep does not also append an attempt
   * while the manual one is on its way. `attempts` and `first_attempt_at` are the schedule's and
   * are left alone. The row is locked first, so a racing claim or replay waits for this one.
   */
  async markReplayed(
    tx: TenantTransaction,
    orgId: string,
    sendId: string,
    now: Date,
  ): Promise<SendRow | undefined> {
    const [row] = await tx
      .update(webhookSends)
      .set({
        claimedUntil: null,
        nextAttemptAt: new Date(now.getTime() + CLAIM_LEASE_MS),
        state: 'pending',
        updatedAt: now,
      })
      .where(
        and(
          eq(webhookSends.orgId, orgId),
          eq(webhookSends.id, sendId),
          ne(webhookSends.state, 'pending'),
          isNotNull(webhookSends.body),
        ),
      )
      .returning();

    return row;
  }

  /** Locks one send of the endpoint for the caller's transaction, for replay's checks. */
  async lockForReplay(
    tx: TenantTransaction,
    orgId: string,
    endpointId: string,
    sendId: string,
    now: Date,
  ): Promise<SendRow | undefined> {
    // The endpoint first, in a delete's order: the replay updates this send (`lockEndpointsOf`).
    await this.lockEndpointsOf(tx, orgId, [sendId]);
    const [row] = await tx
      .select()
      .from(webhookSends)
      .where(
        and(
          eq(webhookSends.orgId, orgId),
          eq(webhookSends.endpointId, endpointId),
          eq(webhookSends.id, sendId),
          gte(webhookSends.createdAt, logWindowStart(now)),
        ),
      )
      .for('update');

    return row;
  }

  /**
   * The outbound half of `webhook.retention` for one org (research R12, ADR 051): bodies and
   * response bodies nulled at 7 days, sends deleted at 30 with their attempts by cascade. The
   * `is not null` guards keep a daily sweep from rewriting rows it already nulled.
   *
   * Lock order (as `lockEndpointsOf`): the org's endpoints are taken `FOR KEY SHARE` in id order
   * first, skipping any a delete holds, and every statement is narrowed to the endpoints locked.
   * A delete locks its endpoint and then cascades to the sends; touching those sends first would
   * take the opposite order, and waiting on the cascade holds up the sweep for nothing, since the
   * delete removes the rows anyway. A skipped endpoint's rows are swept on the next pass.
   */
  async retain(tx: TenantTransaction, orgId: string, now: Date): Promise<OutboundRetentionReport> {
    const locked = await tx
      .select({ id: webhookEndpoints.id })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.orgId, orgId))
      .orderBy(asc(webhookEndpoints.id))
      .for('key share', { skipLocked: true });
    if (locked.length === 0) return { bodiesNulled: 0, responsesNulled: 0, sendsDeleted: 0 };
    const endpointIds = locked.map((row) => row.id);
    const ofLocked = inArray(webhookSends.endpointId, endpointIds);

    const bodyBefore = new Date(now.getTime() - BODY_RETENTION_DAYS * DAY_MS);
    const bodies = await tx
      .update(webhookSends)
      .set({ body: null })
      .where(
        and(
          eq(webhookSends.orgId, orgId),
          ofLocked,
          lt(webhookSends.createdAt, bodyBefore),
          isNotNull(webhookSends.body),
        ),
      )
      .returning({ id: webhookSends.id });
    const responses = await tx
      .update(webhookSendAttempts)
      .set({ responseBody: null })
      .where(
        and(
          eq(webhookSendAttempts.orgId, orgId),
          lt(webhookSendAttempts.attemptedAt, bodyBefore),
          isNotNull(webhookSendAttempts.responseBody),
          inArray(
            webhookSendAttempts.sendId,
            tx
              .select({ id: webhookSends.id })
              .from(webhookSends)
              .where(and(eq(webhookSends.orgId, orgId), ofLocked)),
          ),
        ),
      )
      .returning({ id: webhookSendAttempts.id });
    const deleted = await tx
      .delete(webhookSends)
      .where(
        and(
          eq(webhookSends.orgId, orgId),
          ofLocked,
          lt(webhookSends.createdAt, logWindowStart(now)),
        ),
      )
      .returning({ id: webhookSends.id });

    return {
      bodiesNulled: bodies.length,
      responsesNulled: responses.length,
      sendsDeleted: deleted.length,
    };
  }

  async insertAttempt(tx: TenantTransaction, draft: AttemptDraft): Promise<void> {
    await tx.insert(webhookSendAttempts).values({
      address: draft.address,
      attemptedAt: draft.attemptedAt,
      durationMs: draft.durationMs,
      failure: draft.failure,
      manual: draft.manual,
      orgId: draft.orgId,
      responseBody: draft.responseBody,
      responseHeaders: draft.responseHeaders === null ? null : { ...draft.responseHeaders },
      sendId: draft.sendId,
      status: draft.status,
    });
  }
}
