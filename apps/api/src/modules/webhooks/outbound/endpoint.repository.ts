import { Injectable } from '@nestjs/common';
import { schema, type WebhookEndpoint } from '@repo/db';
import {
  and,
  arrayContains,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  sql,
} from 'drizzle-orm';

import { afterFailure, afterSuccess } from '../../../common/circuit/circuit';
import type { SealedSecret, SealedSecretRow } from '../../../common/crypto/dek.service';
import type { TenantTransaction } from '../../../database/database.types';

const { projects, secrets, webhookEndpointProjects, webhookEndpoints } = schema;

export type EndpointRow = WebhookEndpoint;

export interface EndpointDraft {
  readonly createdBy: string;
  readonly description: string;
  readonly eventTypes: readonly string[];
  readonly now: Date;
  readonly orgId: string;
  readonly secretId: string;
  readonly url: string;
}

export type EndpointPatch = Partial<
  Pick<
    EndpointRow,
    | 'circuitOpenUntil'
    | 'description'
    | 'eventTypes'
    | 'failingSince'
    | 'failureCount'
    | 'lastSuccessAt'
    | 'pausedAt'
    | 'previousSecretExpiresAt'
    | 'previousSecretId'
    | 'secretId'
    | 'state'
    | 'url'
  >
>;

/** What the fan-out needs of a matching endpoint. */
export interface MatchingEndpoint {
  readonly id: string;
  readonly state: EndpointRow['state'];
}

/**
 * `webhook_endpoints`, their project scope and their `secrets` rows (spec 029 data-model.md § 1).
 * Every statement runs on the caller's tenant transaction and names the org, so RLS and the
 * `where` agree.
 */
@Injectable()
export class EndpointRepository {
  async insert(tx: TenantTransaction, draft: EndpointDraft): Promise<EndpointRow> {
    const [row] = await tx
      .insert(webhookEndpoints)
      .values({
        createdAt: draft.now,
        createdBy: draft.createdBy,
        description: draft.description,
        eventTypes: [...draft.eventTypes],
        orgId: draft.orgId,
        secretId: draft.secretId,
        state: 'enabled',
        updatedAt: draft.now,
        url: draft.url,
      })
      .returning();

    return row!;
  }

  async byId(tx: TenantTransaction, orgId: string, id: string): Promise<EndpointRow | undefined> {
    const [row] = await tx
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.orgId, orgId), eq(webhookEndpoints.id, id)));

    return row;
  }

  /** Newest first; at most 20 exist, so there is no page. */
  list(tx: TenantTransaction, orgId: string): Promise<EndpointRow[]> {
    return tx
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.orgId, orgId))
      .orderBy(desc(webhookEndpoints.createdAt), desc(webhookEndpoints.id));
  }

  async update(
    tx: TenantTransaction,
    orgId: string,
    id: string,
    patch: EndpointPatch & { readonly now: Date },
  ): Promise<EndpointRow | undefined> {
    const { now, ...fields } = patch;
    const [row] = await tx
      .update(webhookEndpoints)
      .set({
        ...fields,
        ...(fields.eventTypes === undefined ? {} : { eventTypes: [...fields.eventTypes] }),
        updatedAt: now,
      })
      .where(and(eq(webhookEndpoints.orgId, orgId), eq(webhookEndpoints.id, id)))
      .returning();

    return row;
  }

  /**
   * One failed attempt (research R9), under a row lock so concurrent attempts count on the stored
   * value, as `connection.repository.ts` does. `failing_since` is set at the first failure after a
   * success; `circuit` says whether the failure counts toward the breaker (a retryable one).
   */
  async recordFailure(
    tx: TenantTransaction,
    orgId: string,
    id: string,
    now: Date,
    circuit: boolean,
  ): Promise<EndpointRow | undefined> {
    const row = await this.lockById(tx, orgId, id);
    if (row === undefined) return undefined;

    return this.update(tx, orgId, id, {
      ...(circuit ? afterFailure(row, now) : {}),
      failingSince: row.failingSince ?? now,
      now,
    });
  }

  /** A success closes the circuit, ends the failing streak and stamps `last_success_at`. */
  async recordSuccess(
    tx: TenantTransaction,
    orgId: string,
    id: string,
    now: Date,
  ): Promise<EndpointRow | undefined> {
    const row = await this.lockById(tx, orgId, id);
    if (row === undefined) return undefined;

    return this.update(tx, orgId, id, {
      ...afterSuccess(),
      failingSince: null,
      lastSuccessAt: now,
      now,
    });
  }

  /** `enabled` to `paused` (data-model § 1). Undefined when the endpoint was not enabled. */
  async pause(
    tx: TenantTransaction,
    orgId: string,
    id: string,
    now: Date,
  ): Promise<EndpointRow | undefined> {
    const [row] = await tx
      .update(webhookEndpoints)
      .set({ pausedAt: now, state: 'paused', updatedAt: now })
      .where(
        and(
          eq(webhookEndpoints.orgId, orgId),
          eq(webhookEndpoints.id, id),
          eq(webhookEndpoints.state, 'enabled'),
        ),
      )
      .returning();

    return row;
  }

  /**
   * `FOR KEY SHARE` on `ids`, in id order, to the end of `tx`; returns the ids still present. A
   * delete in flight is waited on, and its endpoint is then left out, so a writer inserting a child
   * row (a fan-out's send) never hits the foreign key of an endpoint deleted after it was read. The
   * order is the one `SendRepository.lockEndpointsOf` takes.
   */
  async lockPresent(
    tx: TenantTransaction,
    orgId: string,
    ids: readonly string[],
  ): Promise<string[]> {
    if (ids.length === 0) return [];

    const rows = await tx
      .select({ id: webhookEndpoints.id })
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.orgId, orgId), inArray(webhookEndpoints.id, [...ids])))
      .orderBy(asc(webhookEndpoints.id))
      .for('key share');

    return rows.map((row) => row.id);
  }

  /** The endpoint row, locked to the end of `tx`; undefined once it is deleted. */
  lock(tx: TenantTransaction, orgId: string, id: string): Promise<EndpointRow | undefined> {
    return this.lockById(tx, orgId, id);
  }

  private async lockById(
    tx: TenantTransaction,
    orgId: string,
    id: string,
  ): Promise<EndpointRow | undefined> {
    const [row] = await tx
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.orgId, orgId), eq(webhookEndpoints.id, id)))
      // `NO KEY UPDATE`, not `UPDATE`: nothing here changes the key, and the weaker lock lets the
      // attempt consumer's `KEY SHARE` (`SendRepository.lockEndpointsOf`) through while it still
      // serialises these writers and waits on a delete.
      .for('no key update');

    return row;
  }

  /**
   * Hard delete (data-model.md § 1): the row, and with it by cascade its scope, sends and
   * attempts; then its `secrets` rows, which the endpoint referenced and nothing else does.
   */
  async delete(tx: TenantTransaction, orgId: string, id: string): Promise<EndpointRow | undefined> {
    const [row] = await tx
      .delete(webhookEndpoints)
      .where(and(eq(webhookEndpoints.orgId, orgId), eq(webhookEndpoints.id, id)))
      .returning();

    if (row === undefined) return undefined;

    const secretIds = [row.secretId, row.previousSecretId].filter(
      (secretId): secretId is string => secretId !== null,
    );
    await tx.delete(secrets).where(and(eq(secrets.orgId, orgId), inArray(secrets.id, secretIds)));

    return row;
  }

  /** Deletes `secrets` rows of the org that no endpoint references any more. */
  async deleteSecrets(
    tx: TenantTransaction,
    orgId: string,
    secretIds: readonly string[],
  ): Promise<void> {
    if (secretIds.length === 0) return;
    await tx
      .delete(secrets)
      .where(and(eq(secrets.orgId, orgId), inArray(secrets.id, [...secretIds])));
  }

  /**
   * Ends every rotation overlap of the org that has expired at `now` (research R12): `previous_*`
   * cleared, then the previous `secrets` rows deleted. Returns how many were cleared.
   */
  async clearExpiredPrevious(tx: TenantTransaction, orgId: string, now: Date): Promise<number> {
    const cleared = await tx
      .select({ previousSecretId: webhookEndpoints.previousSecretId })
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.orgId, orgId),
          isNotNull(webhookEndpoints.previousSecretId),
          lte(webhookEndpoints.previousSecretExpiresAt, now),
        ),
      )
      .for('update');
    const secretIds = cleared.flatMap((row) =>
      row.previousSecretId === null ? [] : [row.previousSecretId],
    );
    if (secretIds.length === 0) return 0;

    await tx
      .update(webhookEndpoints)
      .set({ previousSecretExpiresAt: null, previousSecretId: null })
      .where(
        and(
          eq(webhookEndpoints.orgId, orgId),
          inArray(webhookEndpoints.previousSecretId, secretIds),
        ),
      );
    await this.deleteSecrets(tx, orgId, secretIds);
    return secretIds.length;
  }

  /** Replaces the endpoint's project scope. `[]` means every project (FR-002). */
  async setScope(
    tx: TenantTransaction,
    orgId: string,
    endpointId: string,
    projectIds: readonly string[],
  ): Promise<void> {
    await tx
      .delete(webhookEndpointProjects)
      .where(
        and(
          eq(webhookEndpointProjects.orgId, orgId),
          eq(webhookEndpointProjects.endpointId, endpointId),
        ),
      );

    if (projectIds.length === 0) return;

    await tx
      .insert(webhookEndpointProjects)
      .values([...new Set(projectIds)].map((projectId) => ({ endpointId, orgId, projectId })));
  }

  /** Each endpoint's scope, sorted; an endpoint with none maps to `[]`. */
  async scopes(
    tx: TenantTransaction,
    orgId: string,
    endpointIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    const scopes = new Map<string, string[]>(endpointIds.map((id) => [id, []]));

    if (endpointIds.length === 0) return scopes;

    const rows = await tx
      .select({
        endpointId: webhookEndpointProjects.endpointId,
        projectId: webhookEndpointProjects.projectId,
      })
      .from(webhookEndpointProjects)
      .where(
        and(
          eq(webhookEndpointProjects.orgId, orgId),
          inArray(webhookEndpointProjects.endpointId, [...endpointIds]),
        ),
      )
      .orderBy(asc(webhookEndpointProjects.projectId));

    for (const row of rows) scopes.get(row.endpointId)?.push(row.projectId);

    return scopes;
  }

  /**
   * The org's endpoint count, under the org's endpoint lock (028's limit pattern): held to the
   * end of `tx`, so a second create in the org waits here and then counts the first one's row.
   */
  async countForOrg(tx: TenantTransaction, orgId: string): Promise<number> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('webhook-endpoints:' || ${orgId}::text))`,
    );

    const [row] = await tx
      .select({ total: count() })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.orgId, orgId));

    return row!.total;
  }

  /** Which of `projectIds` are live (not archived) projects of this org. */
  async liveProjects(
    tx: TenantTransaction,
    orgId: string,
    projectIds: readonly string[],
  ): Promise<Set<string>> {
    if (projectIds.length === 0) return new Set();

    const rows = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.orgId, orgId),
          inArray(projects.id, [...projectIds]),
          isNull(projects.deletedAt),
        ),
      );

    return new Set(rows.map((row) => row.id));
  }

  /**
   * The org's endpoints subscribed to `publicType` whose scope admits `projectId`: an empty scope
   * admits every project, and an event with no project (`member.joined`) reaches every subscribed
   * endpoint, whatever its scope. Every state is returned; the fan-out decides what a non-enabled
   * one gets.
   */
  matching(
    tx: TenantTransaction,
    orgId: string,
    publicType: string,
    projectId: string | null,
  ): Promise<MatchingEndpoint[]> {
    const inScope =
      projectId === null
        ? undefined
        : sql`(
            not exists (
              select 1 from ${webhookEndpointProjects} scope
              where scope.endpoint_id = ${webhookEndpoints.id}
            )
            or exists (
              select 1 from ${webhookEndpointProjects} scope
              where scope.endpoint_id = ${webhookEndpoints.id} and scope.project_id = ${projectId}
            )
          )`;

    return tx
      .select({ id: webhookEndpoints.id, state: webhookEndpoints.state })
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.orgId, orgId),
          arrayContains(webhookEndpoints.eventTypes, [publicType]),
          inScope,
        ),
      )
      .orderBy(asc(webhookEndpoints.id));
  }

  /** The row `DekService.sealSecret` shaped, written under the tenant. */
  async insertSecret(
    tx: TenantTransaction,
    orgId: string,
    purpose: string,
    sealed: SealedSecret,
  ): Promise<string> {
    const [row] = await tx
      .insert(secrets)
      .values({ ...sealed, orgId, purpose })
      .returning({ id: secrets.id });

    return row!.id;
  }

  /** What `DekService.openSecret` needs from the row, and nothing else. */
  async sealedSecret(
    tx: TenantTransaction,
    orgId: string,
    id: string,
  ): Promise<SealedSecretRow | undefined> {
    const [row] = await tx
      .select({ ciphertext: secrets.ciphertext, dekId: secrets.dekId })
      .from(secrets)
      .where(and(eq(secrets.orgId, orgId), eq(secrets.id, id)));

    return row;
  }
}
