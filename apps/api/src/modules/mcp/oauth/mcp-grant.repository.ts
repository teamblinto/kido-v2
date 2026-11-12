import { Inject, Injectable } from '@nestjs/common';
import { type McpClientRow, type McpGrantRow, mcpClients, mcpGrants } from '@repo/db';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';

import { APP_DATABASE, BYPASS_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../../database/database.types';

/** The two hashes and their expiries a token rotation writes. */
export interface McpTokenHashes {
  readonly accessExpiresAt: Date;
  readonly accessTokenHash: string;
  readonly refreshExpiresAt: Date;
  readonly refreshTokenHash: string;
}

export interface McpGrantWithClient {
  readonly client: McpClientRow;
  readonly grant: McpGrantRow;
}

/**
 * `mcp_clients` (a root, migration 0059) and `mcp_grants` (tenant-owned). The token lookups are the
 * only reads without a tenant — the token *is* the caller, as with the `bld_` device token — and
 * they go through the read-only bypass role by digest. Every grant write takes the caller's tenant
 * transaction, so RLS checks it like any other tenant row.
 */
@Injectable()
export class McpGrantRepository {
  constructor(
    @Inject(APP_DATABASE) private readonly db: ForgeDatabase,
    @Inject(BYPASS_DATABASE) private readonly bypass: ForgeDatabase,
  ) {}

  async createClient(entry: {
    clientName: string;
    clientUri: string | null;
    redirectUris: string[];
  }): Promise<McpClientRow> {
    const [row] = await this.db.insert(mcpClients).values(entry).returning();

    return row!;
  }

  async clientById(id: string): Promise<McpClientRow | undefined> {
    const [row] = await this.db.select().from(mcpClients).where(eq(mcpClients.id, id));

    return row;
  }

  async byAccessTokenHash(hash: string): Promise<McpGrantRow | undefined> {
    const [row] = await this.bypass
      .select()
      .from(mcpGrants)
      .where(eq(mcpGrants.accessTokenHash, hash));

    return row;
  }

  /** The grant a refresh token belongs to, or the one it was rotated out of (a replay). */
  async byRefreshTokenHash(
    hash: string,
  ): Promise<{ grant: McpGrantRow; replayed: boolean } | undefined> {
    const [row] = await this.bypass
      .select()
      .from(mcpGrants)
      .where(or(eq(mcpGrants.refreshTokenHash, hash), eq(mcpGrants.previousRefreshHash, hash)));

    return row === undefined ? undefined : { grant: row, replayed: row.refreshTokenHash !== hash };
  }

  async insertGrant(
    tx: TenantTransaction,
    entry: McpTokenHashes & { clientId: string; orgId: string; scopes: string[]; userId: string },
  ): Promise<McpGrantRow> {
    const [row] = await tx.insert(mcpGrants).values(entry).returning();

    return row!;
  }

  /**
   * Swap the token pair, but only if `fromRefreshHash` is still the live one. Two refreshes racing
   * on one token both read the grant; the second finds the hash already moved and gets `false`.
   */
  async rotate(
    tx: TenantTransaction,
    grantId: string,
    fromRefreshHash: string,
    next: McpTokenHashes,
  ): Promise<boolean> {
    const rows = await tx
      .update(mcpGrants)
      .set({ ...next, previousRefreshHash: fromRefreshHash, updatedAt: sql`now()` })
      .where(
        and(
          eq(mcpGrants.id, grantId),
          eq(mcpGrants.refreshTokenHash, fromRefreshHash),
          isNull(mcpGrants.revokedAt),
        ),
      )
      .returning({ id: mcpGrants.id });

    return rows.length === 1;
  }

  async touch(tx: TenantTransaction, grantId: string, at: Date): Promise<void> {
    await tx.update(mcpGrants).set({ lastUsedAt: at }).where(eq(mcpGrants.id, grantId));
  }

  /** Revokes a live grant; `userId` narrows it to the caller's own. `false` if nothing matched. */
  async revoke(
    tx: TenantTransaction,
    grantId: string,
    at: Date,
    userId?: string,
  ): Promise<boolean> {
    const rows = await tx
      .update(mcpGrants)
      .set({ revokedAt: at, updatedAt: sql`now()` })
      .where(
        and(
          eq(mcpGrants.id, grantId),
          isNull(mcpGrants.revokedAt),
          userId === undefined ? undefined : eq(mcpGrants.userId, userId),
        ),
      )
      .returning({ id: mcpGrants.id });

    return rows.length === 1;
  }

  async liveForUser(tx: TenantTransaction, userId: string): Promise<McpGrantWithClient[]> {
    const rows = await tx
      .select({ client: mcpClients, grant: mcpGrants })
      .from(mcpGrants)
      .innerJoin(mcpClients, eq(mcpClients.id, mcpGrants.clientId))
      .where(and(eq(mcpGrants.userId, userId), isNull(mcpGrants.revokedAt)))
      .orderBy(desc(mcpGrants.createdAt));

    return rows;
  }
}
