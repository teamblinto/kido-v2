import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PROJECT_TEMPLATES } from '@repo/contracts';
import { orgs, type Sandbox, type SandboxPoolEntry, sandboxes, sandboxPool } from '@repo/db';
import { eq, isNull } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { QUEUE_REDIS } from '../../common/redis/redis.constants';
import type { Environment } from '../../config/environment';
import { APP_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { AuditService } from '../audit/audit.service';
import { OutboxWriter } from '../outbox/outbox-writer';
import { DaytonaAdapter } from './daytona.adapter';
import type { DaytonaSandboxDto } from './daytona.schemas';
import { SANDBOX_TIMINGS, type SandboxTimings, poolFrontKey } from './sandbox.constants';
import { DaytonaError } from './sandbox.errors';
import { TemplateVersions } from './template-versions';

const OP_OF = {
  creating: 'create',
  hibernating: 'hibernate',
  releasing: 'release',
  resuming: 'resume',
} as const;

export interface ReconcileReport {
  /** Sandboxes at Daytona without our owner label: counted, never touched (FR-025). */
  readonly foreign: number;
  /** Rows (project and pool) whose sandbox Daytona no longer has. */
  readonly lost: number;
  /** Owner-labelled sandboxes no row claimed, older than the grace, released. */
  readonly orphaned: number;
  /** Stale transitions and dead-lettered pool creates whose op was (re-)appended. */
  readonly requeued: number;
}

/**
 * Research R9: the inventory by owner label, every pool row on the platform handle, every
 * project row under its own tenant, orphans released after `orphanGraceMs`, the front rebuilt
 * from the ready rows. Driven by `maintenance.due` (`sandbox.reconcile`); public `reconcile()`
 * for the suites. ponytail: the per-org loop is the reaper's; a platform-level read needs a
 * policy exception and is the upgrade if the tenant count makes a reconcile slow.
 */
@Injectable()
export class SandboxReconciler {
  private readonly logger = new Logger(SandboxReconciler.name);
  private readonly owner: string;

  constructor(
    @Inject(APP_DATABASE) private readonly db: ForgeDatabase,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(QUEUE_REDIS) private readonly queue: Redis,
    @Inject(DaytonaAdapter) private readonly daytona: DaytonaAdapter,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SANDBOX_TIMINGS) private readonly timings: SandboxTimings,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(TemplateVersions) private readonly versions: TemplateVersions,
    config: ConfigService<Environment, true>,
  ) {
    this.owner = config.get('SANDBOX_OWNER', { infer: true });
  }

  async reconcile(): Promise<ReconcileReport> {
    const now = this.clock.now();
    const staleBefore = new Date(now.getTime() - this.timings.staleTransitionMs);
    // Everything, filtered here, so the strangers can be counted (R9 step 8) — the label filter
    // is what keeps 010's unlabelled `forge-local` and a colleague's owner out of every branch.
    const all = await this.daytona.listByLabels({});
    const inventory = new Map<string, DaytonaSandboxDto>();
    for (const dto of all) {
      if (dto.labels?.['forge.owner'] === this.owner) inventory.set(dto.id, dto);
    }
    const report = { foreign: all.length - inventory.size, lost: 0, orphaned: 0, requeued: 0 };
    const claimed = new Set<string>();

    // Pool rows: platform handle.
    const pool = await this.db.select().from(sandboxPool);
    for (const row of pool) {
      claimed.add(row.daytonaId);
      if (!inventory.has(row.daytonaId) && !(await this.exists(row.daytonaId))) {
        await this.db.delete(sandboxPool).where(eq(sandboxPool.id, row.id));
        report.lost++;
      } else if (row.state === 'creating' && row.failureReason !== null) {
        await this.releasePool(row);
        report.requeued++;
      } else if (row.state !== 'ready' && row.updatedAt < staleBefore) {
        await this.db.transaction(async (tx) => {
          await tx.update(sandboxPool).set({ updatedAt: now }).where(eq(sandboxPool.id, row.id));
          await this.outbox.append(tx, {
            aggregateId: row.id,
            payload: { op: OP_OF[row.state as 'creating' | 'releasing'], poolId: row.id },
            type: 'sandbox.op.requested',
          });
        });
        report.requeued++;
      }
    }

    // Project rows: one tenant transaction per live organisation.
    const tenants = await this.db.select({ id: orgs.id }).from(orgs).where(isNull(orgs.deletedAt));
    for (const { id: orgId } of tenants) {
      await this.transactions.runInTenantTransaction(orgId, async (tx) => {
        for (const row of await tx.select().from(sandboxes).where(eq(sandboxes.orgId, orgId))) {
          claimed.add(row.daytonaId);
          if (row.lostAt !== null) continue;
          const dto = inventory.get(row.daytonaId) ?? (await this.describe(row.daytonaId));
          if (dto === undefined) {
            await this.lose(tx, row, now);
            report.lost++;
            continue;
          }
          if (row.transition === null) {
            if ((row.state === 'active' || row.state === 'idle') && dto.state === 'stopped') {
              await tx
                .update(sandboxes)
                .set({ hibernatedAt: now, state: 'hibernated', stateEnteredAt: now })
                .where(eq(sandboxes.id, row.id));
            }
          } else if (row.transitionSince !== null && row.transitionSince < staleBefore) {
            await tx
              .update(sandboxes)
              .set({ transitionSince: now })
              .where(eq(sandboxes.id, row.id));
            await this.outbox.append(tx, {
              aggregateId: row.id,
              orgId,
              payload: {
                op: OP_OF[row.transition],
                orgId,
                sandboxId: row.id,
                since: now.toISOString(),
              },
              type: 'sandbox.op.requested',
            });
            report.requeued++;
          }
        }
      });
    }

    // Orphans: ours, unclaimed, and old enough that a creation in flight cannot be one. A
    // publish build may legitimately run for the whole `buildTimeoutMs` (015 R11).
    const graceBefore = now.getTime() - this.timings.orphanGraceMs;
    const buildBefore = graceBefore - this.timings.buildTimeoutMs;
    for (const dto of inventory.values()) {
      if (claimed.has(dto.id) || dto.createdAt === undefined) continue;
      const before = dto.labels?.['forge.kind'] === 'build' ? buildBefore : graceBefore;
      if (new Date(dto.createdAt).getTime() >= before) continue;
      await this.daytona.remove(dto.id);
      this.logger.warn(`orphan released: daytonaId=${dto.id} createdAt=${dto.createdAt}`);
      report.orphaned++;
    }

    await this.rebuildFront(pool);
    this.logger.log(
      `reconciled: inventory=${inventory.size} foreign=${report.foreign} lost=${report.lost} ` +
        `orphaned=${report.orphaned} requeued=${report.requeued}`,
    );
    return report;
  }

  /**
   * The wiped-store path (FR-027): `DEL` + `RPUSH` of the ready ids per template, the current
   * version's rows first (015 § 7), oldest first within each; no current version → `ready_at` alone.
   */
  private async rebuildFront(pool: readonly SandboxPoolEntry[]): Promise<void> {
    const multi = this.queue.multi();
    for (const template of PROJECT_TEMPLATES) {
      const key = poolFrontKey(template);
      const current = (await this.versions.current(template))?.snapshot ?? null;
      const rank = (row: SandboxPoolEntry) => (row.snapshot === current ? 0 : 1);
      const ready = pool
        .filter((row) => row.template === template && row.state === 'ready')
        .sort(
          (a, b) => rank(a) - rank(b) || (a.readyAt?.getTime() ?? 0) - (b.readyAt?.getTime() ?? 0),
        )
        .map((row) => row.id);
      multi.del(key);
      if (ready.length > 0) multi.rpush(key, ...ready);
    }
    await multi.exec();
  }

  private async lose(tx: TenantTransaction, row: Sandbox, now: Date): Promise<void> {
    await tx.update(sandboxes).set({ lostAt: now }).where(eq(sandboxes.id, row.id));
    await this.audit.record(tx, {
      action: 'sandbox.lost',
      actorId: null,
      metadata: { daytonaId: row.daytonaId },
      orgId: row.orgId,
      target: row.id,
    });
  }

  private async releasePool(row: SandboxPoolEntry): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(sandboxPool)
        .set({ state: 'releasing', updatedAt: this.clock.now() })
        .where(eq(sandboxPool.id, row.id));
      await this.outbox.append(tx, {
        aggregateId: row.id,
        payload: { op: 'release', poolId: row.id },
        type: 'sandbox.op.requested',
      });
    });
  }

  /**
   * A row the list did not show is asked for by id before it is written off: a sandbox created
   * after the list was taken is not lost, and a `404` is the only verdict that says it is.
   */
  private async describe(daytonaId: string): Promise<DaytonaSandboxDto | undefined> {
    try {
      return await this.daytona.describe(daytonaId);
    } catch (error) {
      if (error instanceof DaytonaError && error.kind === 'sandbox-not-found') return undefined;
      throw error;
    }
  }

  private async exists(daytonaId: string): Promise<boolean> {
    return (await this.describe(daytonaId)) !== undefined;
  }
}
