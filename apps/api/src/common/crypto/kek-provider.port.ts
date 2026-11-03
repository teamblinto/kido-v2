import type { DataEncryptionKey } from './branded';

/**
 * The injection token, beside the interface for the reason `clock.port.ts` gives. A symbol, because
 * a string token collides silently with any other package that reaches for the same word.
 */
export const KEK_PROVIDER = Symbol('forge.crypto.kekProvider');

/**
 * The reserved purpose the KEK layer binds its wraps to.
 *
 * Wrapping a DEK is the same AEAD operation as sealing a secret, so it reuses `envelope.ts` rather
 * than growing a second implementation of AES-256-GCM to audit. Giving it a purpose no secret may
 * claim keeps the two layers' ciphertexts from ever being interchangeable.
 */
export const KEK_WRAP_PURPOSE = 'forge.org_data_key';

/**
 * A wrapped data key exactly as `org_data_keys` stores it.
 *
 * `kekId` travels with the bytes rather than being inferred at read time. Without it, a process
 * holding the new KEK could not tell "wrapped under the retired key, rotation has not reached this
 * row" from "corrupt", and a rotation would have to guess which key to try.
 */
export interface WrappedDek {
  readonly ciphertext: Buffer;
  readonly kekId: string;
}

/** What a wrap is bound to. The organisation, so a `wrapped_dek` moved between rows fails. */
export interface KekBinding {
  readonly orgId: string;
}

/**
 * The port §05 and ADR 003 require: the master key lives behind this and nowhere else.
 *
 * Asynchronous because the shipping implementation that matters — OpenBao — is a network call.
 * Making the local adapter pretend otherwise would let a synchronous call site compile today and
 * break on the deployment that actually needs the vault.
 */
export interface KekProvider {
  /** The id new wraps are stamped with, and the one written to `org_data_keys.kek_id`. */
  readonly kekId: string;

  unwrap(wrapped: WrappedDek, binding: KekBinding): Promise<DataEncryptionKey>;
  wrap(dek: DataEncryptionKey, binding: KekBinding): Promise<WrappedDek>;
}

/**
 * Every way an unwrap can fail against a KEK this process *does* hold, reported identically — a
 * wrong master key, a relocated row and a flipped byte are one failure, for the reason
 * `SecretDecryptionError` gives.
 */
export class KekUnwrapError extends Error {
  constructor(
    message = 'Refusing to unwrap: the wrapped data key did not authenticate under this KEK.',
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * The one failure worth telling apart: the row was wrapped under a key this process does not have.
 *
 * That is an operational fact — a rotation that has not finished, or a misconfigured deployment —
 * and the fix differs from every other unwrap failure. It is safe to distinguish because a KEK id
 * is a public identifier already stored in the clear, so the extra information is one an attacker
 * could read off the row anyway.
 */
export class UnknownKekError extends KekUnwrapError {
  readonly kekId: string;

  constructor(kekId: string) {
    super(
      `No key-encryption key with id ${JSON.stringify(kekId)} is configured, so the wrap it produced cannot be opened here.`,
    );
    this.kekId = kekId;
  }
}
