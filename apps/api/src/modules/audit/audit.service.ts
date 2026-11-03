import { Inject, Injectable } from '@nestjs/common';
import { auditLog } from '@repo/db';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import type { TenantTransaction } from '../../database/database.types';
import type { AuditAction } from './audit-actions';

/**
 * One thing that happened, as the caller describes it. `at` is deliberately absent — see
 * {@link AuditService.record}.
 */
export interface AuditEntry {
  /** What happened, from the closed catalogue in `audit-actions.ts`. */
  readonly action: AuditAction;

  /**
   * Who did it, or `null` when the actor is the system — a scheduled retention job, a webhook the
   * platform initiated. Null means "no user", never "we did not look": an unauthenticated caller
   * cannot reach a tenant transaction in the first place.
   *
   * `audit_log.actor_id` carries no foreign key on purpose (T05): the trail is retained for one to
   * seven years and outlives the user rows it names.
   */
  readonly actorId: string | null;

  /**
   * Whatever a reviewer would need in order to understand the entry without reconstructing it from
   * the surrounding rows — the old and new role on a role change, the invited address.
   *
   * It is a `jsonb` column and it is not redacted on the way in. §05's rule applies unchanged: a
   * hash, a DEK, a raw token or a session identifier must not be put here. The trail is readable by
   * an organisation's owners, so this is a disclosure boundary and not merely a log line.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;

  /**
   * The organisation the event belongs to. Not derived from the transaction: the value is written
   * into the row, and the `tenant_isolation` policy's `WITH CHECK` compares it against
   * `app.org_id`, so an entry filed under the wrong tenant is refused by the database with 42501
   * rather than landing where nobody will look for it.
   */
  readonly orgId: string;

  /** What it happened to, as a stable identifier the reader can resolve — usually a row id. */
  readonly target: string;
}

/**
 * The append-only security trail (§09, T10).
 *
 * There is one method and it only appends. There is no update and no delete here, and adding one
 * would not work: `migrations/0003_grants.sql` gives `forge_app` `SELECT` and `INSERT` on
 * `audit_log` and nothing else, so the statement would be refused with 42501 before RLS was even
 * consulted. That refusal is the enforcement. This class deliberately does not restate it as a
 * guard, because a check in application code above a privilege that is already absent teaches the
 * next reader that the privilege is the thing that might change.
 */
@Injectable()
export class AuditService {
  constructor(@Inject(CLOCK) private readonly clock: ClockPort) {}

  /**
   * Append one entry **to the caller's transaction**.
   *
   * `tx` is the whole design. The row is written by the same transaction as the state change it
   * describes, so the two share one fate in both directions:
   *
   * - the caller rolls back, and the entry goes with it — an audit log that survives a rollback is
   *   a log of things that did not happen;
   * - this insert fails, and the caller's mutation fails with it — nothing is caught here, so a
   *   refused or constraint-violating append aborts the transaction rather than letting a state
   *   change land unrecorded.
   *
   * `audit.service.spec.ts` proves the first against real Postgres, with a committing control so
   * that "no row" cannot be satisfied by writing nothing at all.
   *
   * The transaction also carries the tenant: `runInTenantTransaction` has already set `app.org_id`
   * on it, and an insert issued anywhere else would be an insert outside the tenant.
   *
   * `at` comes from the injected {@link ClockPort} and cannot be supplied by the caller. That is
   * two rules at once. Spec 001 forbids `new Date()` inside a service, which is what makes the
   * timestamp assertable from a `FakeClock` instead of tolerated within a range. And a trail whose
   * event time is caller-controlled is a trail that can be backdated by the code being audited.
   * `created_at` — when the row was written — is set by the database clock separately, so the two
   * disagreeing is itself visible.
   */
  async record(tx: TenantTransaction, entry: AuditEntry): Promise<void> {
    await tx.insert(auditLog).values({
      action: entry.action,
      actorId: entry.actorId,
      at: this.clock.now(),
      metadata: { ...entry.metadata },
      orgId: entry.orgId,
      target: entry.target,
    });
  }
}
