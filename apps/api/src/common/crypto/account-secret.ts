import { Inject, Injectable } from '@nestjs/common';

import { type Plaintext, generateDataEncryptionKey } from './branded';
import { SecretDecryptionError, open, seal } from './envelope';
import { KEK_PROVIDER, type KekProvider } from './kek-provider.port';

/**
 * The layout `users.mfa_secret_enc` declares in its first byte, for the reason `envelope.ts`
 * versions its own: the column outlives this file, and a reader that has to guess where the wrap
 * ends cannot be written safely.
 */
const ACCOUNT_ENVELOPE_VERSION = 1;

/** Two length prefixes, each a big-endian `uint16`, plus the version byte. */
const LENGTH_BYTES = 2;
const HEADER_BYTES = 1 + LENGTH_BYTES;

/**
 * The AAD namespace an account's secrets live in.
 *
 * {@link SecretBinding} calls its subject `orgId` because §05 specifies the binding as organisation
 * and purpose, and every tenant secret is bound that way. An account secret has no organisation —
 * `users` is a root, and a person may belong to none or to six (ADR 015) — so the subject is the
 * person, prefixed. Both ids are uuids, and without the prefix a `secrets` row and an
 * `mfa_secret_enc` value could share a binding whenever the two tables happened to mint the same
 * uuid, which is exactly the interchangeability the AAD exists to prevent.
 */
export function accountRealm(userId: string): string {
  return `user:${userId}`;
}

/** What an account secret is bound to: the person it belongs to, and what it is for. */
export interface AccountSecretBinding {
  readonly purpose: string;
  readonly userId: string;
}

/**
 * Envelope encryption for a secret that belongs to a *person* rather than to a tenant — the TOTP
 * seed on `users.mfa_secret_enc` (§05, §11, criterion 8).
 *
 * ## Why this exists beside `DekService`
 *
 * `DekService` is the tenant arrangement: one long-lived DEK per organisation, held wrapped in
 * `org_data_keys`, referenced by `secrets.dek_id`, and rotatable in one statement per tenant. None
 * of that is reachable here. ADR 015 makes `users` a root with no `org_id`, `org_data_keys.org_id`
 * is a foreign key to `orgs`, and the flows that read an MFA seed — the login challenge above all —
 * run *before* there is a tenant context to set. Routing an account secret through a tenant DEK
 * would mean inventing an organisation for a user who may belong to none.
 *
 * So the data key is per secret and travels with it, wrapped, in the one column T05 gave this seed:
 *
 * ```text
 * version(1) ‖ kekIdLen(2) ‖ kekId ‖ wrappedDekLen(2) ‖ wrappedDek ‖ sealedSecret
 * ```
 *
 * Both halves are `envelope.ts` — this file adds no cipher, no KDF and no mode. It composes the
 * wrap the {@link KekProvider} already performs with the seal `DekService` already performs, and
 * the only new thing is where the two are written down. The `kekId` travels for the reason
 * `org_data_keys.kek_id` exists: a process holding a rotated master key must be able to tell "not
 * re-wrapped yet" from "corrupt".
 *
 * ## Consequence worth stating
 *
 * A KEK rotation reaches organisations through `org_data_keys`; it does not reach these. Re-wrapping
 * account secrets is a walk over `users`, which nothing in spec 001 asks for and no task owns yet.
 * Until it exists, rotating the master key makes every enrolled seed unreadable — reported as
 * {@link UnknownKekError}, which is the distinguishable failure that makes that diagnosable rather
 * than mysterious.
 */
@Injectable()
export class AccountSecretService {
  constructor(@Inject(KEK_PROVIDER) private readonly kek: KekProvider) {}

  /**
   * Seal secret material for one account.
   *
   * A fresh data key per call rather than one per user. There is no `users` column to hold a
   * long-lived one, and generating one costs 32 bytes of CSPRNG — while reusing a key across an
   * account's secrets would be reusing it across the purposes the AAD is meant to keep separate.
   */
  async seal(binding: AccountSecretBinding, secret: Plaintext): Promise<Buffer> {
    const realm = accountRealm(binding.userId);
    const dek = generateDataEncryptionKey();
    const wrapped = await this.kek.wrap(dek, { orgId: realm });
    const kekId = Buffer.from(wrapped.kekId, 'utf8');

    return Buffer.concat([
      Buffer.of(ACCOUNT_ENVELOPE_VERSION),
      lengthPrefix(kekId.length),
      kekId,
      lengthPrefix(wrapped.ciphertext.length),
      wrapped.ciphertext,
      seal(dek, secret, { orgId: realm, purpose: binding.purpose }),
    ]);
  }

  /**
   * Open one, or refuse.
   *
   * `binding` is supplied by the caller from the row being read and is never taken from the bytes,
   * which is what makes a value copied onto another user's row — or read back under another
   * purpose — fail here instead of succeeding quietly.
   */
  async open(binding: AccountSecretBinding, sealed: Buffer): Promise<Plaintext> {
    const realm = accountRealm(binding.userId);
    const { body, kekId, wrappedDek } = unpack(sealed);

    return open(await this.kek.unwrap({ ciphertext: wrappedDek, kekId }, { orgId: realm }), body, {
      orgId: realm,
      purpose: binding.purpose,
    });
  }
}

function lengthPrefix(value: number): Buffer {
  const prefix = Buffer.alloc(LENGTH_BYTES);

  prefix.writeUInt16BE(value);

  return prefix;
}

/**
 * Split the column into its three parts, refusing anything that does not describe itself
 * consistently.
 *
 * Every bound is checked before it is used. `subarray` past the end of a Buffer answers with a
 * short one rather than throwing, so a truncated column would otherwise reach the KEK as a
 * plausible-looking short wrap and the failure would surface as "your master key is wrong".
 */
function unpack(sealed: Buffer): { body: Buffer; kekId: string; wrappedDek: Buffer } {
  if (sealed.length < HEADER_BYTES || sealed[0] !== ACCOUNT_ENVELOPE_VERSION) {
    throw new SecretDecryptionError();
  }

  const kekIdAt = HEADER_BYTES;
  const kekIdLength = sealed.readUInt16BE(1);
  const wrappedLengthAt = kekIdAt + kekIdLength;

  if (wrappedLengthAt + LENGTH_BYTES > sealed.length) {
    throw new SecretDecryptionError();
  }

  const wrappedAt = wrappedLengthAt + LENGTH_BYTES;
  const wrappedLength = sealed.readUInt16BE(wrappedLengthAt);
  const bodyAt = wrappedAt + wrappedLength;

  // Strictly greater: a zero-length body is refused by `envelope.open`'s own header check, and this
  // one is only about the slices lining up.
  if (bodyAt > sealed.length) {
    throw new SecretDecryptionError();
  }

  return {
    body: sealed.subarray(bodyAt),
    kekId: sealed.subarray(kekIdAt, wrappedLengthAt).toString('utf8'),
    wrappedDek: sealed.subarray(wrappedAt, bodyAt),
  };
}
