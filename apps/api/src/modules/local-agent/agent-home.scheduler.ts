import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { RUN_PROFILES_TOKEN } from '../../common/run-profiles/run-profiles.constants';
import type { RunProfile } from '../../config/run-profiles';
import { APP_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase } from '../../database/database.types';
import { AgentHomeService } from './agent-home.service';

/** `pg_try_advisory_xact_lock` key for one agent-home tick across cron replicas. */
export const AGENT_HOME_LOCK = 7_304_101n;
export const AGENT_HOME_TICK_MS = 60_000;
/** Reconcile every this many ticks (five minutes), as `sandbox.reconcile`. */
export const RECONCILE_EVERY = 5;

/**
 * The `cron` process's agent-home jobs (spec 041 design, § Lifecycle jobs): every minute the idle
 * stop, every fifth the reconcile, the unused-home sweep and the agent-home snapshot retirement. `MaintenanceScheduler`'s shape — a timer in the `cron` profile
 * only and a transaction-scoped advisory lock so two replicas never run a tick at once — but the
 * jobs run in the tick rather than through the outbox: both compute from current state, so a lost
 * tick is simply the next one, and no queue (with its DLQ and worker) is needed for them.
 */
@Injectable()
export class AgentHomeScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AgentHomeScheduler.name);
  private readonly active: boolean;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<unknown> = Promise.resolve();
  private ticks = 0;

  constructor(
    @Inject(APP_DATABASE) private readonly db: ForgeDatabase,
    @Inject(AgentHomeService) private readonly homes: AgentHomeService,
    @Inject(RUN_PROFILES_TOKEN) profiles: ReadonlySet<RunProfile>,
  ) {
    this.active = profiles.has('cron') && homes.enabled;
  }

  onApplicationBootstrap(): void {
    if (!this.active) return;

    this.timer = setInterval(() => {
      this.inFlight = this.tick().catch((error: unknown) => {
        this.logger.warn(`tick failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, AGENT_HOME_TICK_MS);
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.inFlight;
  }

  /** One tick; `false` when another replica holds the lock. Public for the suites. */
  async tick(): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(${AGENT_HOME_LOCK}) as locked`,
      );

      if (rows[0]?.locked !== true) return false;

      const stopped = await this.homes.idleStop();
      if (stopped > 0) this.logger.log(`stopped ${String(stopped)} idle agent home(s)`);

      if (this.ticks++ % RECONCILE_EVERY === 0) {
        const report = await this.homes.reconcile();
        if (report.missing + report.orphaned + report.egress > 0) {
          this.logger.log(
            `reconciled agent homes: missing=${report.missing} orphaned=${report.orphaned} egress=${report.egress}`,
          );
        }
        const unused = await this.homes.sweepUnused();
        if (unused > 0) this.logger.log(`deleted ${String(unused)} unused agent home(s)`);
        const retired = await this.homes.retireTemplates();
        if (retired > 0) this.logger.log(`retired ${String(retired)} agent-home snapshot(s)`);
      }

      return true;
    });
  }
}
