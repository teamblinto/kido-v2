import { Inject, Injectable } from '@nestjs/common';
import type {
  LocalAgentPermissionMode,
  LocalAgentPlatform,
  LocalAgentProvider,
  LocalAgentToolMode,
  RunStatus,
} from '@repo/contracts';
import {
  agentRuns,
  type LocalAgentDeviceRow,
  localAgentDevices as devices,
  type LocalAgentRunRow,
  localAgentRuns as runs,
} from '@repo/db';
import { and, asc, eq, getTableColumns, inArray, isNull, sql } from 'drizzle-orm';

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
 * `local_agent_devices` and `local_agent_runs` (spec 040). Devices are a root table with no RLS
 * (migration 0051), so ownership is this class's to keep: every read a person can reach names
 * `user_id`. The token lookup is the one read without a person — the device token *is* the
 * caller — and it is by digest. Runs are tenant-owned: written in the run's tenant transaction,
 * and read across tenants only by `runForDevice`, through the read-only bypass role, for a device
 * that names no organisation.
 */
@Injectable()
export class LocalAgentRepository {
  constructor(
    @Inject(APP_DATABASE) private readonly db: ForgeDatabase,
    @Inject(BYPASS_DATABASE) private readonly bypass: ForgeDatabase,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
  ) {}

  /** `also` runs in the insert's transaction (the pairing notice's outbox row). */
  async create(
    values: {
      userId: string;
      name: string;
      platform: LocalAgentPlatform;
      companionVersion: string;
      tokenHash: string;
    },
    also: (tx: TenantTransaction, row: LocalAgentDeviceRow) => Promise<void> = () =>
      Promise.resolve(),
  ): Promise<LocalAgentDeviceRow> {
    return this.transactions.runInUserTransaction(values.userId, async (tx) => {
      const [row] = await tx.insert(devices).values(values).returning();

      await also(tx, row!);

      return row!;
    });
  }

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

  /**
   * The person's live paired computers, oldest first. Never an agent home's `cloud` device
   * (spec 041): that one is managed through `/me/subscriptions`, not paired or revoked by hand.
   */
  listForUser(userId: string): Promise<LocalAgentDeviceRow[]> {
    return this.transactions.runInUserTransaction(userId, (tx) =>
      tx
        .select()
        .from(devices)
        .where(
          and(eq(devices.userId, userId), isNull(devices.revokedAt), eq(devices.kind, 'local')),
        )
        .orderBy(asc(devices.createdAt)),
    );
  }

  /** Revokes the person's own live device; `undefined` for anyone else's, or one already revoked. */
  async revoke(
    userId: string,
    deviceId: string,
    at: Date,
  ): Promise<LocalAgentDeviceRow | undefined> {
    const [row] = await this.transactions.runInUserTransaction(userId, (tx) =>
      tx
        .update(devices)
        .set({ revokedAt: at, updatedAt: sql`now()` })
        .where(
          and(
            eq(devices.id, deviceId),
            eq(devices.userId, userId),
            isNull(devices.revokedAt),
            eq(devices.kind, 'local'),
          ),
        )
        .returning(),
    );

    return row;
  }

  async deviceOn(
    tx: TenantTransaction,
    deviceId: string,
  ): Promise<LocalAgentDeviceRow | undefined> {
    const [row] = await tx.select().from(devices).where(eq(devices.id, deviceId));

    return row;
  }

  async insertRun(
    tx: TenantTransaction,
    values: {
      orgId: string;
      runId: string;
      deviceId: string;
      provider: LocalAgentProvider;
      toolMode: LocalAgentToolMode;
      workspaceId: string | null;
      permissionMode: LocalAgentPermissionMode;
    },
  ): Promise<void> {
    await tx.insert(runs).values(values);
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
