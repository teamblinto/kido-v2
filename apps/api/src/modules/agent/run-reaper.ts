import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { orgs } from '@repo/db';
import { isNull, sql } from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { RUN_PROFILES_TOKEN } from '../../common/run-profiles/run-profiles.constants';
import type { RunProfile } from '../../config/run-profiles';
import { APP_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import {
  AGENT_TIMINGS,
  type AgentTimings,
  RUN_LINE_SWEEP_AFTER_MS,
  RUN_REAPER_LOCK,
} from './agent.constants';
import { FencedError, RunStore } from './run-store';
import { RunStreamPublisher } from './run-stream-publisher';

/**
 * Fails runs whose worker is gone (spec 008 research R5, FR-020): a lease untouched for
 * `staleAfterMs` — longer than BullMQ's whole stall budget, so the queue has given up first — is
 * moved to `failed` / `stalled` through the ordinary transition, under `lease_epoch + 1`, so the
 * worker that stalled is fenced out should it come back. The tick also keeps next month's
 * `run_events` partition declared (research R2), once a day.
 *
 * `agent_runs` is under forced RLS and this process holds no bypass role, so the sweep is one
 * tenant transaction per organisation; each is an index-served read that finds nothing almost
 * every time. One reaper per tick across replicas (spec 013 R4): the tick runs inside an
 * application-pool transaction that first tries `RUN_REAPER_LOCK`, and a process that does not
 * get it does nothing — the relay's election, with its own key. ponytail: the per-org loop stays;
 * a platform-level lease read is the upgrade if the tenant count makes the sweep slow.
 */
@Injectable()
export class RunReaper implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RunReaper.name);
  private readonly enabled: boolean;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<unknown> = Promise.resolve();
  private partitionedOn: string | undefined;

  constructor(
    @Inject(APP_DATABASE) private readonly db: ForgeDatabase,
    @Inject(RunStore) private readonly store: RunStore,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(AGENT_TIMINGS) private readonly timings: AgentTimings,
    @Inject(RUN_PROFILES_TOKEN) profiles: ReadonlySet<RunProfile>,
    @Inject(RunStreamPublisher) private readonly publisher: RunStreamPublisher,
  ) {
    this.enabled = profiles.has('cron');
  }

  /** The `cron` profile owns the sweep (spec 013 R2); any other process leaves the workers unjudged. */
  onApplicationBootstrap(): void {
    if (!this.enabled) {
      return;
    }

    this.timer = setInterval(() => {
      this.inFlight = this.tick().catch((error: unknown) => {
        this.logger.warn(`tick failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.timings.reaperMs);
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.inFlight;
  }

  /**
   * One sweep; returns how many runs it failed, or 0 at once when another process holds the
   * lock. Public so a suite can drive it without the timer.
   */
  async tick(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const { rows: lock } = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(${RUN_REAPER_LOCK}) as locked`,
      );

      if (lock[0]?.locked !== true) {
        return 0;
      }

      return this.sweep();
    });
  }

  private async sweep(): Promise<number> {
    await this.declarePartition();

    const before = new Date(this.clock.now().getTime() - this.timings.staleAfterMs);
    // 031 R2: a line whose head has waited this long with nothing holding the project lost its
    // release (`agent-run.finished` never consumed); dispatch the head again.
    const lineCutoff = new Date(this.clock.now().getTime() - RUN_LINE_SWEEP_AFTER_MS);
    const tenants = await this.db.select({ id: orgs.id }).from(orgs).where(isNull(orgs.deletedAt));
    let reaped = 0;

    for (const { id: orgId } of tenants) {
      const failed = await this.transactions.runInTenantTransaction(orgId, async (tx) => {
        const runs: string[] = [];

        for (const run of await this.store.staleRuns(tx, before)) {
          const fence = { epoch: run.leaseEpoch, orgId, runId: run.id };

          try {
            await this.store.expireLease(tx, fence);
            await this.store.transition(tx, {
              ...fence,
              epoch: run.leaseEpoch + 1,
              failureClass: 'stalled',
              from: run.status,
              reason: 'stalled',
              to: 'failed',
            });
            runs.push(run.id);
          } catch (error) {
            // A worker re-claimed it between the read and the write: the run is theirs again.
            if (!(error instanceof FencedError)) {
              throw error;
            }
          }
        }

        for (const head of await this.store.staleHeads(tx, lineCutoff)) {
          await this.store.dispatch(tx, { orgId, projectId: head.projectId, runId: head.id });
        }

        return runs;
      });

      // Committed: the `failed` state event reaches the stream (009 R1), so a tail closes.
      for (const runId of failed) {
        await this.publisher.sync(orgId, runId);
      }

      reaped += failed.length;
    }

    return reaped;
  }

  /** Idempotent in the database; called once per calendar day of the clock, cheap when it is a no-op. */
  private async declarePartition(): Promise<void> {
    const today = this.clock.now().toISOString().slice(0, 10);

    if (this.partitionedOn === today) {
      return;
    }

    await this.db.execute(
      sql`select create_run_events_partition((${today}::date + interval '1 month')::date)`,
    );
    this.partitionedOn = today;
  }
}
