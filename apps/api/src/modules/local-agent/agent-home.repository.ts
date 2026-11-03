import { Inject, Injectable } from '@nestjs/common';
import type { SubscriptionProvider } from '@repo/contracts';
import { type AgentHomeRow, agentHomes as homes, localAgentDevices as devices } from '@repo/db';
import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';

import { APP_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';

export type AgentHomeState = AgentHomeRow['state'];

/**
 * `agent_homes` (spec 041) and the `cloud` device each one connects as. A root table with no RLS
 * (migration 0054), like `local_agent_devices`: every read a person can reach names `user_id`.
 * The lifecycle sweeps (idle stop, reconcile) read across people, as the BYOS sweep does.
 */
@Injectable()
export class AgentHomeRepository {
  constructor(
    @Inject(APP_DATABASE) private readonly db: ForgeDatabase,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
  ) {}

  /**
   * The person's home, created with its `cloud` device if there is none. The device's token is a
   * placeholder digest until the first start mints one; a race between two connects ends with one
   * row (the unique key), and the loser — its device rolled back — reads the winner's.
   */
  async findOrCreate(
    userId: string,
    provider: SubscriptionProvider,
    placeholderTokenHash: string,
  ): Promise<AgentHomeRow> {
    try {
      return await this.create(userId, provider, placeholderTokenHash);
    } catch (error) {
      if (!(error instanceof LostRace)) throw error;
      const winner = await this.forUser(userId, provider);
      if (winner === undefined) throw error;
      return winner;
    }
  }

  private create(
    userId: string,
    provider: SubscriptionProvider,
    placeholderTokenHash: string,
  ): Promise<AgentHomeRow> {
    return this.transactions.runInUserTransaction(userId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(homes)
        .where(and(eq(homes.userId, userId), eq(homes.provider, provider)));

      if (existing !== undefined) return existing;

      const [device] = await tx
        .insert(devices)
        .values({
          companionVersion: 'hosted',
          kind: 'cloud',
          name: 'Cloud agent home',
          platform: 'linux',
          tokenHash: placeholderTokenHash,
          userId,
        })
        .returning();
      const [row] = await tx
        .insert(homes)
        .values({ deviceId: device!.id, provider, userId })
        .onConflictDoNothing()
        .returning();

      if (row !== undefined) return row;

      // Lost the race: the device just inserted goes with this transaction's rollback.
      throw new LostRace();
    });
  }

  async forUser(userId: string, provider: SubscriptionProvider): Promise<AgentHomeRow | undefined> {
    const [row] = await this.db
      .select()
      .from(homes)
      .where(and(eq(homes.userId, userId), eq(homes.provider, provider)));

    return row;
  }

  /** Inside a run's create transaction (admission). */
  async forUserOn(
    tx: TenantTransaction,
    userId: string,
    provider: SubscriptionProvider,
  ): Promise<AgentHomeRow | undefined> {
    const [row] = await tx
      .select()
      .from(homes)
      .where(and(eq(homes.userId, userId), eq(homes.provider, provider)));

    return row;
  }

  async byDevice(deviceId: string): Promise<AgentHomeRow | undefined> {
    const [row] = await this.db.select().from(homes).where(eq(homes.deviceId, deviceId));

    return row;
  }

  async update(
    id: string,
    values: Partial<
      Pick<
        AgentHomeRow,
        'daytonaId' | 'lastError' | 'lastUsedAt' | 'sandboxCreatedAt' | 'startedAt' | 'state'
      >
    >,
  ): Promise<void> {
    await this.db
      .update(homes)
      .set({ ...values, updatedAt: sql`now()` })
      .where(eq(homes.id, id));
  }

  /**
   * Idle stop's claim: `running → stopping` only while the home is still unused since `cutoff`, so
   * a run that touched it in the meantime keeps it. The claimed row, or `undefined`.
   */
  async claimIdle(id: string, cutoff: Date): Promise<AgentHomeRow | undefined> {
    const [row] = await this.db
      .update(homes)
      .set({ state: 'stopping', updatedAt: sql`now()` })
      .where(
        and(
          eq(homes.id, id),
          eq(homes.state, 'running'),
          lt(sql`coalesce(${homes.lastUsedAt}, ${homes.updatedAt})`, cutoff),
        ),
      )
      .returning();

    return row;
  }

  /** A runner reporting from a home marked `error` (a start that gave up too soon): it is running. */
  async recover(deviceId: string): Promise<void> {
    await this.db
      .update(homes)
      .set({ lastError: null, lastUsedAt: sql`now()`, state: 'running', updatedAt: sql`now()` })
      .where(
        and(eq(homes.deviceId, deviceId), eq(homes.state, 'error'), isNotNull(homes.daytonaId)),
      );
  }

  /** Homes nobody has used since `cutoff` (never used: since created), across people (the sweep). */
  unusedSince(cutoff: Date): Promise<AgentHomeRow[]> {
    return this.db
      .select()
      .from(homes)
      .where(lt(sql`coalesce(${homes.lastUsedAt}, ${homes.createdAt})`, cutoff));
  }

  /** `last_used_at` now, for the home on this device: the home as it stands after, if any. */
  async touchDevice(deviceId: string, at: Date): Promise<AgentHomeRow | undefined> {
    const [row] = await this.db
      .update(homes)
      .set({ lastUsedAt: at, updatedAt: sql`now()` })
      .where(eq(homes.deviceId, deviceId))
      .returning();

    return row;
  }

  /** A fresh token's digest for the home's device; the previous token stops working at once. */
  async rotateToken(deviceId: string, tokenHash: string): Promise<void> {
    await this.db
      .update(devices)
      .set({ tokenHash, updatedAt: sql`now()` })
      .where(and(eq(devices.id, deviceId), eq(devices.kind, 'cloud')));
  }

  /**
   * Disconnect: the device is revoked (not deleted — it still names the runs it executed, as a
   * revoked companion does) and the home row goes, so a later connect starts a fresh home.
   */
  async remove(home: AgentHomeRow, at: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(homes).where(eq(homes.id, home.id));
      await tx
        .update(devices)
        .set({ revokedAt: at, updatedAt: sql`now()` })
        .where(eq(devices.id, home.deviceId));
    });
  }

  /** Every home in one of these states, across people (the lifecycle sweeps). */
  inStates(states: readonly AgentHomeState[]): Promise<AgentHomeRow[]> {
    return this.db
      .select()
      .from(homes)
      .where(inArray(homes.state, [...states]));
  }

  /** Every home with a sandbox, across people (reconcile). */
  withSandbox(): Promise<AgentHomeRow[]> {
    return this.db.select().from(homes).where(isNotNull(homes.daytonaId));
  }
}

/** `findOrCreate` lost the insert race to a concurrent connect. */
class LostRace extends Error {
  constructor() {
    super('agent home created concurrently');
  }
}
