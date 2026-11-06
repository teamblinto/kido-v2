import { Inject, Injectable } from '@nestjs/common';
import { type ProjectTemplate, projectTemplateSchema } from '@repo/contracts';
import { projects, type Sandbox, sandboxes } from '@repo/db';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import type { TenantTransaction } from '../../database/database.types';
import { OutboxWriter } from '../outbox/outbox-writer';
import { SANDBOX_TIMINGS, type SandboxTimings } from './sandbox.constants';
import { SandboxGuardError } from './sandbox.errors';
import type { MutationContext, SandboxRef } from './sandbox.port';
import { ClaimRaced, SandboxClaim } from './sandbox-claim';

/**
 * The lifecycle beside the port (spec 014, contracts/sandbox-lifecycle.md § 1): what 011's
 * executor calls before its first tool call, and what the consumer's heartbeat calls to keep a
 * sandbox from idling. Bound by `SandboxModule` under {@link SANDBOX_LIFECYCLE}.
 */
export const SANDBOX_LIFECYCLE = Symbol('forge.sandbox.lifecycle');

export type Readiness =
  | { readonly ready: true }
  | {
      readonly ready: false;
      readonly because: 'creating' | 'resuming' | 'hibernating' | 'releasing';
    };

export interface SandboxLifecycle {
  /**
   * Make the project's sandbox usable, or start making it so. Runs in the caller's tenant
   * transaction. `ready: true` when the row is `active` (or `idle`, flipped) with no transition.
   * On `hibernated` it records `resuming` and appends the resume op, and answers `ready: false`.
   * On no row, or a row with `lost_at`, it claims (contract § 3) — a pooled sandbox answers
   * `ready: true` at once; a cold create, or any claim replacing a lost row (its workspace is
   * restored first), answers `ready: false, because: 'creating'`. On a row in
   * transition it answers `ready: false` without touching it. Throws
   * `SandboxGuardError('no-sandbox')` only when the project does not exist or its template has
   * no snapshot and the pool is empty.
   */
  ensureReady(tx: TenantTransaction, ref: SandboxRef, ctx: MutationContext): Promise<Readiness>;

  /**
   * Record a sign of use: `last_seen_at = now`, and `idle → active` (with `state_entered_at`) in
   * the same `UPDATE`. Coalesced: a no-op when `last_seen_at` is younger than `touchCoalesceMs`.
   * Silent on a missing row.
   */
  touch(tx: TenantTransaction, ref: SandboxRef): Promise<void>;
}

/**
 * The lifecycle (contract § 1) over the caller's tenant transaction: the readiness matrix on the
 * project's row, the claim when there is none, and the coalesced touch.
 */
@Injectable()
export class SandboxLifecycleService implements SandboxLifecycle {
  constructor(
    @Inject(SandboxClaim) private readonly claims: SandboxClaim,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(SANDBOX_TIMINGS) private readonly timings: SandboxTimings,
  ) {}

  async ensureReady(
    tx: TenantTransaction,
    ref: SandboxRef,
    ctx: MutationContext,
  ): Promise<Readiness> {
    const template = await this.template(tx, ref);
    let row = await this.row(tx, ref);

    if (row?.lostAt !== null) {
      try {
        return await this.claims.claim(tx, ref, template, ctx);
      } catch (error) {
        if (!(error instanceof ClaimRaced)) throw error;
        // The other run's claim committed; its row is the answer now (contract § 3.4).
        row = await this.row(tx, ref);
        if (row === undefined) throw noSandbox();
      }
    }

    if (row.transition !== null) return { because: row.transition, ready: false };

    const now = this.clock.now();
    switch (row.state) {
      case 'active':
        return { ready: true };
      case 'idle':
        await tx
          .update(sandboxes)
          .set({ lastSeenAt: now, state: 'active', stateEnteredAt: now })
          .where(eq(sandboxes.id, row.id));
        return { ready: true };
      case 'hibernated': {
        // Compare-and-set, so concurrent wakes cannot each start a cycle: the loser blocks on the
        // row lock, finds the transition set and enqueues nothing.
        const [won] = await tx
          .update(sandboxes)
          .set({ transition: 'resuming', transitionSince: now })
          .where(
            and(
              eq(sandboxes.id, row.id),
              eq(sandboxes.state, 'hibernated'),
              isNull(sandboxes.transition),
            ),
          )
          .returning({ id: sandboxes.id });
        if (won === undefined) return { because: 'resuming', ready: false };

        await this.outbox.append(tx, {
          aggregateId: row.id,
          orgId: ref.orgId,
          payload: {
            leaseEpoch: ctx.leaseEpoch,
            op: 'resume',
            operationId: ctx.operationId,
            orgId: ref.orgId,
            sandboxId: row.id,
            // Without it the job id is the same every cycle, and the last resume's completed job,
            // kept a day by JOB_RETENTION, swallows this one until the reconciler's retry.
            since: now.toISOString(),
          },
          type: 'sandbox.op.requested',
        });
        return { because: 'resuming', ready: false };
      }
      default:
        // `pooled` and `archived` are never written to this table (data-model.md).
        throw noSandbox();
    }
  }

  async touch(tx: TenantTransaction, ref: SandboxRef): Promise<void> {
    const now = this.clock.now();
    const stale = new Date(now.getTime() - this.timings.touchCoalesceMs);
    await tx
      .update(sandboxes)
      .set({
        lastSeenAt: now,
        state: sql`case when ${sandboxes.state} = 'idle' then 'active' else ${sandboxes.state} end`,
        stateEnteredAt: sql`case when ${sandboxes.state} = 'idle' then ${now} else ${sandboxes.stateEnteredAt} end`,
      })
      .where(
        and(
          eq(sandboxes.orgId, ref.orgId),
          eq(sandboxes.projectId, ref.projectId),
          or(isNull(sandboxes.lastSeenAt), lt(sandboxes.lastSeenAt, stale)),
        ),
      );
  }

  /** The project's template, or `no-sandbox`: RLS and `deleted_at` hide a foreign or archived one. */
  private async template(tx: TenantTransaction, ref: SandboxRef): Promise<ProjectTemplate> {
    const [project] = await tx
      .select({ template: projects.template })
      .from(projects)
      .where(
        and(
          eq(projects.orgId, ref.orgId),
          eq(projects.id, ref.projectId),
          isNull(projects.deletedAt),
        ),
      )
      .limit(1);
    if (project === undefined) throw noSandbox();
    return projectTemplateSchema.parse(project.template ?? 'vite-react');
  }

  private row(tx: TenantTransaction, ref: SandboxRef): Promise<Sandbox | undefined> {
    return tx.query.sandboxes.findFirst({
      where: and(eq(sandboxes.orgId, ref.orgId), eq(sandboxes.projectId, ref.projectId)),
    });
  }
}

const noSandbox = (): SandboxGuardError =>
  new SandboxGuardError('no-sandbox', 'This project has no sandbox.');
