import { Inject, Injectable } from '@nestjs/common';
import type { LinkedAccount } from '@repo/contracts';
import { type LinkedAccountRow, schema } from '@repo/db';
import { and, asc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';

import type { ForgeDatabase, TenantTransaction } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import type { LlmProviderName } from '../llm-provider.port';

const table = schema.linkedAccounts;

/** The wire shape (contracts § 1): the label and the dates — never `grant_sealed`. */
export function toContract(row: LinkedAccountRow): LinkedAccount {
  return {
    accountLabel: row.accountLabel,
    health: row.health === 'needs_reauth' ? 'needs_reauth' : 'healthy',
    lastCheckedAt: row.lastCheckedAt.toISOString(),
    limitedUntil: row.limitedUntil?.toISOString() ?? null,
    linkedAt: row.linkedAt.toISOString(),
    provider: row.provider,
  };
}

export interface LinkedAccountUpsert {
  readonly userId: string;
  readonly provider: LlmProviderName;
  readonly accountLabel: string;
  readonly grantSealed: Buffer;
  readonly accessExpiresAt: Date;
  readonly linkedAt: Date;
  readonly lastCheckedAt: Date;
}

export interface LinkedAccountGrant {
  readonly grantSealed: Buffer;
  readonly accessExpiresAt: Date;
  readonly accountLabel: string;
  readonly lastCheckedAt: Date;
}

/**
 * `linked_accounts` (spec 032 T022). A root table with no RLS (ADR 015), so ownership is this
 * class's to keep: every read or write a controller can reach names `user_id` and runs in the
 * caller's user transaction (`runInUserTransaction`) or one it is handed. The two methods that
 * cross users — `staleForSweep` and `byProviderForWithdrawal` — are for the worker and the
 * operator command only; no controller calls them.
 */
@Injectable()
export class LinkedAccountRepository {
  constructor(
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
  ) {}

  list(userId: string): Promise<LinkedAccountRow[]> {
    return this.transactions.runInUserTransaction(userId, (tx) =>
      tx.select().from(table).where(eq(table.userId, userId)).orderBy(asc(table.provider)),
    );
  }

  byProvider(userId: string, provider: LlmProviderName): Promise<LinkedAccountRow | undefined> {
    return this.transactions.runInUserTransaction(userId, async (tx) => {
      const [row] = await tx
        .select()
        .from(table)
        .where(and(eq(table.userId, userId), eq(table.provider, provider)));
      return row;
    });
  }

  /**
   * The same reads on a transaction the caller holds (032 T034/T036): the resolver and the
   * catalogue run inside a request's or a worker's tenant transaction, and a second pooled
   * connection per call would starve the pool under concurrent run creates.
   */
  async byProviderOn(
    tx: TenantTransaction,
    userId: string,
    provider: LlmProviderName,
  ): Promise<LinkedAccountRow | undefined> {
    const [row] = await tx
      .select()
      .from(table)
      .where(and(eq(table.userId, userId), eq(table.provider, provider)));
    return row;
  }

  listOn(tx: TenantTransaction, userId: string): Promise<LinkedAccountRow[]> {
    return tx.select().from(table).where(eq(table.userId, userId)).orderBy(asc(table.provider));
  }

  async lockByProvider(
    tx: TenantTransaction,
    userId: string,
    provider: LlmProviderName,
  ): Promise<LinkedAccountRow | undefined> {
    const [row] = await tx
      .select()
      .from(table)
      .where(and(eq(table.userId, userId), eq(table.provider, provider)))
      .for('update');
    return row;
  }

  /** Link or relink in one statement; a relink starts healthy and unlimited. */
  async upsert(tx: TenantTransaction, values: LinkedAccountUpsert): Promise<LinkedAccountRow> {
    const [row] = await tx
      .insert(table)
      .values({ ...values, health: 'healthy', limitedUntil: null })
      .onConflictDoUpdate({
        set: {
          accessExpiresAt: values.accessExpiresAt,
          accountLabel: values.accountLabel,
          grantSealed: values.grantSealed,
          health: 'healthy',
          lastCheckedAt: values.lastCheckedAt,
          limitedUntil: null,
          linkedAt: values.linkedAt,
          updatedAt: sql`now()`,
        },
        target: [table.userId, table.provider],
      })
      .returning();
    return row!;
  }

  async delete(
    tx: TenantTransaction,
    userId: string,
    provider: LlmProviderName,
  ): Promise<LinkedAccountRow | undefined> {
    const [row] = await tx
      .delete(table)
      .where(and(eq(table.userId, userId), eq(table.provider, provider)))
      .returning();
    return row;
  }

  async setGrant(tx: TenantTransaction, id: string, grant: LinkedAccountGrant): Promise<void> {
    await tx
      .update(table)
      .set({ ...grant, updatedAt: sql`now()` })
      .where(eq(table.id, id));
  }

  /** Sets health and bumps `health_changes`; answers the new count. */
  async setHealth(
    tx: TenantTransaction,
    id: string,
    health: 'healthy' | 'needs_reauth',
  ): Promise<number> {
    const [row] = await tx
      .update(table)
      .set({ health, healthChanges: sql`${table.healthChanges} + 1`, updatedAt: sql`now()` })
      .where(eq(table.id, id))
      .returning({ healthChanges: table.healthChanges });
    return row?.healthChanges ?? 0;
  }

  /** 032 T043: the check happened, whatever it said; the sweep reads this. */
  async touch(tx: TenantTransaction, id: string, at: Date): Promise<void> {
    await tx
      .update(table)
      .set({ lastCheckedAt: at, updatedAt: sql`now()` })
      .where(eq(table.id, id));
  }

  async setLimitedUntil(tx: TenantTransaction, id: string, at: Date | null): Promise<void> {
    await tx
      .update(table)
      .set({ limitedUntil: at, updatedAt: sql`now()` })
      .where(eq(table.id, id));
  }

  /** 032 T046: clears a recorded limit, writing only when there is one. */
  async clearLimitedUntil(
    tx: TenantTransaction,
    userId: string,
    provider: LlmProviderName,
  ): Promise<void> {
    await tx
      .update(table)
      .set({ limitedUntil: null, updatedAt: sql`now()` })
      .where(
        and(eq(table.userId, userId), eq(table.provider, provider), isNotNull(table.limitedUntil)),
      );
  }

  /** Worker only (the daily sweep): the rows least recently checked, across users. */
  staleForSweep(
    database: ForgeDatabase | TenantTransaction,
    providers: readonly LlmProviderName[],
    olderThan: Date,
    limit: number,
  ): Promise<LinkedAccountRow[]> {
    if (providers.length === 0) return Promise.resolve([]);
    return database
      .select()
      .from(table)
      .where(and(inArray(table.provider, [...providers]), lt(table.lastCheckedAt, olderThan)))
      .orderBy(asc(table.lastCheckedAt))
      .limit(limit);
  }

  /** Operator command only (`byos:provider … withdrawn`): every link to `provider`, across users. */
  byProviderForWithdrawal(
    tx: TenantTransaction,
    provider: LlmProviderName,
  ): Promise<Pick<LinkedAccountRow, 'id' | 'userId'>[]> {
    return tx
      .select({ id: table.id, userId: table.userId })
      .from(table)
      .where(eq(table.provider, provider));
  }
}
