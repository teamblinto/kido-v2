import { describe, expect, it } from 'vitest';

import {
  DEK_BYTES,
  type DataEncryptionKey,
  InvalidDataEncryptionKeyError,
  type Plaintext,
  type SecretSeed,
  dataEncryptionKey,
  fingerprint,
  generateDataEncryptionKey,
  lastFour,
  plaintext,
  revealDataEncryptionKey,
  revealPlaintext,
  revealSecretSeed,
  secretSeed,
} from './branded';

describe('plaintext', () => {
  it('carries utf-8 text through unchanged', () => {
    expect(revealPlaintext(plaintext('sk-ant-api03-abcdefgh')).toString('utf8')).toBe(
      'sk-ant-api03-abcdefgh',
    );
  });

  it('carries raw bytes through unchanged', () => {
    const bytes = Buffer.from([0x00, 0xff, 0x7f, 0x80]);

    expect(revealPlaintext(plaintext(bytes)).equals(bytes)).toBe(true);
  });

  /**
   * A caller that mutates the buffer it handed in must not be able to change what was sealed, and a
   * caller that mutates what it gets back must not corrupt the value still held by the module.
   */
  it('copies on the way in and on the way out, so no caller shares its bytes', () => {
    const source = Buffer.from('secret');
    const wrapped = plaintext(source);

    source.fill(0);
    const revealed = revealPlaintext(wrapped);
    revealed.fill(0);

    expect(revealPlaintext(wrapped).toString('utf8')).toBe('secret');
  });
});

describe('secretSeed', () => {
  it('carries the seed through unchanged', () => {
    expect(revealSecretSeed(secretSeed('JBSWY3DPEHPK3PXP'))).toBe('JBSWY3DPEHPK3PXP');
  });
});

describe('dataEncryptionKey', () => {
  it('accepts exactly 32 bytes', () => {
    const bytes = Buffer.alloc(DEK_BYTES, 7);

    expect(revealDataEncryptionKey(dataEncryptionKey(bytes)).equals(bytes)).toBe(true);
  });

  it.each([0, 16, 31, 33, 64])('refuses a %i-byte key', (size) => {
    expect(() => dataEncryptionKey(Buffer.alloc(size))).toThrow(InvalidDataEncryptionKeyError);
  });

  /** A refusal is logged and reported; the bytes that caused it must not travel with it. */
  it('refuses without putting the rejected bytes in the message', () => {
    const rejected = Buffer.from('0123456789abcdef', 'utf8');

    expect(() => dataEncryptionKey(rejected)).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('0123456789abcdef') as string,
      }),
    );
  });

  it('copies, so the caller cannot zero the key it just handed over', () => {
    const bytes = Buffer.alloc(DEK_BYTES, 7);
    const dek = dataEncryptionKey(bytes);

    bytes.fill(0);

    expect(revealDataEncryptionKey(dek).equals(Buffer.alloc(DEK_BYTES, 7))).toBe(true);
  });
});

describe('generateDataEncryptionKey', () => {
  it('produces a 32-byte key', () => {
    expect(revealDataEncryptionKey(generateDataEncryptionKey())).toHaveLength(DEK_BYTES);
  });

  it('produces a different key every call', () => {
    const keys = Array.from({ length: 32 }, () =>
      revealDataEncryptionKey(generateDataEncryptionKey()).toString('hex'),
    );

    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('fingerprint', () => {
  it('is stable for the same material', () => {
    expect(fingerprint(plaintext('sk-ant-api03-abcdefgh'))).toBe(
      fingerprint(plaintext('sk-ant-api03-abcdefgh')),
    );
  });

  it('differs for different material', () => {
    expect(fingerprint(plaintext('one-secret-value'))).not.toBe(
      fingerprint(plaintext('two-secret-value')),
    );
  });

  it('agrees between a seed and the same text as a plaintext', () => {
    expect(fingerprint(secretSeed('JBSWY3DPEHPK3PXP'))).toBe(
      fingerprint(plaintext('JBSWY3DPEHPK3PXP')),
    );
  });

  /** It is stored on `secrets.fingerprint` and returned by the API, so it must not be reversible. */
  it('contains none of the material it fingerprints', () => {
    const material = 'sk-ant-api03-abcdefgh';

    expect(fingerprint(plaintext(material))).not.toContain(material);
    expect(fingerprint(plaintext(material))).not.toContain('abcdefgh');
  });

  it('is a namespaced hex digest, so the algorithm is legible in the stored value', () => {
    expect(fingerprint(plaintext('sk-ant-api03-abcdefgh'))).toMatch(/^sha256:[0-9a-f]{32}$/);
  });
});

describe('lastFour', () => {
  it('returns the last four characters', () => {
    expect(lastFour(plaintext('sk-ant-api03-abcdefgh'))).toBe('efgh');
  });

  it('reads a seed the same way', () => {
    expect(lastFour(secretSeed('JBSWY3DPEHPK3PXP'))).toBe('3PXP');
  });

  /**
   * Four characters of a twelve-character secret is a third of it. §05 allows the tail as a
   * recognition aid for long provider keys, not as a way to publish a short one piece by piece.
   */
  it.each(['', 'a', 'abcd', 'abcdefg'])(
    'returns nothing for %o, which is too short',
    (material) => {
      expect(lastFour(plaintext(material))).toBe('');
    },
  );

  it('returns the tail once the material is long enough to spare it', () => {
    expect(lastFour(plaintext('abcdefgh'))).toBe('efgh');
  });
});

describe('the branded types', () => {
  /**
   * The point of the brands (§05: "secrets never reach a `toJSON`"). Each of these would compile if
   * the brand were the `string & { __brand }` shape, which stays assignable to `string` and so slips
   * onto any DTO field that takes one. `@ts-expect-error` makes the compiler assert the refusal:
   * if one of these ever becomes legal, `pnpm typecheck` fails on the unused directive.
   */
  it('cannot be assigned to the primitive shapes a DTO is made of', () => {
    const seed: SecretSeed = secretSeed('JBSWY3DPEHPK3PXP');
    const secret: Plaintext = plaintext('sk-ant-api03-abcdefgh');
    const dek: DataEncryptionKey = generateDataEncryptionKey();

    // @ts-expect-error a seed is not a string, so it cannot be placed on a DTO field
    const seedOnADto: string = seed;
    // @ts-expect-error a plaintext is not a buffer, so it cannot be written to a response
    const secretOnADto: Buffer = secret;
    // @ts-expect-error a DEK is not a buffer either
    const dekOnADto: Buffer = dek;
    // @ts-expect-error the carrier is phantom, so there is no property that hands it back
    const throughTheCarrier = seed.value as unknown;

    expect([seedOnADto, secretOnADto, dekOnADto, throughTheCarrier]).toHaveLength(4);
  });

  it('cannot be built by asserting a plain value into the type', () => {
    // @ts-expect-error a bare string is not a seed; `secretSeed()` is the only way in
    const forged: SecretSeed = 'JBSWY3DPEHPK3PXP';
    // @ts-expect-error a bare buffer is not a DEK
    const forgedDek: DataEncryptionKey = Buffer.alloc(DEK_BYTES);

    expect([forged, forgedDek]).toHaveLength(2);
  });

  /** Two brands over the same carrier must not be interchangeable, or the brand buys nothing. */
  it('does not let one kind of secret stand in for another', () => {
    // @ts-expect-error a seed is not a plaintext
    const asPlaintext: Plaintext = secretSeed('JBSWY3DPEHPK3PXP');
    // @ts-expect-error a plaintext is not a DEK
    const asDek: DataEncryptionKey = plaintext('sk-ant-api03-abcdefgh');

    expect([asPlaintext, asDek]).toHaveLength(2);
  });
});
