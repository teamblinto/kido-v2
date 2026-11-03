import { Injectable } from '@nestjs/common';
import { type ConnectorResource, type NewConnectorResource, schema } from '@repo/db';
import { and, eq, inArray } from 'drizzle-orm';

import type { TenantTransaction } from '../../database/database.types';
import { connectorRefusal } from './connectors.errors';
import { isUniqueViolation } from './sync.repository';

export type ResourceState = ConnectorResource['state'];

/**
 * Spec 030 data-model § 4: the moves a resource may make. `releasing → provisioning` is a Neon
 * reset (the same row, R9); `released` and `failed` are terminal and kept for the record.
 */
export const RESOURCE_TRANSITIONS: Readonly<Record<ResourceState, readonly ResourceState[]>> = {
  failed: [],
  live: ['releasing'],
  provisioning: ['live', 'failed'],
  released: [],
  releasing: ['released', 'failed', 'provisioning'],
};

/** Which states a move to `to` may come from — the inverse of {@link RESOURCE_TRANSITIONS}. */
function sourcesOf(to: ResourceState): ResourceState[] {
  return (Object.keys(RESOURCE_TRANSITIONS) as ResourceState[]).filter((from) =>
    RESOURCE_TRANSITIONS[from].includes(to),
  );
}

const LIVE: readonly ResourceState[] = ['provisioning', 'live', 'releasing'];

/**
 * The `connector_resources` rows (spec 030 R8): everything the platform created in a provider
 * account, with its sealed value by `secret_id`. One live resource per binding and kind, held by
 * the partial unique index and surfaced as `in-flight`.
 */
@Injectable()
export class ResourceRepository {
  /** Under a savepoint, so a second live resource answers `409 in-flight` and the tx survives. */
  async insert(
    tx: TenantTransaction,
    draft: Omit<NewConnectorResource, 'state'> & { readonly state?: 'provisioning' | 'live' },
  ): Promise<ConnectorResource> {
    try {
      return await tx.transaction(async (savepoint) => {
        const [row] = await savepoint
          .insert(schema.connectorResources)
          .values({ ...draft, state: draft.state ?? 'provisioning' })
          .returning();

        return row!;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw connectorRefusal('in-flight');
      }

      throw error;
    }
  }

  async byId(
    tx: TenantTransaction,
    orgId: string,
    id: string,
  ): Promise<ConnectorResource | undefined> {
    const [row] = await tx
      .select()
      .from(schema.connectorResources)
      .where(and(eq(schema.connectorResources.orgId, orgId), eq(schema.connectorResources.id, id)));

    return row;
  }

  /**
   * Moves the row to `to` only from a state data-model § 4 allows, setting `fields` with it; false
   * when the row was not in such a state (another worker moved it, or the move is not allowed).
   */
  async transition(
    tx: TenantTransaction,
    orgId: string,
    id: string,
    to: ResourceState,
    fields: Partial<
      Pick<ConnectorResource, 'externalId' | 'releasedAt' | 'scopeRef' | 'secretId'>
    > = {},
  ): Promise<boolean> {
    const from = sourcesOf(to);
    const rows = await tx
      .update(schema.connectorResources)
      .set({ ...fields, state: to, updatedAt: new Date() })
      .where(
        and(
          eq(schema.connectorResources.orgId, orgId),
          eq(schema.connectorResources.id, id),
          inArray(schema.connectorResources.state, from),
        ),
      )
      .returning({ id: schema.connectorResources.id });

    return rows.length > 0;
  }

  /** Records the provider's id or the sealed value on a resource without moving it. */
  async update(
    tx: TenantTransaction,
    orgId: string,
    id: string,
    fields: Partial<Pick<ConnectorResource, 'externalId' | 'scopeRef' | 'secretId'>>,
  ): Promise<void> {
    await tx
      .update(schema.connectorResources)
      .set({ ...fields, updatedAt: new Date() })
      .where(and(eq(schema.connectorResources.orgId, orgId), eq(schema.connectorResources.id, id)));
  }

  async listForBinding(
    tx: TenantTransaction,
    orgId: string,
    bindingId: string,
    options: { readonly liveOnly?: boolean } = {},
  ): Promise<ConnectorResource[]> {
    return tx
      .select()
      .from(schema.connectorResources)
      .where(
        and(
          eq(schema.connectorResources.orgId, orgId),
          eq(schema.connectorResources.bindingId, bindingId),
          options.liveOnly === true
            ? inArray(schema.connectorResources.state, [...LIVE])
            : undefined,
        ),
      )
      .orderBy(schema.connectorResources.createdAt);
  }

  async listForDomain(
    tx: TenantTransaction,
    orgId: string,
    domainId: string,
    options: { readonly liveOnly?: boolean } = {},
  ): Promise<ConnectorResource[]> {
    return tx
      .select()
      .from(schema.connectorResources)
      .where(
        and(
          eq(schema.connectorResources.orgId, orgId),
          eq(schema.connectorResources.domainId, domainId),
          options.liveOnly === true
            ? inArray(schema.connectorResources.state, [...LIVE])
            : undefined,
        ),
      )
      .orderBy(schema.connectorResources.createdAt);
  }

  /** Every live resource of the organisation, or of one connection (removal, the deleted-org sweep). */
  async listLive(
    tx: TenantTransaction,
    orgId: string,
    connectionId?: string,
  ): Promise<ConnectorResource[]> {
    return tx
      .select()
      .from(schema.connectorResources)
      .where(
        and(
          eq(schema.connectorResources.orgId, orgId),
          connectionId === undefined
            ? undefined
            : eq(schema.connectorResources.connectionId, connectionId),
          inArray(schema.connectorResources.state, [...LIVE]),
        ),
      )
      .orderBy(schema.connectorResources.createdAt);
  }
}
