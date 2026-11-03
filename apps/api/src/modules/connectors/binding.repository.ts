import { Injectable } from '@nestjs/common';
import type { BindingProvider } from '@repo/contracts';
import { type ConnectorBinding, schema } from '@repo/db';
import { and, eq, getTableColumns } from 'drizzle-orm';

import type { TenantTransaction } from '../../database/database.types';

/** A `connector_bindings` row with who bound it, as the contract names them. */
export interface BindingRecord extends ConnectorBinding {
  readonly boundByName: string;
}

/**
 * The `connector_bindings` rows (spec 030 data-model § 3). One per project and provider
 * (`connector_bindings_org_id_project_id_provider_key`); every statement names `org_id` itself.
 * `config` is returned raw — `BindingService` parses it on every read.
 */
@Injectable()
export class BindingRepository {
  private query(tx: TenantTransaction) {
    return tx
      .select({ ...getTableColumns(schema.connectorBindings), boundByName: schema.users.email })
      .from(schema.connectorBindings)
      .innerJoin(schema.users, eq(schema.users.id, schema.connectorBindings.boundBy));
  }

  async listForProject(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
  ): Promise<BindingRecord[]> {
    return this.query(tx)
      .where(
        and(
          eq(schema.connectorBindings.orgId, orgId),
          eq(schema.connectorBindings.projectId, projectId),
        ),
      )
      .orderBy(schema.connectorBindings.provider);
  }

  async forProvider(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
    provider: BindingProvider,
  ): Promise<BindingRecord | undefined> {
    const [row] = await this.query(tx).where(
      and(
        eq(schema.connectorBindings.orgId, orgId),
        eq(schema.connectorBindings.projectId, projectId),
        eq(schema.connectorBindings.provider, provider),
      ),
    );

    return row;
  }

  async byId(tx: TenantTransaction, orgId: string, id: string): Promise<BindingRecord | undefined> {
    const [row] = await this.query(tx).where(
      and(eq(schema.connectorBindings.orgId, orgId), eq(schema.connectorBindings.id, id)),
    );

    return row;
  }

  /** Insert, or re-point the project's one binding of this provider (re-bind keeps the row). */
  async upsert(
    tx: TenantTransaction,
    draft: {
      readonly boundBy: string;
      readonly config: Record<string, unknown>;
      readonly connectionId: string;
      readonly orgId: string;
      readonly projectId: string;
      readonly provider: BindingProvider;
    },
  ): Promise<ConnectorBinding> {
    const [row] = await tx
      .insert(schema.connectorBindings)
      .values({ ...draft, state: 'bound' })
      .onConflictDoUpdate({
        set: {
          boundBy: draft.boundBy,
          config: draft.config,
          connectionId: draft.connectionId,
          state: 'bound',
          updatedAt: new Date(),
        },
        target: [
          schema.connectorBindings.orgId,
          schema.connectorBindings.projectId,
          schema.connectorBindings.provider,
        ],
      })
      .returning();

    return row!;
  }

  /** FR-018: the provider's resource is gone; the row stays for the user to re-bind or unbind. */
  async markDisconnected(tx: TenantTransaction, orgId: string, id: string): Promise<void> {
    await tx
      .update(schema.connectorBindings)
      .set({ state: 'disconnected', updatedAt: new Date() })
      .where(and(eq(schema.connectorBindings.orgId, orgId), eq(schema.connectorBindings.id, id)));
  }

  async delete(tx: TenantTransaction, orgId: string, id: string): Promise<void> {
    await tx
      .delete(schema.connectorBindings)
      .where(and(eq(schema.connectorBindings.orgId, orgId), eq(schema.connectorBindings.id, id)));
  }

  /** Every binding of the project, whatever its provider (the archive release, T075). */
  async idsForProject(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
  ): Promise<{ id: string; provider: BindingProvider }[]> {
    const rows = await tx
      .select({ id: schema.connectorBindings.id, provider: schema.connectorBindings.provider })
      .from(schema.connectorBindings)
      .where(
        and(
          eq(schema.connectorBindings.orgId, orgId),
          eq(schema.connectorBindings.projectId, projectId),
        ),
      );

    return rows as { id: string; provider: BindingProvider }[];
  }
}
