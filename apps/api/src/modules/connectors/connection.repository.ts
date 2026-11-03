import { Injectable } from '@nestjs/common';
import { type Connection, type NewConnection, schema } from '@repo/db';
import { and, eq, getTableColumns, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

import type { SealedSecret, SealedSecretRow } from '../../common/crypto/dek.service';
import type { TenantTransaction } from '../../database/database.types';
import { afterFailure, afterSuccess, isOpen } from '../../common/circuit/circuit';

/** A resource a removal could not release (spec 030 contracts/bindings.md § 1). */
export interface FailedResource {
  readonly kind: string;
  readonly name: string;
}

/**
 * A `connections` row with the derived columns the contract needs: who, the fingerprint, and
 * (spec 030) the resources a removal could not release.
 */
export interface ConnectionRecord extends Connection {
  readonly connectedByName: string;
  readonly credentialFingerprint: string | null;
  readonly failedResources: readonly FailedResource[];
}

/**
 * The `connections` rows and their `secrets` rows — the first production writer of `secrets`
 * (research R2). Every statement runs on the tenant transaction and names `org_id` itself, so RLS
 * and the composite keys are two independent refusals, not one.
 */
@Injectable()
export class ConnectionRepository {
  private selection() {
    return {
      ...getTableColumns(schema.connections),
      connectedByName: schema.users.email,
      credentialFingerprint: schema.secrets.fingerprint,
      failedResources: sql<FailedResource[]>`coalesce((
        select json_agg(json_build_object('kind', r.kind, 'name', r.name) order by r.created_at)
          from ${schema.connectorResources} r
         where r.org_id = ${schema.connections.orgId}
           and r.connection_id = ${schema.connections.id}
           and r.state = 'failed'
      ), '[]'::json)`,
    };
  }

  private query(tx: TenantTransaction) {
    return tx
      .select(this.selection())
      .from(schema.connections)
      .innerJoin(schema.users, eq(schema.users.id, schema.connections.connectedBy))
      .leftJoin(
        schema.secrets,
        and(
          eq(schema.secrets.orgId, schema.connections.orgId),
          eq(schema.secrets.id, schema.connections.secretId),
        ),
      );
  }

  async forOrg(tx: TenantTransaction, orgId: string): Promise<ConnectionRecord[]> {
    return this.query(tx).where(eq(schema.connections.orgId, orgId));
  }

  async byId(
    tx: TenantTransaction,
    orgId: string,
    id: string,
  ): Promise<ConnectionRecord | undefined> {
    const [row] = await this.query(tx).where(
      and(eq(schema.connections.orgId, orgId), eq(schema.connections.id, id)),
    );

    return row;
  }

  async byProvider(
    tx: TenantTransaction,
    orgId: string,
    provider: Connection['provider'],
  ): Promise<ConnectionRecord | undefined> {
    const [row] = await this.query(tx).where(
      and(eq(schema.connections.orgId, orgId), eq(schema.connections.provider, provider)),
    );

    return row;
  }

  /** R15: the row lock the single-flight re-mint (and, spec 030, the Supabase refresh) serialises on. */
  async lockForUpdate(
    tx: TenantTransaction,
    orgId: string,
    provider: Connection['provider'] = 'github',
  ): Promise<Connection | undefined> {
    const [row] = await tx
      .select()
      .from(schema.connections)
      .where(and(eq(schema.connections.orgId, orgId), eq(schema.connections.provider, provider)))
      .for('update');

    return row;
  }

  /**
   * One per `(org_id, provider)`: a second install (or, spec 030, a second paste) replaces the
   * account, the credential and the scopes in place, and ends any removal in progress.
   */
  async upsert(tx: TenantTransaction, draft: NewConnection): Promise<Connection> {
    const [row] = await tx
      .insert(schema.connections)
      .values(draft)
      .onConflictDoUpdate({
        set: {
          accountId: draft.accountId ?? null,
          accountLogin: draft.accountLogin,
          accountRef: draft.accountRef ?? null,
          accountType: draft.accountType ?? null,
          authType: draft.authType ?? 'app_installation',
          circuitOpenUntil: null,
          connectedBy: draft.connectedBy,
          failureCount: 0,
          grantedScopes: draft.grantedScopes ?? [],
          health: draft.health,
          installationId: draft.installationId ?? null,
          lastVerifiedAt: draft.lastVerifiedAt,
          removalRequestedAt: null,
          secretId: draft.secretId,
          tokenExpiresAt: draft.tokenExpiresAt,
          updatedAt: sql`now()`,
        },
        target: [schema.connections.orgId, schema.connections.provider],
      })
      .returning();

    return row!;
  }

  async setSecret(
    tx: TenantTransaction,
    orgId: string,
    id: string,
    secretId: string | null,
    tokenExpiresAt: Date | null,
  ): Promise<void> {
    await tx
      .update(schema.connections)
      .set({ secretId, tokenExpiresAt })
      .where(and(eq(schema.connections.orgId, orgId), eq(schema.connections.id, id)));
  }

  async setHealth(
    tx: TenantTransaction,
    orgId: string,
    id: string,
    health: Connection['health'],
    lastVerifiedAt: Date,
  ): Promise<void> {
    await tx
      .update(schema.connections)
      .set({ health, lastVerifiedAt })
      .where(and(eq(schema.connections.orgId, orgId), eq(schema.connections.id, id)));
  }

  /**
   * R10: one transient provider failure. The row is locked and re-read so concurrent workers count
   * on the stored value; at the threshold the row turns `unavailable`. A `needs_reauth` row keeps
   * that health — re-authorisation outranks the breaker.
   */
  async recordFailure(tx: TenantTransaction, orgId: string, id: string, now: Date): Promise<void> {
    const row = await this.lockById(tx, orgId, id);

    if (row === undefined) {
      return;
    }

    const next = afterFailure(row, now);
    const health = row.health === 'needs_reauth' || !isOpen(next, now) ? row.health : 'unavailable';

    await tx
      .update(schema.connections)
      .set({ ...next, health })
      .where(and(eq(schema.connections.orgId, orgId), eq(schema.connections.id, id)));
  }

  /** R10: a success closes the circuit and, unless re-authorisation is pending, marks the row healthy. */
  async recordSuccess(tx: TenantTransaction, orgId: string, id: string, now: Date): Promise<void> {
    const row = await this.lockById(tx, orgId, id);

    if (row === undefined) {
      return;
    }

    await tx
      .update(schema.connections)
      .set({
        ...afterSuccess(),
        health: row.health === 'needs_reauth' ? row.health : 'healthy',
        lastVerifiedAt: now,
      })
      .where(and(eq(schema.connections.orgId, orgId), eq(schema.connections.id, id)));
  }

  private async lockById(
    tx: TenantTransaction,
    orgId: string,
    id: string,
  ): Promise<Connection | undefined> {
    const [row] = await tx
      .select()
      .from(schema.connections)
      .where(and(eq(schema.connections.orgId, orgId), eq(schema.connections.id, id)))
      .for('update');

    return row;
  }

  /**
   * Spec 030 contracts/bindings.md § 1: the connection takes no new work from now on; false when
   * the row is gone or its removal was already requested.
   */
  async requestRemoval(
    tx: TenantTransaction,
    orgId: string,
    id: string,
    at: Date,
  ): Promise<boolean> {
    const rows = await tx
      .update(schema.connections)
      .set({ removalRequestedAt: at, updatedAt: at })
      .where(
        and(
          eq(schema.connections.orgId, orgId),
          eq(schema.connections.id, id),
          isNull(schema.connections.removalRequestedAt),
        ),
      )
      .returning({ id: schema.connections.id });

    return rows.length > 0;
  }

  /** Spec 030 § 7: a removed connection's bindings stay, `disconnected`, for a reconnect to repair. */
  async disconnectBindings(
    tx: TenantTransaction,
    orgId: string,
    connectionId: string,
  ): Promise<void> {
    await tx
      .update(schema.connectorBindings)
      .set({ connectionId: null, state: 'disconnected', updatedAt: sql`now()` })
      .where(
        and(
          eq(schema.connectorBindings.orgId, orgId),
          eq(schema.connectorBindings.connectionId, connectionId),
        ),
      );
  }

  /**
   * Spec 030 T076: the sealed values (branch URI, keys) of the connection's released or failed
   * resources are deleted with it. The rows let go first — the FK is `no action`.
   */
  async dropResourceValues(
    tx: TenantTransaction,
    orgId: string,
    connectionId: string,
  ): Promise<void> {
    const owned = and(
      eq(schema.connectorResources.orgId, orgId),
      eq(schema.connectorResources.connectionId, connectionId),
      inArray(schema.connectorResources.state, ['released', 'failed']),
      isNotNull(schema.connectorResources.secretId),
    );
    const rows = await tx
      .select({ secretId: schema.connectorResources.secretId })
      .from(schema.connectorResources)
      .where(owned);

    if (rows.length === 0) return;

    await tx
      .update(schema.connectorResources)
      .set({ secretId: null, updatedAt: sql`now()` })
      .where(owned);
    await tx.delete(schema.secrets).where(
      and(
        eq(schema.secrets.orgId, orgId),
        inArray(
          schema.secrets.id,
          rows.map((row) => row.secretId!),
        ),
      ),
    );
  }

  async delete(tx: TenantTransaction, orgId: string, id: string): Promise<void> {
    await tx
      .delete(schema.connections)
      .where(and(eq(schema.connections.orgId, orgId), eq(schema.connections.id, id)));
  }

  /** The row `DekService.sealSecret` shaped, written under the tenant. */
  async insertSecret(
    tx: TenantTransaction,
    orgId: string,
    purpose: string,
    sealed: SealedSecret,
  ): Promise<string> {
    const [row] = await tx
      .insert(schema.secrets)
      .values({ ...sealed, orgId, purpose })
      .returning({ id: schema.secrets.id });

    return row!.id;
  }

  /** What `DekService.openSecret` needs from the row, and nothing else. */
  async sealedSecret(
    tx: TenantTransaction,
    orgId: string,
    id: string,
  ): Promise<SealedSecretRow | undefined> {
    const [row] = await tx
      .select({ ciphertext: schema.secrets.ciphertext, dekId: schema.secrets.dekId })
      .from(schema.secrets)
      .where(and(eq(schema.secrets.orgId, orgId), eq(schema.secrets.id, id)));

    return row;
  }

  async deleteSecret(tx: TenantTransaction, orgId: string, id: string | null): Promise<void> {
    if (id === null) {
      return;
    }

    await tx
      .delete(schema.secrets)
      .where(and(eq(schema.secrets.orgId, orgId), eq(schema.secrets.id, id)));
  }
}
