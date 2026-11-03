import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PROJECT_TEMPLATES, type ProjectTemplate } from '@repo/contracts';
import { sandboxPool } from '@repo/db';
import { and, asc, count, eq, inArray } from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import type { Environment } from '../../config/environment';
import { APP_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase } from '../../database/database.types';
import { OutboxWriter } from '../outbox/outbox-writer';
import { DaytonaAdapter } from './daytona.adapter';
import { type PoolSettings, PoolSettingsService } from './pool-settings';
import { SANDBOX_TIMINGS, type SandboxTimings } from './sandbox.constants';
import { DaytonaError } from './sandbox.errors';
import { TemplateVersions } from './template-versions';

/**
 * The `sandbox.refill` job (spec 014 research R10, FR-020..022): per template, `ready + creating`
 * against the current target. A deficit becomes at most `refillBatch` creates, each one `POST
 * /sandbox` then, in one transaction, a `sandbox_pool` row in `creating` and the `create` op —
 * so a crash mid-batch leaves matched pairs, never a row without a sandbox. A `POST` that throws
 * propagates: the earlier pairs are committed and the maintenance job retries. A surplus of
 * `ready` rows beyond the target is marked `releasing`, oldest `ready_at` first, with a `release`
 * op per row in one transaction; `creating` rows settle through their own op and are never
 * released here. Both halves count against the current target on every pass (FR-021). The
 * snapshot is the template's current version (spec 015, FR-011); a template with none is
 * skipped with one `warn` and blocks nothing.
 *
 * A version change rolls over fill-before-drain (spec 015 FR-012..014, contract § 7): only rows
 * on the current snapshot count toward the target, so the pool fills on the new version first;
 * nothing is released until the current version's `ready` rows alone meet the target, and then
 * every superseded `ready` row goes before any current-version surplus. With one version this is
 * 014's arithmetic unchanged. After the releases, every superseded `ready` version no pool row
 * names any more (`releasing` still counts) has its image removed and its row retired (FR-010,
 * research R5); a failed removal is logged and left for the next pass.
 *
 * No scheduling here: the maintenance consumer calls `refill()` per period.
 */
@Injectable()
export class PoolRefill {
  private readonly logger = new Logger(PoolRefill.name);
  private readonly owner: string;

  constructor(
    @Inject(APP_DATABASE) private readonly db: ForgeDatabase,
    private readonly daytona: DaytonaAdapter,
    private readonly outbox: OutboxWriter,
    private readonly settings: PoolSettingsService,
    private readonly versions: TemplateVersions,
    config: ConfigService<Environment, true>,
    @Inject(SANDBOX_TIMINGS) private readonly timings: SandboxTimings,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {
    this.owner = config.get('SANDBOX_OWNER', { infer: true });
  }

  async refill(): Promise<void> {
    for (const template of PROJECT_TEMPLATES) {
      const settings = await this.settings.read(template);
      const current = await this.versions.current(template);

      if (current === null) {
        this.logger.warn(
          `pool ${template}: no current version (target ${settings.targetDepth}); pool stays empty`,
        );
        continue;
      }

      const deficit = settings.targetDepth - (await this.held(template, current.snapshot));

      for (let i = 0; i < Math.min(deficit, this.timings.refillBatch); i += 1) {
        await this.create(settings, current.snapshot);
      }
      await this.releaseSurplus(template, settings.targetDepth, current.snapshot);
      await this.retire(template);
    }
  }

  /**
   * `daytona.removeSnapshot` then `versions.retire`, per unreferenced superseded version. A
   * `DaytonaError` (`snapshot-busy` on a `409`, `snapshot-forbidden` on a `403`) leaves the
   * row `ready` for the next pass and never stops the other versions or templates: retirement is
   * housekeeping, the refill's fill and drain must not starve on it.
   */
  private async retire(template: ProjectTemplate): Promise<void> {
    // ponytail: the "unreferenced" check is a `not exists` on sandbox_pool.snapshot per version per
    // pass; an index on sandbox_pool.snapshot if the pool ever has thousands of rows.
    for (const version of await this.versions.retirable(template)) {
      try {
        await this.daytona.removeSnapshot(version.snapshot);
      } catch (error) {
        if (!(error instanceof DaytonaError)) throw error;
        this.logger[error.retryable ? 'warn' : 'error'](
          `pool ${template}: snapshot ${version.snapshot} not removed (${error.kind}); retried next pass`,
        );
        continue;
      }
      await this.versions.retire(version, this.clock.now());
    }
  }

  /**
   * Once the current version's `ready` rows meet the target: every superseded `ready` row, then
   * the current-version rows beyond the target, oldest `ready_at` first → `releasing` + `release`
   * op, one tx. Short of the target nothing is released (fill before drain).
   */
  private async releaseSurplus(
    template: ProjectTemplate,
    target: number,
    snapshot: string,
  ): Promise<void> {
    const ready = await this.db
      .select({ id: sandboxPool.id, snapshot: sandboxPool.snapshot })
      .from(sandboxPool)
      .where(and(eq(sandboxPool.template, template), eq(sandboxPool.state, 'ready')))
      .orderBy(asc(sandboxPool.readyAt));
    const current = ready.filter((r) => r.snapshot === snapshot);
    if (current.length < target) return;
    const surplus = [
      ...ready.filter((r) => r.snapshot !== snapshot),
      ...current.slice(0, current.length - target),
    ].map((r) => r.id);
    if (surplus.length === 0) return;

    await this.db.transaction(async (tx) => {
      await tx
        .update(sandboxPool)
        .set({ state: 'releasing' })
        .where(inArray(sandboxPool.id, surplus));
      for (const poolId of surplus) {
        await this.outbox.append(tx, {
          aggregateId: poolId,
          payload: { op: 'release', poolId },
          type: 'sandbox.op.requested',
        });
      }
    });
  }

  /** Rows already counting toward the target: `creating` and `ready` on the current snapshot. */
  private async held(template: ProjectTemplate, snapshot: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(sandboxPool)
      .where(
        and(
          eq(sandboxPool.template, template),
          eq(sandboxPool.snapshot, snapshot),
          inArray(sandboxPool.state, ['creating', 'ready']),
        ),
      );
    return row?.n ?? 0;
  }

  private async create(settings: PoolSettings, snapshot: string): Promise<void> {
    const dto = await this.daytona.create({
      labels: {
        'forge.kind': 'pool',
        'forge.owner': this.owner,
        'forge.template': settings.template,
      },
      snapshot,
    });

    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(sandboxPool)
        .values({
          daytonaId: dto.id,
          node: dto.runnerId ?? null,
          snapshot,
          state: 'creating',
          template: settings.template,
        })
        .returning({ id: sandboxPool.id });

      await this.outbox.append(tx, {
        aggregateId: row!.id,
        payload: { op: 'create', poolId: row!.id },
        type: 'sandbox.op.requested',
      });
    });
  }
}
