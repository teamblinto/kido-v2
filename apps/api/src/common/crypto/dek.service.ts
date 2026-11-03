import { Inject, Injectable } from '@nestjs/common';

import type { TenantTransaction } from '../../database/database.types';
import {
  type DataEncryptionKey,
  type Plaintext,
  fingerprint,
  generateDataEncryptionKey,
} from './branded';
import { SECRET_ALG, open, seal } from './envelope';
import { KEK_PROVIDER, type KekProvider } from './kek-provider.port';
import {
  ORG_DATA_KEY_STORE,
  type OrgDataKeyStore,
  type StoredOrgDataKey,
} from './org-data-key.store';

/** An organisation's data key, unwrapped, with the id a `secrets` row records it by. */
export interface OrgDek {
  readonly dek: DataEncryptionKey;
  readonly dekId: string;
}

/** Everything a `secrets` row needs, and nothing a response may hold. */
export interface SealedSecret {
  readonly alg: string;
  readonly ciphertext: Buffer;
  readonly dekId: string;
  readonly fingerprint: string;
}

/** The part of a `secrets` row needed to read it back. */
export interface SealedSecretRow {
  readonly ciphertext: Buffer;
  readonly dekId: string;
}

/** What a KEK rotation did to one organisation. */
export interface RewrapOutcome {
  readonly dekId: string;
  readonly from: string;
  readonly rewrapped: boolean;
  readonly to: string;
}

export class MissingDataKeyError extends Error {
  constructor(orgId: string) {
    // The organisation id is not a secret — it is in the URL of every request — and naming it is
    // what makes this actionable. Nothing else about the key is said.
    super(`No data key is available for organisation ${orgId}.`);
    this.name = 'MissingDataKeyError';
  }
}

/**
 * The envelope, joined to the organisation whose key it uses.
 *
 * `envelope.ts` knows how to seal bytes under a key; this knows *which* key, where it came from and
 * when to make one. Together they are §05's arrangement: a per-organisation DEK, generated on first
 * secret write, held wrapped by the KEK, with the organisation and purpose bound as AAD.
 *
 * ## No cache, deliberately
 *
 * Every operation unwraps the DEK through the {@link KekProvider}, which under OpenBao is a network
 * call. A cache is an obvious next step and an obvious hazard — it holds plaintext data keys in
 * process memory, for every tenant, past the point where the request that needed them ended, and it
 * needs invalidating on rotation. Neither the spec nor §05 asks for one, so it is left to whoever
 * has a measurement that says it is needed (ADR 003).
 */
@Injectable()
export class DekService {
  constructor(
    @Inject(ORG_DATA_KEY_STORE) private readonly store: OrgDataKeyStore,
    @Inject(KEK_PROVIDER) private readonly kek: KekProvider,
  ) {}

  /** The organisation's data key. Refuses rather than creating one — see {@link ensureDek}. */
  async currentDek(tx: TenantTransaction, orgId: string): Promise<OrgDek> {
    const row = await this.store.currentForOrg(tx, orgId);

    if (row === undefined) {
      throw new MissingDataKeyError(orgId);
    }

    return this.unwrap(row);
  }

  /**
   * The organisation's data key, generated if this is the first secret it has ever written.
   *
   * The freshly generated key is deliberately not the one returned: whatever the store reports as
   * current is unwrapped and handed back instead. When two first writes race, one insert loses, and
   * a service that kept its own key would seal a secret under a key no row records — a secret that
   * can never be read again. Costing one extra unwrap on the first write of an organisation's life
   * is a cheap way not to have that failure mode.
   */
  async ensureDek(tx: TenantTransaction, orgId: string): Promise<OrgDek> {
    const existing = await this.store.currentForOrg(tx, orgId);

    if (existing !== undefined) {
      return this.unwrap(existing);
    }

    const wrapped = await this.kek.wrap(generateDataEncryptionKey(), { orgId });

    return this.unwrap(
      await this.store.insertCurrent(tx, {
        alg: SECRET_ALG,
        kekId: wrapped.kekId,
        orgId,
        wrappedDek: wrapped.ciphertext,
      }),
    );
  }

  /**
   * Read a secret back.
   *
   * `purpose` comes from the row being read, so a ciphertext re-labelled with another purpose — or
   * copied into another organisation — fails here rather than decrypting. The data key is resolved
   * from `secrets.dek_id` rather than assumed to be the current one, so a row written before a data
   * key rotation still opens.
   */
  async openSecret(
    tx: TenantTransaction,
    orgId: string,
    purpose: string,
    row: SealedSecretRow,
  ): Promise<Plaintext> {
    const stored = await this.store.forOrgAndId(tx, orgId, row.dekId);

    if (stored === undefined) {
      throw new MissingDataKeyError(orgId);
    }

    const { dek } = await this.unwrap(stored);

    return open(dek, row.ciphertext, { orgId, purpose });
  }

  /**
   * Move one organisation's data key onto the current KEK.
   *
   * This is the whole of a KEK rotation for one tenant: read one row, unwrap under the retiring
   * key, wrap under the incoming one, write one row. The data key inside is unchanged, so every
   * ciphertext that was readable before is readable after and not one `secrets` row is touched —
   * which is §05's "O(number of orgs) rather than O(number of secrets)" stated as code.
   *
   * `retiring` is passed in rather than discovered because a rotation is an operation with both
   * keys in hand: the incoming one is what this service was built with, and the outgoing one is
   * supplied by whoever is running the rotation. Enumerating organisations is not this method's
   * job — that is a cross-tenant read, and §09 permits exactly three of those.
   *
   * Idempotent. A rotation that failed halfway is re-run, and reaching an organisation already on
   * the current KEK is the normal case, not an error.
   */
  async rewrapDataKey(
    tx: TenantTransaction,
    orgId: string,
    retiring: KekProvider,
  ): Promise<RewrapOutcome> {
    const row = await this.store.currentForOrg(tx, orgId);

    if (row === undefined) {
      throw new MissingDataKeyError(orgId);
    }

    if (row.kekId === this.kek.kekId) {
      return { dekId: row.id, from: row.kekId, rewrapped: false, to: this.kek.kekId };
    }

    const dek = await retiring.unwrap(
      { ciphertext: row.wrappedDek, kekId: row.kekId },
      { orgId: row.orgId },
    );
    const wrapped = await this.kek.wrap(dek, { orgId: row.orgId });

    await this.store.replaceWrapping(tx, row.id, wrapped.kekId, wrapped.ciphertext);

    return { dekId: row.id, from: row.kekId, rewrapped: true, to: wrapped.kekId };
  }

  /**
   * Seal a secret, generating the organisation's data key if this is its first.
   *
   * The return value is shaped as the `secrets` row it becomes. `fingerprint` is computed here
   * rather than by the caller because it is the one derived value §05 lets back out of the API, and
   * a caller that computed its own would be a caller holding the plaintext for longer than this.
   */
  async sealSecret(
    tx: TenantTransaction,
    orgId: string,
    purpose: string,
    secret: Plaintext,
  ): Promise<SealedSecret> {
    const { dek, dekId } = await this.ensureDek(tx, orgId);

    return {
      alg: SECRET_ALG,
      ciphertext: seal(dek, secret, { orgId, purpose }),
      dekId,
      fingerprint: fingerprint(secret),
    };
  }

  private async unwrap(row: StoredOrgDataKey): Promise<OrgDek> {
    return {
      dek: await this.kek.unwrap(
        { ciphertext: row.wrappedDek, kekId: row.kekId },
        { orgId: row.orgId },
      ),
      dekId: row.id,
    };
  }
}
