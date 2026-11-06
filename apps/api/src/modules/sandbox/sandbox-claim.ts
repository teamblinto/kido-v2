import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ProjectTemplate } from '@repo/contracts';
import { type SandboxPoolEntry, sandboxes, sandboxPool, type TemplateVersion } from '@repo/db';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { QUEUE_REDIS } from '../../common/redis/redis.constants';
import type { Environment } from '../../config/environment';
import type { TenantTransaction } from '../../database/database.types';
import { AuditService } from '../audit/audit.service';
import { OutboxWriter } from '../outbox/outbox-writer';
import { DaytonaAdapter } from './daytona.adapter';
import { poolFrontKey } from './sandbox.constants';
import { SandboxGuardError } from './sandbox.errors';
import type { MutationContext, SandboxRef } from './sandbox.port';
import type { Readiness } from './sandbox-lifecycle';
import { TemplateVersions } from './template-versions';

/** Postgres's `unique_violation`: another run claimed for this project first (FR-016). */
const UNIQUE_VIOLATION = '23505';

/**
 * Two runs claimed for one project at once and this one lost. The caller's transaction is
 * rolled back by the rethrow; the row it wanted exists now, so it re-reads (contract § 3.4).
 */
export class ClaimRaced extends Error {
  constructor() {
    super('Another run claimed a sandbox for this project first; re-read the row.');
    this.name = 'ClaimRaced';
  }
}

/** What step 1 hands step 3: a pool row the transaction deleted, or a sandbox Daytona just made. */
type Source =
  | { readonly kind: 'pool'; readonly row: SandboxPoolEntry }
  | {
      readonly kind: 'cold';
      readonly daytonaId: string;
      readonly node: string | null;
      readonly snapshot: string;
    };

/**
 * The claim (spec 014, contracts/sandbox-lifecycle.md § 3, research R4): the `queue` Redis front
 * is a hint, `DELETE … WHERE state = 'ready' RETURNING` is the claim, and the caller's tenant
 * transaction is the truth. Internal to the module — `SandboxLifecycleService.ensureReady` is the
 * only caller.
 */
@Injectable()
export class SandboxClaim {
  private readonly owner: string;

  constructor(
    @Inject(QUEUE_REDIS) private readonly queue: Redis,
    @Inject(TemplateVersions) private readonly versions: TemplateVersions,
    @Inject(DaytonaAdapter) private readonly daytona: DaytonaAdapter,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: ClockPort,
    config: ConfigService<Environment, true>,
  ) {
    this.owner = config.get('SANDBOX_OWNER', { infer: true });
  }

  /**
   * Under a savepoint of the caller's transaction: a raced unique violation undoes the pool-row
   * delete (the row stays claimable) but leaves the caller's transaction usable, so the lifecycle
   * can re-read the winner's row on the same handle.
   */
  async claim(
    tx: TenantTransaction,
    ref: SandboxRef,
    template: ProjectTemplate,
    ctx: MutationContext,
  ): Promise<Readiness> {
    let popped: string | undefined;
    // Read once per claim (contract § 7): the fallback's ordering and the cold path share it.
    const current = await this.versions.current(template);
    try {
      return await tx.transaction(async (sp) => {
        const source =
          (await this.fromPool(sp, template, current)) ?? (await this.cold(template, current));
        if (source.kind === 'pool') popped = source.row.id;
        return this.insert(sp, ref, template, ctx, source);
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      if (popped !== undefined) await this.queue.lpush(poolFrontKey(template), popped);
      throw new ClaimRaced();
    }
  }

  /** Steps 2–3: replace a lost row, insert the project's, queue the ops, audit. */
  private async insert(
    tx: TenantTransaction,
    ref: SandboxRef,
    template: ProjectTemplate,
    ctx: MutationContext,
    source: Source,
  ): Promise<Readiness> {
    const now = this.clock.now();
    const cold = source.kind === 'cold';
    const daytonaId = cold ? source.daytonaId : source.row.daytonaId;
    const snapshot = cold ? source.snapshot : source.row.snapshot;

    // A lost row is replaced, not repaired (FR-026).
    const replaced = await tx
      .delete(sandboxes)
      .where(
        and(
          eq(sandboxes.orgId, ref.orgId),
          eq(sandboxes.projectId, ref.projectId),
          isNotNull(sandboxes.lostAt),
        ),
      )
      .returning({ id: sandboxes.id });
    // A replacement goes through the `create` op even from the pool: that op restores the project's
    // files, and until it has the sandbox is a blank template no run may write to.
    const creating = cold || replaced.length > 0;

    const [row] = await tx
      .insert(sandboxes)
      .values({
        daytonaId,
        lastSeenAt: now,
        node: cold ? source.node : source.row.node,
        orgId: ref.orgId,
        projectId: ref.projectId,
        state: 'active',
        stateEnteredAt: now,
        templateSnapshot: snapshot,
        transition: creating ? 'creating' : null,
        transitionSince: creating ? now : null,
        workspaceRoot: cold ? null : source.row.workspaceRoot,
      })
      .returning({ id: sandboxes.id });
    const sandboxId = row!.id;

    const base = { orgId: ref.orgId, sandboxId };
    if (creating) {
      await this.outbox.append(tx, {
        aggregateId: sandboxId,
        orgId: ref.orgId,
        payload: {
          ...base,
          leaseEpoch: ctx.leaseEpoch,
          op: 'create',
          operationId: ctx.operationId,
        },
        type: 'sandbox.op.requested',
      });
    }
    // The project label is applied off the transaction, so a Daytona blip never undoes a claim.
    await this.outbox.append(tx, {
      aggregateId: sandboxId,
      orgId: ref.orgId,
      payload: { ...base, op: 'label' },
      type: 'sandbox.op.requested',
    });
    await this.audit.record(tx, {
      action: 'sandbox.claimed',
      actorId: null,
      metadata: cold
        ? { daytonaId, snapshot, template }
        : { daytonaId, poolId: source.row.id, snapshot, template },
      orgId: ref.orgId,
      target: sandboxId,
    });

    return creating ? { because: 'creating', ready: false } : { ready: true };
  }

  /**
   * Step 1: pop the front until an id names a ready row (a stale hint is discarded), then the
   * `SKIP LOCKED` fallback for a wiped or lagging front: current-snapshot rows first, oldest
   * ready within that (spec 015 SC-005; no current version → `ready_at` alone). `undefined`
   * when the pool is empty.
   */
  private async fromPool(
    tx: TenantTransaction,
    template: ProjectTemplate,
    current: TemplateVersion | null,
  ): Promise<Source | undefined> {
    const front = poolFrontKey(template);
    // ponytail: unbounded pop loop; each turn consumes one stale hint, so it ends when the front
    // does — cap it if a reconciler ever rebuilds a front faster than claims drain it.
    for (let id = await this.queue.lpop(front); id !== null; id = await this.queue.lpop(front)) {
      const [row] = await tx
        .delete(sandboxPool)
        .where(and(eq(sandboxPool.id, id), eq(sandboxPool.state, 'ready')))
        .returning();
      if (row) return { kind: 'pool', row };
    }

    const preferCurrent =
      current === null ? sql`` : sql`(${sandboxPool.snapshot} = ${current.snapshot}) desc, `;
    const [row] = await tx
      .delete(sandboxPool)
      .where(
        eq(
          sandboxPool.id,
          sql`(select ${sandboxPool.id} from ${sandboxPool} where ${sandboxPool.template} = ${template} and ${sandboxPool.state} = 'ready' order by ${preferCurrent}${sandboxPool.readyAt} for update skip locked limit 1)`,
        ),
      )
      .returning();
    return row ? { kind: 'pool', row } : undefined;
  }

  /**
   * The empty-pool path (FR-017): `POST /sandbox` from the template's current version (spec 015,
   * FR-011) now, the readiness poll as an op.
   */
  private async cold(template: ProjectTemplate, current: TemplateVersion | null): Promise<Source> {
    if (current === null) {
      throw new SandboxGuardError(
        'no-sandbox',
        'The pool is empty and the template has no published version.',
        { template },
      );
    }
    const dto = await this.daytona.create({
      labels: { 'forge.kind': 'project', 'forge.owner': this.owner, 'forge.template': template },
      snapshot: current.snapshot,
    });
    return {
      daytonaId: dto.id,
      kind: 'cold',
      node: dto.runnerId ?? null,
      snapshot: current.snapshot,
    };
  }
}

/** Drizzle wraps the driver error; the SQLSTATE is a bounded `cause` walk away (as `SandboxService`). */
function isUniqueViolation(error: unknown): boolean {
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
