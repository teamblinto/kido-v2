import { Inject, Injectable, Logger } from '@nestjs/common';
import { checkpoints, type Checkpoint, orgs, projects, sandboxes } from '@repo/db';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { QUEUE_REDIS } from '../../common/redis/redis.constants';
import { APP_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { EventConsumer, RetryableFailure } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import { RepoMirrorConsumer } from './repo-mirror.consumer';

export const REPO_MIRROR_SWEEP_QUEUE = 'repo.mirror-sweep';
/** Younger heads are left to their own `checkpoint.created`, which is still working on them. */
export const MIRROR_SWEEP_GRACE_MS = 2 * 60_000;
/** Sandboxes one tick may wake, so a backlog cannot start the whole fleet at once. */
export const MIRROR_SWEEP_BATCH = 4;
/**
 * Between tries of a head that failed. Mirroring touches the sandbox, so this must stay well above
 * the sweep's idle-to-hibernate time or a repository that cannot be mirrored never sleeps.
 */
export const MIRROR_SWEEP_RETRY_SECONDS = 6 * 60 * 60;

type DueEvent = Envelope<'maintenance.due'>;

/**
 * `repo.mirror-sweep`, every five minutes: a project whose head checkpoint has no mirror is one
 * lost sandbox away from losing its files, so a mirror whose event gave up, or that predates the
 * store, is taken again from here. `checkpoint.created` cannot be re-appended for it: other
 * consumers act on that event, and the mirror's own job id would be swallowed by its finished job.
 */
@Injectable()
export class RepoMirrorSweep extends EventConsumer<'maintenance.due', boolean> {
  readonly attempts = 1;
  override readonly concurrency = 1;
  readonly name = 'repo-mirror-sweep';
  override readonly profile = 'cron' as const;
  readonly queue = REPO_MIRROR_SWEEP_QUEUE;
  readonly types = ['maintenance.due'] as const;

  private readonly logger = new Logger(RepoMirrorSweep.name);

  constructor(
    @Inject(APP_DATABASE) private readonly db: ForgeDatabase,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(QUEUE_REDIS) private readonly redis: Redis,
    @Inject(RepoMirrorConsumer) private readonly mirrors: RepoMirrorConsumer,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {
    super();
  }

  override jobId(event: DueEvent): string {
    return `${event.payload.job}.${Date.parse(event.payload.periodStart)}.mirror-sweep`;
  }

  handle(event: DueEvent): Promise<boolean> {
    return Promise.resolve(event.payload.job === 'repo.mirror-sweep');
  }

  override async effect(_event: DueEvent, owned: boolean): Promise<void> {
    if (owned) await this.sweep();
  }

  async sweep(): Promise<{ failed: number; mirrored: number; waking: number }> {
    const report = { failed: 0, mirrored: 0, waking: 0 };
    const tenants = await this.db.select({ id: orgs.id }).from(orgs).where(isNull(orgs.deletedAt));
    let budget = MIRROR_SWEEP_BATCH;

    for (const { id: orgId } of tenants) {
      for (const row of await this.unmirroredHeads(orgId)) {
        const guard = `mirror-sweep:${row.id}`;
        if (budget === 0) break;
        if ((await this.redis.set(guard, '1', 'EX', MIRROR_SWEEP_RETRY_SECONDS, 'NX')) === null) {
          continue;
        }
        budget -= 1;

        try {
          await this.mirrors.mirror({ head: row.gitSha, row });
          report.mirrored += 1;
        } catch (error) {
          if (error instanceof RetryableFailure) {
            // Waking, or a blip: the next tick finds it awake, so the wait does not apply.
            await this.redis.del(guard);
            report.waking += 1;
          } else {
            report.failed += 1;
            this.logger.error(
              `mirror failed: project=${row.projectId} checkpoint=${row.id} ` +
                `error=${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    }

    if (report.mirrored + report.waking + report.failed > 0) {
      this.logger.log(
        `mirror sweep: mirrored=${report.mirrored} waking=${report.waking} failed=${report.failed}`,
      );
    }
    return report;
  }

  /** Each live project's head, when it is unmirrored, old enough, and has a sandbox to bundle from. */
  private unmirroredHeads(orgId: string): Promise<Checkpoint[]> {
    const settled = new Date(this.clock.now().getTime() - MIRROR_SWEEP_GRACE_MS);

    return this.transactions.runInTenantTransaction(orgId, async (tx) => {
      const heads = await tx
        .selectDistinctOn([checkpoints.projectId])
        .from(checkpoints)
        .where(eq(checkpoints.orgId, orgId))
        .orderBy(checkpoints.projectId, desc(checkpoints.createdAt), desc(checkpoints.id));
      const behind = heads.filter((row) => row.mirroredAt === null && row.createdAt < settled);

      if (behind.length === 0) return [];

      const live = await tx
        .select({ id: projects.id })
        .from(projects)
        .innerJoin(sandboxes, eq(sandboxes.projectId, projects.id))
        .where(
          and(eq(projects.orgId, orgId), isNull(projects.deletedAt), isNull(sandboxes.lostAt)),
        );
      const bundleable = new Set(live.map((row) => row.id));

      return behind.filter((row) => bundleable.has(row.projectId));
    });
  }
}
