import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import {
  type DataEncryptionKey,
  type Plaintext,
  plaintext,
  revealDataEncryptionKey,
  revealPlaintext,
} from './branded';

/** What goes in `secrets.alg`, spelled the way §05 spells it. */
export const SECRET_ALG = 'AES-256-GCM';

/** What `node:crypto` calls the same thing. */
const CIPHER = 'aes-256-gcm';

/**
 * The format the first byte of every ciphertext declares.
 *
 * Stored rather than assumed because `secrets.ciphertext` outlives this file: when the layout
 * changes, rows written today still have to be readable, and a reader that has to guess whether the
 * first twelve bytes are an IV cannot be written safely. It is bound into the AAD as well, so
 * rewriting the byte to select an older, weaker reading is a forgery rather than a downgrade.
 */
export const ENVELOPE_VERSION = 1;

/** 96 bits, the size GCM is specified for — anything else forces an extra derivation step. */
export const IV_BYTES = 12;

/** The full 128-bit tag. Truncating it is a documented way to weaken GCM for no gain here. */
export const TAG_BYTES = 16;

const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

/** What the ciphertext is bound to. Both halves, per §05 — neither alone is enough. */
export interface SecretBinding {
  readonly orgId: string;
  readonly purpose: string;
}

/**
 * Every way an open can fail, reported identically.
 *
 * A wrong key, a relocated row, a re-labelled purpose and a flipped byte are one failure to GCM and
 * stay one failure here: distinguishing them would tell a caller which half of a guess was right.
 * The message is fixed and mentions no argument, because this error is logged and forwarded to an
 * error tracker, and §05 forbids either of those seeing secret material.
 */
export class SecretDecryptionError extends Error {
  constructor() {
    super('Refusing to decrypt: the ciphertext did not authenticate under the key and binding.');
    this.name = 'SecretDecryptionError';
  }
}

/**
 * The additional authenticated data: the version, the organisation and the purpose, length-prefixed.
 *
 * The prefix is the part that matters. `${orgId}:${purpose}` looks equivalent and is not — org `ab`
 * / purpose `cd` and org `a` / purpose `bcd` produce one string, so those two rows would share an
 * AAD and decrypt into each other, which is precisely the relocation the AAD exists to stop. A
 * length-prefixed encoding has exactly one reading, so distinct bindings are distinct bytes.
 */
function additionalData({ orgId, purpose }: SecretBinding): Buffer {
  const org = Buffer.from(orgId, 'utf8');
  const length = Buffer.alloc(4);

  length.writeUInt32BE(org.length);

  return Buffer.concat([Buffer.of(ENVELOPE_VERSION), length, org, Buffer.from(purpose, 'utf8')]);
}

/**
 * Seal secret material under an organisation's data key.
 *
 * The result is self-describing — `version ‖ iv ‖ tag ‖ body` — so `secrets.ciphertext` is the only
 * column an open needs. The IV is fresh per call: GCM's failure mode for a repeated IV under one key
 * is not a weakened ciphertext but a recoverable one, and a DEK is reused across every secret an
 * organisation owns.
 */
export function seal(dek: DataEncryptionKey, secret: Plaintext, binding: SecretBinding): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, revealDataEncryptionKey(dek), iv, {
    authTagLength: TAG_BYTES,
  });

  cipher.setAAD(additionalData(binding));

  const body = Buffer.concat([cipher.update(revealPlaintext(secret)), cipher.final()]);

  return Buffer.concat([Buffer.of(ENVELOPE_VERSION), iv, cipher.getAuthTag(), body]);
}

/**
 * Open a ciphertext, or refuse.
 *
 * `binding` is not read out of the ciphertext — it is supplied by the caller from the row being
 * read, which is what makes a row copied into another organisation, or re-labelled with another
 * purpose, fail here instead of succeeding quietly.
 */
export function open(
  dek: DataEncryptionKey,
  ciphertext: Buffer,
  binding: SecretBinding,
): Plaintext {
  // Checked before the header is sliced: `subarray` past the end answers with a short buffer rather
  // than an error, so a truncated row would otherwise reach GCM as a plausible-looking short IV.
  if (ciphertext.length < HEADER_BYTES || ciphertext[0] !== ENVELOPE_VERSION) {
    throw new SecretDecryptionError();
  }

  try {
    const decipher = createDecipheriv(
      CIPHER,
      revealDataEncryptionKey(dek),
      ciphertext.subarray(1, 1 + IV_BYTES),
      {
        authTagLength: TAG_BYTES,
      },
    );

    decipher.setAAD(additionalData(binding));
    decipher.setAuthTag(ciphertext.subarray(1 + IV_BYTES, HEADER_BYTES));

    return plaintext(
      Buffer.concat([decipher.update(ciphertext.subarray(HEADER_BYTES)), decipher.final()]),
    );
  } catch {
    // Deliberately swallowed. The OpenSSL message adds nothing a caller may act on and everything a
    // caller may leak.
    throw new SecretDecryptionError();
  }
}
