import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  type DataEncryptionKey,
  generateDataEncryptionKey,
  plaintext,
  revealPlaintext,
} from './branded';
import {
  ENVELOPE_VERSION,
  IV_BYTES,
  SECRET_ALG,
  type SecretBinding,
  SecretDecryptionError,
  TAG_BYTES,
  open,
  seal,
} from './envelope';

const ORG = '9f1c4d2e-6b8a-4f70-9c3d-1e5a7b2c8d40';
const OTHER_ORG = 'c2a7f019-4d3b-4a62-8e15-73b904ca6f88';

const BINDING: SecretBinding = { orgId: ORG, purpose: 'anthropic_api_key' };

const SECRET = 'sk-ant-api03-3b7f9c2e1a4d6088';

function sealed(dek: DataEncryptionKey, binding: SecretBinding = BINDING): Buffer {
  return seal(dek, plaintext(SECRET), binding);
}

/** Corrupts one byte in place. `buffer[i] ^= 1` does not typecheck under `noUncheckedIndexedAccess`. */
function flipByte(buffer: Buffer, index: number): Buffer {
  buffer.writeUInt8(buffer.readUInt8(index) ^ 0x01, index);

  return buffer;
}

describe('seal and open', () => {
  it('returns the exact bytes that were sealed', () => {
    const dek = generateDataEncryptionKey();

    expect(revealPlaintext(open(dek, sealed(dek), BINDING)).toString('utf8')).toBe(SECRET);
  });

  it('survives arbitrary bytes, not just text', () => {
    const dek = generateDataEncryptionKey();
    const bytes = Buffer.from([0x00, 0xff, 0x0a, 0x80, 0x00]);

    expect(revealPlaintext(open(dek, seal(dek, plaintext(bytes), BINDING), BINDING))).toEqual(
      bytes,
    );
  });

  it('survives an empty secret', () => {
    const dek = generateDataEncryptionKey();

    expect(revealPlaintext(open(dek, seal(dek, plaintext(''), BINDING), BINDING))).toHaveLength(0);
  });

  /** A fixed IV under a reused key is the classic GCM catastrophe; only a fresh IV rules it out. */
  it('produces a different ciphertext every time the same secret is sealed', () => {
    const dek = generateDataEncryptionKey();
    const outputs = new Set(Array.from({ length: 32 }, () => sealed(dek).toString('hex')));

    expect(outputs.size).toBe(32);
  });

  it('lays the ciphertext out as version, iv, tag, then body', () => {
    const dek = generateDataEncryptionKey();
    const output = sealed(dek);

    expect(output[0]).toBe(ENVELOPE_VERSION);
    expect(output).toHaveLength(1 + IV_BYTES + TAG_BYTES + Buffer.byteLength(SECRET));
  });

  it('names the algorithm the secrets table records', () => {
    expect(SECRET_ALG).toBe('AES-256-GCM');
  });
});

/**
 * The property §05 and the spec's testing strategy both name outright: a ciphertext copied from one
 * row to another must *fail* rather than decrypt. Everything below is that proof from a different
 * angle — the AAD is what carries it, so each test moves one component of the AAD and nothing else.
 */
describe('relocating a ciphertext', () => {
  it('fails when the row is moved to another organisation', () => {
    const dek = generateDataEncryptionKey();
    const stolen = sealed(dek);

    expect(() => open(dek, stolen, { orgId: OTHER_ORG, purpose: 'anthropic_api_key' })).toThrow(
      SecretDecryptionError,
    );
  });

  it('fails when the row is re-labelled with another purpose', () => {
    const dek = generateDataEncryptionKey();
    const stolen = sealed(dek);

    expect(() => open(dek, stolen, { orgId: ORG, purpose: 'openai_api_key' })).toThrow(
      SecretDecryptionError,
    );
  });

  it('fails when both the organisation and the purpose are changed together', () => {
    const dek = generateDataEncryptionKey();

    expect(() => open(dek, sealed(dek), { orgId: OTHER_ORG, purpose: 'openai_api_key' })).toThrow(
      SecretDecryptionError,
    );
  });

  it('fails under another organisation key even when the binding is not moved', () => {
    const stolen = sealed(generateDataEncryptionKey());

    expect(() => open(generateDataEncryptionKey(), stolen, BINDING)).toThrow(SecretDecryptionError);
  });

  /**
   * With a naive `orgId + ':' + purpose` AAD these two rows share one AAD string, so the pair would
   * cross-decrypt: the split is ambiguous and the binding stops binding. The length prefix is what
   * makes the encoding injective, and this is the test that holds it to that.
   */
  it('fails between two bindings whose parts concatenate to the same text', () => {
    const dek = generateDataEncryptionKey();
    const left = seal(dek, plaintext(SECRET), { orgId: 'ab', purpose: 'cd' });

    expect(() => open(dek, left, { orgId: 'a', purpose: 'bcd' })).toThrow(SecretDecryptionError);
    expect(() => open(dek, left, { orgId: 'abc', purpose: 'd' })).toThrow(SecretDecryptionError);
  });

  it('still opens under the binding it was actually sealed with', () => {
    const dek = generateDataEncryptionKey();
    const binding = { orgId: randomUUID(), purpose: 'byos_credential_set' };

    expect(
      revealPlaintext(open(dek, seal(dek, plaintext(SECRET), binding), binding)).toString(),
    ).toBe(SECRET);
  });
});

describe('tampering with a ciphertext', () => {
  it('fails when a body byte is flipped', () => {
    const dek = generateDataEncryptionKey();
    const output = sealed(dek);

    expect(() => open(dek, flipByte(output, output.length - 1), BINDING)).toThrow(
      SecretDecryptionError,
    );
  });

  it('fails when the authentication tag is flipped', () => {
    const dek = generateDataEncryptionKey();

    expect(() => open(dek, flipByte(sealed(dek), 1 + IV_BYTES), BINDING)).toThrow(
      SecretDecryptionError,
    );
  });

  it('fails when the iv is flipped', () => {
    const dek = generateDataEncryptionKey();

    expect(() => open(dek, flipByte(sealed(dek), 1), BINDING)).toThrow(SecretDecryptionError);
  });

  it('fails when the version byte is changed, rather than reading the body under old rules', () => {
    const dek = generateDataEncryptionKey();
    const output = sealed(dek);

    output[0] = ENVELOPE_VERSION + 1;

    expect(() => open(dek, output, BINDING)).toThrow(SecretDecryptionError);
  });

  it.each([0, 1, IV_BYTES, 1 + IV_BYTES, IV_BYTES + TAG_BYTES])(
    'fails on a %i-byte ciphertext, which is too short to hold a header',
    (size) => {
      expect(() => open(generateDataEncryptionKey(), Buffer.alloc(size), BINDING)).toThrow(
        SecretDecryptionError,
      );
    },
  );

  it('accepts a ciphertext holding a header and an empty body', () => {
    const dek = generateDataEncryptionKey();

    expect(seal(dek, plaintext(''), BINDING)).toHaveLength(1 + IV_BYTES + TAG_BYTES);
  });
});

describe('SecretDecryptionError', () => {
  /** It reaches a log and an error tracker, so it must carry the failure and nothing else. */
  it('names neither the secret, the key nor the binding', () => {
    const dek = generateDataEncryptionKey();
    let caught: unknown;

    try {
      open(dek, sealed(dek), { orgId: OTHER_ORG, purpose: 'openai_api_key' });
    } catch (error) {
      caught = error;
    }

    const rendered = `${(caught as Error).message} ${(caught as Error).stack ?? ''}`;

    expect(caught).toBeInstanceOf(SecretDecryptionError);
    expect(rendered).not.toContain(SECRET);
    expect(rendered).not.toContain(OTHER_ORG);
    expect(rendered).not.toContain('openai_api_key');
  });

  /**
   * A wrong key, a wrong org, a wrong purpose and a flipped byte are indistinguishable to GCM and
   * must stay indistinguishable to the caller: telling them apart tells an attacker which half of a
   * guess was right.
   */
  it('reads the same however the open failed', () => {
    const dek = generateDataEncryptionKey();
    const output = sealed(dek);
    const tampered = flipByte(Buffer.from(output), output.length - 1);

    const messages = new Set(
      [
        () => open(dek, output, { orgId: OTHER_ORG, purpose: 'anthropic_api_key' }),
        () => open(dek, output, { orgId: ORG, purpose: 'openai_api_key' }),
        () => open(generateDataEncryptionKey(), output, BINDING),
        () => open(dek, tampered, BINDING),
      ].map((attempt) => {
        try {
          attempt();
          throw new Error('expected the open to fail');
        } catch (error) {
          return (error as Error).message;
        }
      }),
    );

    expect(messages.size).toBe(1);
  });
});
