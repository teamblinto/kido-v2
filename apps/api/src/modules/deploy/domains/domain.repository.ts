import { Injectable } from '@nestjs/common';
import { type Domain as DomainRecord, schema } from '@repo/db';
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { z } from 'zod';

import type { ForgeDatabase, TenantTransaction } from '../../../database/database.types';
import { isUniqueViolation } from '../deployment.repository';
import { CHECK_NOW_MIN_INTERVAL_MS, CLAIM_LEASE_MS } from './domain.constants';
import { HostnameHeld } from './domain.errors';

const { domains, orgs } = schema;

/** `last_check`'s ceiling (data-model.md § domains), measured on the JSON text. */
export const DOMAIN_CHECK_MAX_BYTES = 4 * 1024;

/** The states that hold a hostname (`domains_hostname_live_key`) and count toward FR-004. */
const LIVE_STATES = ['pending', 'active', 'drifted', 'removing'] as const;

/** The live states a removal moves out of: every live state but `removing` itself (R10). */
const REMOVABLE_STATES = ['pending', 'active', 'drifted'] as const;

/** The states a member may ask a check of (FR-012): `active` is covered by the schedule. */
const CHECKABLE_STATES = ['pending', 'drifted'] as const;

/** The states a hostname serves in (FR-009, `domains_serving_idx`). */
export const SERVING_STATES = ['active', 'drifted'] as const;

/**
 * The `last_check` jsonb (data-model.md § DomainCheck): what the latest check saw. Internal, not a
 * product contract — the API maps it into `DomainResponse.records[]` and `check`.
 */
export const domainCheckSchema = z.strictObject({
  at: z.iso.datetime(),
  /** False when a resolver or the edge was unavailable (R6). */
  conclusive: z.boolean(),
  records: z.array(
    z.strictObject({
      purpose: z.enum(['ownership', 'routing', 'certificate']),
      status: z.enum(['found', 'missing', 'mismatch', 'apex', 'unchecked']),
    }),
  ),
  /** Null until registered at the edge. */
  edge: z
    .strictObject({
      hostname: z.enum(['active', 'blocked', 'gone', 'pending']),
      certificate: z.enum(['active', 'failed', 'gone', 'pending']),
    })
    .nullable(),
  caa: z.discriminatedUnion('verdict', [
    z.strictObject({ verdict: z.literal('permitted') }),
    z.strictObject({ verdict: z.literal('blocked'), zone: z.string(), record: z.string() }),
  ]),
  /** Only when the edge returns TXT validation records (R4). */
  certificateRecords: z.array(z.strictObject({ name: z.string(), value: z.string() })),
  /** The provider's refusal text, for `provider-refused`. */
  edgeMessage: z.string().nullable(),
});

export type DomainCheck = z.output<typeof domainCheckSchema>;

function parseCheck(value: unknown): DomainCheck {
  const check = domainCheckSchema.parse(value);
  const bytes = Buffer.byteLength(JSON.stringify(check), 'utf8');

  if (bytes > DOMAIN_CHECK_MAX_BYTES) {
    throw new RangeError(
      `last_check is ${bytes} bytes; at most ${DOMAIN_CHECK_MAX_BYTES} bytes are stored.`,
    );
  }

  return check;
}

/** The write side: every `last_check` stored goes through here first. */
export function encodeDomainCheck(check: DomainCheck): DomainCheck {
  return parseCheck(check);
}

/** The read side: a stored `last_check` is trusted only after it parses. */
export function decodeDomainCheck(value: unknown): DomainCheck | null {
  return value === null ? null : parseCheck(value);
}

/** A `domains` row with `last_check` parsed. */
export type Domain = Omit<DomainRecord, 'lastCheck'> & { readonly lastCheck: DomainCheck | null };

function toDomain(row: DomainRecord): Domain {
  return { ...row, lastCheck: decodeDomainCheck(row.lastCheck) };
}

/** A due row as the sweep's bypass probe sees it: ids only, inside `forge_bypass`'s column grant. */
export interface DueDomain {
  readonly id: string;
  readonly orgId: string;
  /** Its org's `deleted_at` is set, so the sweep sends it to `removing` (FR-026). */
  readonly orgDeleted: boolean;
}

/**
 * What a check's settle writes (research R7): the state columns, `last_check` and
 * `next_check_at`. `from` and `claim` are the row as the claim read it; a row that has moved since,
 * or that another claim took over when this one's lease ran out, matches nothing.
 * An absent key in `changes` leaves that column as it is.
 */
export interface DomainSettlement {
  readonly claim: Pick<DomainRecord, 'checkRequestedAt' | 'claimedAt'>;
  readonly from: DomainRecord['state'];
  readonly state: DomainRecord['state'];
  readonly failureReason: DomainRecord['failureReason'];
  readonly changes: Partial<
    Pick<
      DomainRecord,
      | 'activatedAt'
      | 'certificateActiveAt'
      | 'driftedAt'
      | 'edgeId'
      | 'failureCount'
      | 'ownershipVerifiedAt'
      | 'releaseWarnedAt'
      | 'removalRequestedAt'
    >
  >;
  /** Absent leaves `last_check` as it is: a deregistration observes no records (R10). */
  readonly lastCheck?: DomainCheck;
  /** Unless a check-now arrived during the check: then the row is due again at once. */
  readonly nextCheckAt: Date;
}

/** A timestamp parameter for raw SQL, typed so `null` compares too. */
function timestamptz(value: Date | null) {
  return value === null ? sql`null::timestamptz` : sql`${value.toISOString()}::timestamptz`;
}

/**
 * The `domains` table (spec 028, data-model.md § domains). Rows are never deleted: `forge_app` has
 * no DELETE, and a `failed` or `removed` row is what lets a hostname go (R9). `removed` is hidden
 * from every read here, as the API never reports it. Every time is the injected clock's, passed in
 * (R7).
 */
@Injectable()
export class DomainRepository {
  /**
   * A new `pending` domain whose window and first check start at `now`. A live row anywhere holding
   * the hostname throws `HostnameHeld`. Runs in a savepoint so that refusal leaves the add's
   * transaction usable.
   */
  async insert(
    tx: TenantTransaction,
    domain: {
      addedBy: string | null;
      hostname: string;
      now: Date;
      orgId: string;
      ownershipToken: string;
      projectId: string;
    },
  ): Promise<Domain> {
    try {
      return await tx.transaction(async (savepoint) => {
        const [row] = await savepoint
          .insert(domains)
          .values({
            addedBy: domain.addedBy,
            hostname: domain.hostname,
            nextCheckAt: domain.now,
            orgId: domain.orgId,
            ownershipToken: domain.ownershipToken,
            projectId: domain.projectId,
            windowStartedAt: domain.now,
          })
          .returning();

        return toDomain(row!);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new HostnameHeld();
      throw error;
    }
  }

  /** One of the organisation's domains, unless `removed` (spec 030 `DomainRecordsReader`). */
  async findInOrg(
    tx: TenantTransaction,
    orgId: string,
    domainId: string,
  ): Promise<Domain | undefined> {
    const [row] = await tx
      .select()
      .from(domains)
      .where(and(eq(domains.orgId, orgId), eq(domains.id, domainId), ne(domains.state, 'removed')));

    return row === undefined ? undefined : toDomain(row);
  }

  /** One of the project's domains, unless `removed`. */
  async findForProject(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
    domainId: string,
  ): Promise<Domain | undefined> {
    const [row] = await tx
      .select()
      .from(domains)
      .where(
        and(
          eq(domains.orgId, orgId),
          eq(domains.projectId, projectId),
          eq(domains.id, domainId),
          ne(domains.state, 'removed'),
        ),
      );

    return row === undefined ? undefined : toDomain(row);
  }

  /** The project's domains, newest first, without `removed` (`domains_org_project_idx`). */
  async listForProject(tx: TenantTransaction, orgId: string, projectId: string): Promise<Domain[]> {
    const rows = await tx
      .select()
      .from(domains)
      .where(
        and(
          eq(domains.orgId, orgId),
          eq(domains.projectId, projectId),
          ne(domains.state, 'removed'),
        ),
      )
      .orderBy(desc(domains.createdAt), desc(domains.id));

    return rows.map(toDomain);
  }

  /**
   * Live domains in the project and in the org (FR-004), counted under the org's domain lock
   * (R9 § Limits). The lock is held to the end of `tx`, so an add that counts and then inserts in
   * one transaction cannot interleave with another add in the same org: the second waits, and its
   * count sees the first one's row.
   */
  async countLive(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
  ): Promise<{ org: number; project: number }> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('domains:' || ${orgId}::text))`);

    const [counts] = await tx
      .select({
        org: count(),
        project: sql<number>`count(*) filter (where ${domains.projectId} = ${projectId})`.mapWith(
          Number,
        ),
      })
      .from(domains)
      .where(and(eq(domains.orgId, orgId), inArray(domains.state, LIVE_STATES)));

    return { org: counts!.org, project: counts!.project };
  }

  /**
   * The broker's bypass probe (contract domain-serving.md § 2, R11): the request names no tenant
   * and `domains` is under RLS, so the owner of a serving hostname is found on the bypass handle,
   * over its column grant and `domains_serving_idx`. It answers where the hostname points and
   * nothing else: whether it is still serving is re-checked under the tenant's own transaction.
   */
  async probeServing(
    bypass: ForgeDatabase,
    hostname: string,
  ): Promise<{ orgId: string; projectId: string } | undefined> {
    const [hit] = await bypass
      .select({ orgId: domains.orgId, projectId: domains.projectId })
      .from(domains)
      .where(and(eq(domains.hostname, hostname), inArray(domains.state, SERVING_STATES)))
      .limit(1);

    return hit;
  }

  /**
   * The check's claim (research R7): a due row's `next_check_at` moves `CLAIM_LEASE_MS` past
   * `now`, so a second tick, or a check-now racing the sweep, finds it not due and checks nothing.
   * `claimed_at` marks the lease as one (a check-now does not cut it short) until the settle
   * clears it. `undefined` when the row is not due, not live or not this tenant's.
   */
  async claim(tx: TenantTransaction, id: string, now: Date): Promise<Domain | undefined> {
    const [row] = await tx
      .update(domains)
      .set({ claimedAt: now, nextCheckAt: new Date(now.getTime() + CLAIM_LEASE_MS) })
      .where(
        and(eq(domains.id, id), lte(domains.nextCheckAt, now), inArray(domains.state, LIVE_STATES)),
      )
      .returning();

    return row === undefined ? undefined : toDomain(row);
  }

  /**
   * The check's settle: writes what the check decided, guarded on the state and the claim it read.
   * A removal or retry that moved the row in between wins, as does a later claim that took the row
   * over after this one's lease ran out, and this answers `undefined`. It clears `claimed_at`. A
   * check-now that arrived while the check was in flight (`check_requested_at` is not what the
   * claim read) left the lease alone, so the row is made due again at once, for the checker's
   * follow-up check.
   */
  async settle(
    tx: TenantTransaction,
    id: string,
    outcome: DomainSettlement,
  ): Promise<Domain | undefined> {
    const { checkRequestedAt, claimedAt } = outcome.claim;
    const [row] = await tx
      .update(domains)
      .set({
        ...outcome.changes,
        claimedAt: null,
        failureReason: outcome.failureReason,
        ...(outcome.lastCheck === undefined
          ? {}
          : { lastCheck: encodeDomainCheck(outcome.lastCheck) }),
        nextCheckAt: sql`case when ${domains.checkRequestedAt} is not distinct from ${timestamptz(checkRequestedAt)} then ${timestamptz(outcome.nextCheckAt)} else ${timestamptz(claimedAt ?? outcome.nextCheckAt)} end`,
        state: outcome.state,
      })
      .where(
        and(
          eq(domains.id, id),
          eq(domains.state, outcome.from),
          claimedAt === null ? isNull(domains.claimedAt) : eq(domains.claimedAt, claimedAt),
        ),
      )
      .returning();

    return row === undefined ? undefined : toDomain(row);
  }

  /**
   * A removal request (research R10): the rows among `target` still in `pending`, `active` or
   * `drifted` move to `removing`, stamped `removal_requested_at` and due at once
   * (`next_check_at = now`), so the check routine deregisters them. `drifted_at` is cleared, as
   * `domains_drifted_check` asks outside `drifted`, and so is `release_warned_at`: on a `removing`
   * row it marks a drift release (whose end mails `domain-released`), which this is not.
   * `failure_reason` stays null:
   * a removal settles `removed`. Rows already `removing`, or ended, are left as they are, so a
   * repeated request moves nothing. A claim lease in force is not cut short, as `requestCheck`
   * does not cut it: a second check would find the row `removing` with no `edge_id` and release
   * the hostname while the first is registering it at the edge. That check's settle misses the
   * row instead and hands it over (`handOver`). Answers the rows it moved, for the caller's audit rows and
   * `domain.removing` events (`recordRemovalRequested`) in the same transaction.
   */
  async markRemoving(
    tx: TenantTransaction,
    orgId: string,
    target: { readonly projectId: string } | { readonly ids: readonly string[] },
    now: Date,
  ): Promise<Domain[]> {
    const rows = await tx
      .update(domains)
      .set({
        driftedAt: null,
        nextCheckAt: sql`case when ${domains.claimedAt} is not null and ${domains.nextCheckAt} > ${timestamptz(now)} then ${domains.nextCheckAt} else ${timestamptz(now)} end`,
        releaseWarnedAt: null,
        removalRequestedAt: now,
        state: 'removing',
      })
      .where(
        and(
          eq(domains.orgId, orgId),
          'projectId' in target
            ? eq(domains.projectId, target.projectId)
            : inArray(domains.id, [...target.ids]),
          inArray(domains.state, REMOVABLE_STATES),
        ),
      )
      .returning();

    return rows.map(toDomain);
  }

  /**
   * A check whose settle missed because a removal moved the row to `removing` under its claim
   * (research R10). `markRemoving` left the lease alone, so no other check holds the row: the
   * claim is released, the row made due at once, and `edgeId` — what the check registered, not
   * yet on the row — recorded on it, so the deregistration takes it back before the hostname is
   * released. `undefined` when the row is not `removing` under this claim any more.
   */
  async handOver(
    tx: TenantTransaction,
    id: string,
    claimedAt: Date,
    edgeId: string | null,
    now: Date,
  ): Promise<Domain | undefined> {
    const [row] = await tx
      .update(domains)
      .set({
        claimedAt: null,
        edgeId: sql`coalesce(${domains.edgeId}, ${edgeId})`,
        nextCheckAt: now,
      })
      .where(
        and(eq(domains.id, id), eq(domains.state, 'removing'), eq(domains.claimedAt, claimedAt)),
      )
      .returning();

    return row === undefined ? undefined : toDomain(row);
  }

  /**
   * A member's removal of a `failed` domain (contracts/domains.md § Remove): nothing is registered
   * at the edge (`edge_id` is null in `failed`) and the hostname is already free, so it goes
   * straight to `removed` with its reason cleared. `undefined` when the row is not `failed`.
   */
  async releaseFailed(tx: TenantTransaction, id: string): Promise<Domain | undefined> {
    const [row] = await tx
      .update(domains)
      .set({ failureReason: null, state: 'removed' })
      .where(and(eq(domains.id, id), eq(domains.state, 'failed')))
      .returning();

    return row === undefined ? undefined : toDomain(row);
  }

  /**
   * A member's retry of a `failed` domain (FR-013): back to `pending` with a new ownership token
   * and a new window starting at `now`, due at once. Everything a previous attempt proved or
   * observed is cleared — `pending` carries no reason, and the new token has not been seen — so the
   * retry starts where an add does. `edge_id` is already null in `failed`. Taking the hostname back
   * goes through `domains_hostname_live_key`: a live row anywhere now holding it throws
   * `HostnameHeld`, in a savepoint so the caller's transaction stays usable. `undefined` when the
   * row is no longer `failed` (a removal released it, or it was never failed).
   */
  async retry(
    tx: TenantTransaction,
    id: string,
    attempt: { now: Date; ownershipToken: string },
  ): Promise<Domain | undefined> {
    try {
      return await tx.transaction(async (savepoint) => {
        const [row] = await savepoint
          .update(domains)
          .set({
            activatedAt: null,
            certificateActiveAt: null,
            checkRequestedAt: null,
            claimedAt: null,
            driftedAt: null,
            failureCount: 0,
            failureReason: null,
            lastCheck: null,
            nextCheckAt: attempt.now,
            ownershipToken: attempt.ownershipToken,
            ownershipVerifiedAt: null,
            releaseWarnedAt: null,
            removalRequestedAt: null,
            state: 'pending',
            windowStartedAt: attempt.now,
          })
          .where(and(eq(domains.id, id), eq(domains.state, 'failed')))
          .returning();

        return row === undefined ? undefined : toDomain(row);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new HostnameHeld();
      throw error;
    }
  }

  /**
   * A member's check-now (FR-012, research R7): a `pending` or `drifted` row whose last request is
   * at least `CHECK_NOW_MIN_INTERVAL_MS` old gets `check_requested_at` and `next_check_at` set to
   * `now`. The limit is in the `where`, so of two racing requests one moves the row and the other
   * answers `undefined`, as does a row in any other state.
   *
   * A claim lease in force (`claimed_at` set, `next_check_at` still ahead) is not cut short: that
   * would let a second check claim the row while the first is in flight, and both register it at
   * the edge. Its settle sees the request instead and makes the row due at once, and the checker
   * checks it again straight after (`DomainChecker.checkOne`).
   */
  async requestCheck(tx: TenantTransaction, id: string, now: Date): Promise<Domain | undefined> {
    const [row] = await tx
      .update(domains)
      .set({
        checkRequestedAt: now,
        nextCheckAt: sql`case when ${domains.claimedAt} is not null and ${domains.nextCheckAt} > ${timestamptz(now)} then ${domains.nextCheckAt} else ${timestamptz(now)} end`,
      })
      .where(
        and(
          eq(domains.id, id),
          inArray(domains.state, CHECKABLE_STATES),
          or(
            isNull(domains.checkRequestedAt),
            lte(domains.checkRequestedAt, new Date(now.getTime() - CHECK_NOW_MIN_INTERVAL_MS)),
          ),
        ),
      )
      .returning();

    return row === undefined ? undefined : toDomain(row);
  }

  /**
   * The sweep's due rows across every tenant, through `forge_bypass`'s column grant (and its
   * `orgs` SELECT): ids only. A row is due when `next_check_at` has passed (`domains_due_idx`), or
   * when its org's `deleted_at` is set and it is not yet `removing`, whatever `next_check_at` says
   * (FR-026); those come first, as `orgDeleted`. Then oldest due first. `now` is the injected
   * clock's, never SQL `now()`.
   */
  async probeDue(bypass: ForgeDatabase, now: Date, limit: number): Promise<DueDomain[]> {
    const orgDeleted = isNotNull(orgs.deletedAt);

    return bypass
      .select({
        id: domains.id,
        orgDeleted: sql<boolean>`${orgDeleted}`.mapWith(Boolean),
        orgId: domains.orgId,
      })
      .from(domains)
      .innerJoin(orgs, eq(orgs.id, domains.orgId))
      .where(
        and(
          inArray(domains.state, LIVE_STATES),
          or(
            lte(domains.nextCheckAt, now),
            and(orgDeleted, inArray(domains.state, REMOVABLE_STATES)),
          ),
        ),
      )
      .orderBy(sql`${orgDeleted} desc`, asc(domains.nextCheckAt))
      .limit(limit);
  }
}
