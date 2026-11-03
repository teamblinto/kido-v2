import { createHash, randomBytes } from 'node:crypto';

/**
 * The two phantom keys that make a secret type nominal. Declared, never defined: they exist only in
 * the type system, so no runtime value ever carries them and no code can produce one by hand.
 */
declare const BRAND: unique symbol;
declare const CARRIER: unique symbol;

/**
 * An opaque handle to secret material.
 *
 * §05 requires that DEKs, plaintexts and seeds "never reach a `toJSON`", and spec 001 sketches that
 * as `string & { readonly __brand: 'X' }`. That shape is weaker than the sentence it illustrates: an
 * intersection with `string` stays assignable *to* `string`, so it blocks accidental construction
 * while still slipping onto any DTO field, log argument or template literal that takes one — which
 * is the direction the leak actually travels. ADR 003 records the divergence.
 *
 * So the carrier is phantom rather than intersected. The value really is a `Buffer` or a `string` at
 * runtime, but the type shares no members with either, which makes `const key: string = seed` a
 * compile error and leaves `reveal*` as the only way back to something printable. Those calls are
 * few, greppable, and the place a reviewer looks.
 */
interface Opaque<Name extends string, Carrier> {
  readonly [BRAND]: Name;
  readonly [CARRIER]: Carrier;
}

/** A per-organisation data-encryption key. Lives in memory unwrapped, never on disk and never in a log. */
export type DataEncryptionKey = Opaque<'DataEncryptionKey', Buffer>;

/** Secret material on its way into, or just out of, the envelope: a provider key, a credential set. */
export type Plaintext = Opaque<'Plaintext', Buffer>;

/** A TOTP shared secret. Separate from {@link Plaintext} so neither can stand in for the other. */
export type SecretSeed = Opaque<'SecretSeed', string>;

/** AES-256 takes a 256-bit key, and §05 names AES-256-GCM specifically. */
export const DEK_BYTES = 32;

/**
 * Below this, four characters is too large a fraction of the secret to hand back. §05 allows the
 * tail as a recognition aid for a long provider key — `sk-ant-…-efgh` — not as a way to publish a
 * short secret a quarter at a time.
 */
const MIN_LENGTH_FOR_A_TAIL = 8;

/** 128 bits of SHA-256. Enough to identify a key across rows, far too little to walk backwards. */
const FINGERPRINT_HEX_CHARS = 32;

export class InvalidDataEncryptionKeyError extends Error {
  constructor(received: number) {
    // The length, never the bytes: this message reaches a log and an error tracker.
    super(`A data-encryption key must be exactly ${DEK_BYTES} bytes; received ${received}.`);
    this.name = 'InvalidDataEncryptionKeyError';
  }
}

/** The runtime value behind an opaque handle, as bytes, for the four functions allowed to look. */
function materialOf(secret: DataEncryptionKey | Plaintext | SecretSeed): Buffer {
  const raw = secret as unknown as Buffer | string;

  return typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw;
}

/**
 * Wrap secret material for sealing.
 *
 * The bytes are copied rather than adopted, so a caller that reuses or zeroes its own buffer — the
 * correct thing for a caller to do with a secret — cannot change what is about to be encrypted.
 */
export function plaintext(value: Buffer | string): Plaintext {
  return Buffer.from(value) as unknown as Plaintext;
}

export function secretSeed(value: string): SecretSeed {
  return value as unknown as SecretSeed;
}

/** Adopt 32 bytes as a DEK. Copies, for the reason {@link plaintext} copies. */
export function dataEncryptionKey(bytes: Buffer): DataEncryptionKey {
  if (bytes.length !== DEK_BYTES) {
    throw new InvalidDataEncryptionKeyError(bytes.length);
  }

  return Buffer.from(bytes) as unknown as DataEncryptionKey;
}

/** A fresh DEK from the CSPRNG. The only place a data key is born. */
export function generateDataEncryptionKey(): DataEncryptionKey {
  return dataEncryptionKey(randomBytes(DEK_BYTES));
}

/**
 * One of the two values §05 lets back out of the API, and the one stored on `secrets.fingerprint`.
 *
 * A digest rather than a random id, so the same credential registered twice is recognisably the
 * same without either copy being decrypted. Namespaced with the algorithm because the column keeps
 * these forever and a bare hex string is undatable.
 */
export function fingerprint(secret: Plaintext | SecretSeed): string {
  return `sha256:${createHash('sha256').update(materialOf(secret)).digest('hex').slice(0, FINGERPRINT_HEX_CHARS)}`;
}

/** The other returnable value: the tail, so a user can tell two of their own keys apart. */
export function lastFour(secret: Plaintext | SecretSeed): string {
  const text = materialOf(secret).toString('utf8');

  return text.length < MIN_LENGTH_FOR_A_TAIL ? '' : text.slice(-4);
}

/**
 * The audited escape hatches.
 *
 * Everything above this line moves secrets around without ever producing a `string` or a `Buffer` a
 * DTO could hold. These four produce exactly that, so every use is a deliberate one a reviewer can
 * find with a single grep — which is the whole reason the carrier is phantom.
 */
export function revealPlaintext(secret: Plaintext): Buffer {
  return Buffer.from(materialOf(secret));
}

export function revealSecretSeed(secret: SecretSeed): string {
  return secret as unknown as string;
}

export function revealDataEncryptionKey(dek: DataEncryptionKey): Buffer {
  return Buffer.from(materialOf(dek));
}
