import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { outbox } from '@repo/db';
import { and, eq, sql } from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { RUN_PROFILES_TOKEN } from '../../common/run-profiles/run-profiles.constants';
import type { RunProfile } from '../../config/run-profiles';
import { APP_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase } from '../../database/database.types';
import { OutboxWriter } from '../outbox/outbox-writer';
import {
  MAINTENANCE_JOBS,
  MAINTENANCE_LOCK,
  SANDBOX_TIMINGS,
  type SandboxTimings,
} from './sandbox.constants';

/**
 * The `cron` process's tick for the sandbox maintenance jobs (spec 014 research R7, contract § 4):
 * `RunReaper`'s shape with its own lock and a catalogue instead of a sweep. Each tick, under
 * `MAINTENANCE_LOCK`, appends one `maintenance.due` per `MAINTENANCE_JOBS` entry for the current
 * period, unless the outbox already holds that period's row — the dedupe is the durable row, not
 * process memory, so a handover between two cron replicas inside a period appends nothing twice
 * (SC-011). The consumer's job id is the second net; the jobs themselves compute from current
 * state, never from the job, which is the third.
 */
@Injectable()
export class MaintenanceScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MaintenanceScheduler.name);
  private readonly enabled: boolean;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(APP_DATABASE) private readonly db: ForgeDatabase,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(SANDBOX_TIMINGS) private readonly timings: SandboxTimings,
    @Inject(RUN_PROFILES_TOKEN) profiles: ReadonlySet<RunProfile>,
  ) {
    this.enabled = profiles.has('cron');
  }

  /** The `cron` profile owns the schedule (spec 013 R2); any other process appends nothing. */
  onApplicationBootstrap(): void {
    if (!this.enabled) {
      return;
    }

    this.timer = setInterval(() => {
      this.inFlight = this.tick().catch((error: unknown) => {
        this.logger.warn(`tick failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.timings.schedulerTickMs);
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.inFlight;
  }

  /**
   * One tick; returns how many `maintenance.due` rows it appended, or 0 at once when another
   * process holds the lock. Public so a suite can drive it without the timer.
   */
  async tick(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const { rows: lock } = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(${MAINTENANCE_LOCK}) as locked`,
      );

      if (lock[0]?.locked !== true) {
        return 0;
      }

      const now = this.clock.now().getTime();
      let appended = 0;

      for (const { job, periodMs } of MAINTENANCE_JOBS) {
        const periodStart = new Date(Math.floor(now / periodMs) * periodMs).toISOString();
        const aggregateId = `${job}:${periodStart}`;
        const [existing] = await tx
          .select({ id: outbox.id })
          .from(outbox)
          .where(and(eq(outbox.type, 'maintenance.due'), eq(outbox.aggregateId, aggregateId)))
          .limit(1);

        if (existing !== undefined) {
          continue;
        }

        await this.outbox.append(tx, {
          aggregateId,
          payload: { job, periodStart },
          type: 'maintenance.due',
        });
        appended += 1;
      }

      return appended;
    });
  }
}
