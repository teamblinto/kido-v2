import { Injectable } from '@nestjs/common';
import type { ProviderKey as ProviderKeyContract } from '@repo/contracts';
import { type NewProviderKey, type ProviderKey, schema } from '@repo/db';
import { and, eq, getTableColumns } from 'drizzle-orm';

import type { SealedSecretRow } from '../../../common/crypto/dek.service';
import type { TenantTransaction } from '../../../database/database.types';
import type { LlmProviderName } from '../llm-provider.port';

/** A `provider_keys` row with the two derived columns the contract needs: who, and the fingerprint. */
export interface ProviderKeyRecord extends ProviderKey {
  readonly addedByName: string | null;
  readonly fingerprint: string;
}

/** The wire shape: the two §05 derivatives and nothing else of the key. */
export function toContract(record: ProviderKeyRecord): ProviderKeyContract {
  return {
    addedAt: record.createdAt.toISOString(),
    addedBy:
      record.addedBy !== null && record.addedByName !== null
        ? { id: record.addedBy, name: record.addedByName }
        : null,
    fingerprint: record.fingerprint,
    health: record.health,
    id: record.id,
    lastFour: record.lastFour,
    // The verify that precedes the seal sets it at store; the add moment is the only other truth.
    lastVerifiedAt: (record.lastVerifiedAt ?? record.createdAt).toISOString(),
    provider: record.provider,
  };
}

/**
 * The `provider_keys` rows and their `secrets` rows, on the connectors idiom (spec 020, research
 * R9): every statement runs on the tenant transaction and names `org_id` itself, so RLS and the
 * composite keys are two independent refusals.
 */
@Injectable()
export class ProviderKeyRepository {
  private query(tx: TenantTransaction) {
    return tx
      .select({
        ...getTableColumns(schema.providerKeys),
        addedByName: schema.users.email,
        fingerprint: schema.secrets.fingerprint,
      })
      .from(schema.providerKeys)
      .innerJoin(
        schema.secrets,
        and(
          eq(schema.secrets.orgId, schema.providerKeys.orgId),
          eq(schema.secrets.id, schema.providerKeys.secretId),
        ),
      )
      .leftJoin(schema.users, eq(schema.users.id, schema.providerKeys.addedBy));
  }

  async forOrg(tx: TenantTransaction, orgId: string): Promise<ProviderKeyRecord[]> {
    return this.query(tx)
      .where(eq(schema.providerKeys.orgId, orgId))
      .orderBy(schema.providerKeys.provider);
  }

  async byProvider(
    tx: TenantTransaction,
    orgId: string,
    provider: LlmProviderName,
  ): Promise<ProviderKeyRecord | undefined> {
    const [row] = await this.query(tx).where(
      and(eq(schema.providerKeys.orgId, orgId), eq(schema.providerKeys.provider, provider)),
    );

    return row;
  }

  /** The row lock a replace, a run-time rejection and a check serialise on. */
  async lockByProvider(
    tx: TenantTransaction,
    orgId: string,
    provider: LlmProviderName,
  ): Promise<ProviderKey | undefined> {
    const [row] = await tx
      .select()
      .from(schema.providerKeys)
      .where(and(eq(schema.providerKeys.orgId, orgId), eq(schema.providerKeys.provider, provider)))
      .for('update');

    return row;
  }

  async insert(tx: TenantTransaction, draft: NewProviderKey): Promise<ProviderKey> {
    const [row] = await tx.insert(schema.providerKeys).values(draft).returning();

    return row!;
  }

  async delete(tx: TenantTransaction, orgId: string, id: string): Promise<void> {
    await tx
      .delete(schema.providerKeys)
      .where(and(eq(schema.providerKeys.orgId, orgId), eq(schema.providerKeys.id, id)));
  }

  async setHealth(
    tx: TenantTransaction,
    orgId: string,
    id: string,
    health: ProviderKey['health'],
    at: Date,
  ): Promise<void> {
    await tx
      .update(schema.providerKeys)
      .set({ health, updatedAt: at })
      .where(and(eq(schema.providerKeys.orgId, orgId), eq(schema.providerKeys.id, id)));
  }

  async setVerified(tx: TenantTransaction, orgId: string, id: string, at: Date): Promise<void> {
    await tx
      .update(schema.providerKeys)
      .set({ lastVerifiedAt: at, updatedAt: at })
      .where(and(eq(schema.providerKeys.orgId, orgId), eq(schema.providerKeys.id, id)));
  }

  /** What `DekService.openSecret` needs from the row, and nothing else. */
  async sealedSecret(
    tx: TenantTransaction,
    orgId: string,
    secretId: string,
  ): Promise<SealedSecretRow | undefined> {
    const [row] = await tx
      .select({ ciphertext: schema.secrets.ciphertext, dekId: schema.secrets.dekId })
      .from(schema.secrets)
      .where(and(eq(schema.secrets.orgId, orgId), eq(schema.secrets.id, secretId)));

    return row;
  }

  async deleteSecret(tx: TenantTransaction, orgId: string, secretId: string): Promise<void> {
    await tx
      .delete(schema.secrets)
      .where(and(eq(schema.secrets.orgId, orgId), eq(schema.secrets.id, secretId)));
  }
}
