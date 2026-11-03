import { Injectable } from '@nestjs/common';
import type {
  LocalAgentRunTarget,
  LocalAgentToolMode,
  SubscriptionRunTarget,
} from '@repo/contracts';
import { localAgentRuns } from '@repo/db';
import { and, eq } from 'drizzle-orm';

import type { TenantTransaction } from '../../database/database.types';
import type { RunExecutor, RunOutcome } from './run-executor.port';

/** What a run on the person's own device (spec 040) answers besides `execute`. */
export interface LocalRunExecutor extends RunExecutor {
  /**
   * Inside the create's tenant transaction, after the run row exists: refuse the target with a
   * problem (offline, provider unavailable, unknown workspace), or record it with the run.
   */
  admit(
    tx: TenantTransaction,
    run: { orgId: string; projectId: string; runId: string; userId: string },
    target: LocalAgentRunTarget,
  ): Promise<void>;
  /**
   * Spec 041: the same for a `subscription` target — the person's cloud agent home, signed in
   * (else `subscription-not-connected`), recorded as a sandbox-tool-mode run on its device.
   */
  admitSubscription(
    tx: TenantTransaction,
    run: { orgId: string; projectId: string; runId: string; userId: string },
    target: SubscriptionRunTarget,
  ): Promise<void>;
  /**
   * After commit, for a run a cancel ended where no attempt held it (waiting on its starter): drop
   * the per-run state the device side keeps. Best effort; it all expires on its own.
   */
  release(runId: string): Promise<void>;
}

/**
 * A local run on a process where the local executor is not registered (`LOCAL_AGENT_ENABLED`
 * turned off after it was created): it fails, rather than reaching the cloud executor with a
 * prompt meant for the person's own machine.
 */
export const LOCAL_AGENT_UNAVAILABLE: RunExecutor = {
  execute: (): Promise<RunOutcome> =>
    Promise.resolve({
      failureClass: 'executor',
      kind: 'failed',
      reason:
        'local-agent disabled: local agents are not enabled on this deployment, so this run cannot reach its device',
    }),
};

/**
 * How a run reaches an executor other than `RUN_EXECUTOR` (spec 040 § 3 decision 4). `agent` never
 * imports the local agent module: that module registers itself here at init, so the edge runs
 * `local-agent → agent` only. Whether a run is local is read from `local_agent_runs` through the
 * shared schema (as checkpoints reads `agent_runs`), so it does not depend on the registration: a
 * local run never falls back to the default executor.
 */
@Injectable()
export class RunExecutorRegistry {
  private local: LocalRunExecutor | undefined;

  register(executor: LocalRunExecutor): void {
    this.local = executor;
  }

  localAgent(): LocalRunExecutor | undefined {
    return this.local;
  }

  /** Whether this run was created with a local target; asked in a tenant transaction. */
  async isLocal(tx: TenantTransaction, orgId: string, runId: string): Promise<boolean> {
    return (await this.localRun(tx, orgId, runId)) !== undefined;
  }

  /**
   * Spec 041: where a local run's tools act — `sandbox` runs use the project's sandbox as a cloud
   * run does — or `undefined` for a run with no local target.
   */
  async toolMode(
    tx: TenantTransaction,
    orgId: string,
    runId: string,
  ): Promise<LocalAgentToolMode | undefined> {
    return (await this.localRun(tx, orgId, runId))?.toolMode;
  }

  private async localRun(tx: TenantTransaction, orgId: string, runId: string) {
    const [row] = await tx
      .select({ toolMode: localAgentRuns.toolMode })
      .from(localAgentRuns)
      .where(and(eq(localAgentRuns.orgId, orgId), eq(localAgentRuns.runId, runId)));

    return row;
  }

  /**
   * The executor this run belongs to, or `undefined` for the default one. A local run gets the
   * local executor, or — when none is registered — one that fails it with the reason.
   */
  async select(
    tx: TenantTransaction,
    orgId: string,
    runId: string,
  ): Promise<RunExecutor | undefined> {
    if (!(await this.isLocal(tx, orgId, runId))) return undefined;

    return this.local ?? LOCAL_AGENT_UNAVAILABLE;
  }
}
