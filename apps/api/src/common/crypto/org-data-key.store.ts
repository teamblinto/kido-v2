import { Injectable } from '@nestjs/common';
import { orgDataKeys } from '@repo/db';
import { and, eq, isNull } from 'drizzle-orm';

import type { TenantTransaction } from '../../database/database.types';

/** The injection token, beside the port, for the reason `clock.port.ts` gives. */
export const ORG_DATA_KEY_STORE = Symbol('forge.crypto.orgDataKeyStore');

/** One `org_data_keys` row, reduced to the columns the crypto module reasons about. */
export interface StoredOrgDataKey {
  readonly alg: string;
  readonly id: string;
  readonly kekId: string;
  readonly orgId: string;
  readonly wrappedDek: Buffer;
}

/** The same, before the database has assigned an id. */
export type OrgDataKeyDraft = Omit<StoredOrgDataKey, 'id'>;

/**
 * How the crypto module reaches `org_data_keys`, and the whole of what it may reach.
 *
 * The narrowness is a load-bearing part of §05's cost claim, not tidiness. "Rotating the KEK
 * rewraps DEKs only, an O(number of orgs) operation rather than O(number of secrets)" is a promise
 * about what rotation *cannot* do, and a port with no way to name `secrets` is a stronger statement
 * of it than any test: a rotation that wanted to touch a ciphertext would first have to widen this
 * interface, which is a reviewable change rather than a silent one.
 *
 * Every method takes the caller's {@link TenantTransaction} rather than opening its own, because
 * `app.org_id` is transaction-scoped: a query issued anywhere else is a query issued outside the
 * tenant, and RLS answers it with zero rows.
 */
export interface OrgDataKeyStore {
  /** The organisation's live key — the one row with no `rotated_at`. */
  currentForOrg(tx: TenantTransaction, orgId: string): Promise<StoredOrgDataKey | undefined>;

  /**
   * A specific key, live or retired. A secret names its key in `secrets.dek_id`, and after a data
   * key rotation that is deliberately not the current one.
   */
  forOrgAndId(
    tx: TenantTransaction,
    orgId: string,
    id: string,
  ): Promise<StoredOrgDataKey | undefined>;

  /** Insert the organisation's first key, or return the one a concurrent writer inserted first. */
  insertCurrent(tx: TenantTransaction, draft: OrgDataKeyDraft): Promise<StoredOrgDataKey>;

  /** Re-point a key at a new KEK. The wrapped bytes change; the data key inside them does not. */
  replaceWrapping(
    tx: TenantTransaction,
    id: string,
    kekId: string,
    wrappedDek: Buffer,
  ): Promise<void>;
}

const COLUMNS = {
  alg: orgDataKeys.alg,
  id: orgDataKeys.id,
  kekId: orgDataKeys.kekId,
  orgId: orgDataKeys.orgId,
  wrappedDek: orgDataKeys.wrappedDek,
};

@Injectable()
export class DrizzleOrgDataKeyStore implements OrgDataKeyStore {
  async currentForOrg(tx: TenantTransaction, orgId: string): Promise<StoredOrgDataKey | undefined> {
    const [row] = await tx
      .select(COLUMNS)
      .from(orgDataKeys)
      .where(and(eq(orgDataKeys.orgId, orgId), isNull(orgDataKeys.rotatedAt)))
      .limit(1);

    return row;
  }

  async forOrgAndId(
    tx: TenantTransaction,
    orgId: string,
    id: string,
  ): Promise<StoredOrgDataKey | undefined> {
    // `org_id` is in the predicate as well as `id` even though RLS already constrains the row: the
    // composite `(org_id, dek_id)` foreign key on `secrets` exists for the same reason, and a read
    // that relies on the policy alone is one policy change away from being a cross-tenant read.
    const [row] = await tx
      .select(COLUMNS)
      .from(orgDataKeys)
      .where(and(eq(orgDataKeys.orgId, orgId), eq(orgDataKeys.id, id)))
      .limit(1);

    return row;
  }

  /**
   * Insert-or-adopt, in one statement.
   *
   * Two first secret writes for one organisation can race. The partial unique index
   * `org_data_keys_org_id_current_key` lets exactly one insert land, and the loser must end up
   * holding the winner's key: a caller that fell back to the key it generated would seal a secret
   * under a key no row records, and that secret could never be read again.
   *
   * `do update` rather than `do nothing`, because only `do update` returns the conflicting row.
   * With `do nothing` the loser gets an empty result and has to read the winner back in a second
   * statement — which then needs an "and what if that read finds nothing" branch that no execution
   * can reach, guarding a case Postgres answers with a serialization error instead.
   *
   * The update is a deliberate no-op: the arbiter is a *partial* index over `rotated_at is null`,
   * so any row it matches already has `rotated_at` null and setting it to null changes nothing.
   * It re-states the invariant that makes the row the current one, and it never overwrites the
   * winner's wrapping with the loser's.
   *
   * Raising 23505 instead was not an option: a failed statement aborts the surrounding transaction,
   * and that transaction is the one writing the secret this key was generated for.
   */
  async insertCurrent(tx: TenantTransaction, draft: OrgDataKeyDraft): Promise<StoredOrgDataKey> {
    const rows = await tx
      .insert(orgDataKeys)
      .values(draft)
      .onConflictDoUpdate({
        set: { rotatedAt: null },
        target: orgDataKeys.orgId,
        // The index predicate. Without it Postgres cannot match a *partial* unique index and raises
        // 42P10 instead of taking the conflict path.
        targetWhere: isNull(orgDataKeys.rotatedAt),
      })
      .returning(COLUMNS);

    // Exactly one row, always: the statement either inserts or updates, and both return.
    return rows[0]!;
  }

  async replaceWrapping(
    tx: TenantTransaction,
    id: string,
    kekId: string,
    wrappedDek: Buffer,
  ): Promise<void> {
    await tx.update(orgDataKeys).set({ kekId, wrappedDek }).where(eq(orgDataKeys.id, id));
  }
}
