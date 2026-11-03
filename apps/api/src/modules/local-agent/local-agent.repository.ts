import { Inject, Injectable } from '@nestjs/common';
import type { LocalAgentProvider, RunStatus } from '@repo/contracts';
import {
  agentRuns,
  type LocalAgentDeviceRow,
  localAgentDevices as devices,
  type LocalAgentRunRow,
  localAgentRuns as runs,
} from '@repo/db';
import { and, eq, getTableColumns, inArray, sql } from 'drizzle-orm';

import { APP_DATABASE, BYPASS_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';

/** The statuses in which a worker holds a run, i.e. it may be executing on its device. */
export const LIVE_RUN_STATUSES = [
  'starting',
  'running',
  'tool_error',
] as const satisfies RunStatus[];

/**
 * `local_agent_devices` and `local_agent_runs` (spec 040's tables; spec 041's runner). Devices are
 * a root table with no RLS (migration 0051), so ownership is this class's to keep; an agent home's
 * `cloud` device is created by `AgentHomeRepository`. The token lookup is the one read without a
 * person — the device token *is* the caller — and it is by digest. Runs are tenant-owned: written
 * in the run's tenant transaction, and read across tenants only by `runForDevice`, through the
 * read-only bypass role, for a device that names no organisation.
 */
@Injectable()
export class LocalAgentRepository {
  constructor(
    @Inject(APP_DATABASE) private readonly db: ForgeDatabase,
    @Inject(BYPASS_DATABASE) private readonly bypass: ForgeDatabase,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
  ) {}

  /** A device by id, whoever owns it: the command stream's per-heartbeat liveness check. */
  async byId(deviceId: string): Promise<LocalAgentDeviceRow | undefined> {
    const [row] = await this.db.select().from(devices).where(eq(devices.id, deviceId));

    return row;
  }

  async byTokenHash(tokenHash: string): Promise<LocalAgentDeviceRow | undefined> {
    const [row] = await this.db.select().from(devices).where(eq(devices.tokenHash, tokenHash));

    return row;
  }

  async touch(deviceId: string, at: Date): Promise<void> {
    await this.db.update(devices).set({ lastSeenAt: at }).where(eq(devices.id, deviceId));
  }

  async setCompanionVersion(deviceId: string, companionVersion: string): Promise<void> {
    await this.db
      .update(devices)
      .set({ companionVersion, updatedAt: sql`now()` })
      .where(eq(devices.id, deviceId));
  }

  async deviceOn(
    tx: TenantTransaction,
    deviceId: string,
  ): Promise<LocalAgentDeviceRow | undefined> {
    const [row] = await tx.select().from(devices).where(eq(devices.id, deviceId));

    return row;
  }

  /** Always the sandbox tool mode: the CLI's own tools are off and it calls the sandbox's. */
  async insertRun(
    tx: TenantTransaction,
    values: { orgId: string; runId: string; deviceId: string; provider: LocalAgentProvider },
  ): Promise<void> {
    await tx
      .insert(runs)
      .values({ ...values, permissionMode: 'default', toolMode: 'sandbox', workspaceId: null });
  }

  async runOn(
    tx: TenantTransaction,
    orgId: string,
    runId: string,
  ): Promise<LocalAgentRunRow | undefined> {
    const [row] = await tx
      .select()
      .from(runs)
      .where(and(eq(runs.orgId, orgId), eq(runs.runId, runId)));

    return row;
  }

  /**
   * The run this device executes and the run's status, across tenants — the device's own requests
   * carry no tenant.
   */
  async runForDevice(
    runId: string,
    deviceId: string,
  ): Promise<(LocalAgentRunRow & { status: RunStatus }) | undefined> {
    const [row] = await this.bypass
      .select({ ...getTableColumns(runs), status: agentRuns.status })
      .from(runs)
      .innerJoin(agentRuns, and(eq(agentRuns.orgId, runs.orgId), eq(agentRuns.id, runs.runId)))
      .where(and(eq(runs.runId, runId), eq(runs.deviceId, deviceId)));

    return row;
  }

  /** The device's runs a worker may be executing now, across tenants (revocation ends them). */
  liveRunsOf(
    deviceId: string,
    statuses: readonly RunStatus[] = LIVE_RUN_STATUSES,
  ): Promise<{ orgId: string; runId: string }[]> {
    return this.bypass
      .select({ orgId: runs.orgId, runId: runs.runId })
      .from(runs)
      .innerJoin(agentRuns, and(eq(agentRuns.orgId, runs.orgId), eq(agentRuns.id, runs.runId)))
      .where(and(eq(runs.deviceId, deviceId), inArray(agentRuns.status, [...statuses])));
  }

  async setProviderSession(orgId: string, runId: string, providerSessionId: string): Promise<void> {
    await this.transactions.runInTenantTransaction(orgId, (tx) =>
      tx
        .update(runs)
        .set({ providerSessionId, updatedAt: sql`now()` })
        .where(and(eq(runs.orgId, orgId), eq(runs.runId, runId))),
    );
  }
}
