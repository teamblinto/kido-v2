import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  DEK_BYTES,
  InvalidDataEncryptionKeyError,
  generateDataEncryptionKey,
  revealDataEncryptionKey,
} from './branded';
import { EnvKekProvider, EnvKekRefusedError } from './env-kek.provider';
import { KekUnwrapError, UnknownKekError } from './kek-provider.port';

const MASTER_KEY = randomBytes(32).toString('base64');
const ORG = '9f1c4d2e-6b8a-4f70-9c3d-1e5a7b2c8d40';
const OTHER_ORG = 'c2a7f019-4d3b-4a62-8e15-73b904ca6f88';

function provider(masterKey = MASTER_KEY): EnvKekProvider {
  return new EnvKekProvider(masterKey, 'local');
}

describe('EnvKekProvider on a real deployment', () => {
  /**
   * §11's requirement, read through ADR 009: the refusal keys on `DEPLOY_ENV`, not `NODE_ENV`. The
   * local compose stack legitimately runs a production *build* — `NODE_ENV=production` with
   * `DEPLOY_ENV=local` — and must still boot, while a staging deployment that forgot to configure
   * OpenBao must not.
   */
  it.each(['staging', 'production'] as const)('refuses to construct on %s', (deployEnv) => {
    expect(() => new EnvKekProvider(MASTER_KEY, deployEnv)).toThrow(EnvKekRefusedError);
  });

  it('names DEPLOY_ENV in the refusal, so the fix is obvious from the boot log', () => {
    expect(() => new EnvKekProvider(MASTER_KEY, 'production')).toThrow(/DEPLOY_ENV/);
  });

  it('never puts the master key in the refusal', () => {
    let caught: unknown;

    try {
      new EnvKekProvider(MASTER_KEY, 'production');
    } catch (error) {
      caught = error;
    }

    expect(`${(caught as Error).message} ${(caught as Error).stack ?? ''}`).not.toContain(
      MASTER_KEY,
    );
  });

  it('constructs on local', () => {
    expect(provider()).toBeInstanceOf(EnvKekProvider);
  });
});

describe('EnvKekProvider master key', () => {
  it.each([16, 31, 33])('refuses a key that decodes to %i bytes', (size) => {
    expect(() => provider(randomBytes(size).toString('base64'))).toThrow(
      InvalidDataEncryptionKeyError,
    );
  });

  it('accepts a key that decodes to exactly 32 bytes', () => {
    expect(() => provider(randomBytes(DEK_BYTES).toString('base64'))).not.toThrow();
  });
});

describe('EnvKekProvider.kekId', () => {
  /** `org_data_keys.kek_id` is what tells a rotation which key produced a wrap, so it must be stable. */
  it('is the same across two providers holding the same master key', () => {
    expect(provider().kekId).toBe(provider().kekId);
  });

  it('differs when the master key differs', () => {
    expect(provider().kekId).not.toBe(provider(randomBytes(32).toString('base64')).kekId);
  });

  it('names the provider, so a stored id says where to look for the key', () => {
    expect(provider().kekId).toMatch(/^env:[0-9a-f]{16}$/);
  });

  /** It is written to a column that is dumped, backed up and read by support. */
  it('reveals no part of the master key', () => {
    const raw = Buffer.from(MASTER_KEY, 'base64');

    expect(provider().kekId).not.toContain(MASTER_KEY);
    expect(provider().kekId).not.toContain(raw.toString('hex'));
    expect(provider().kekId).not.toContain(raw.toString('hex').slice(0, 16));
  });
});

describe('EnvKekProvider wrap and unwrap', () => {
  it('returns the exact key that was wrapped', async () => {
    const kek = provider();
    const dek = generateDataEncryptionKey();

    const unwrapped = await kek.unwrap(await kek.wrap(dek, { orgId: ORG }), { orgId: ORG });

    expect(revealDataEncryptionKey(unwrapped)).toEqual(revealDataEncryptionKey(dek));
  });

  it('stamps the wrap with the id of the key that produced it', async () => {
    const kek = provider();

    expect((await kek.wrap(generateDataEncryptionKey(), { orgId: ORG })).kekId).toBe(kek.kekId);
  });

  it('produces a different ciphertext every time the same DEK is wrapped', async () => {
    const kek = provider();
    const dek = generateDataEncryptionKey();
    const wraps = await Promise.all(
      Array.from({ length: 16 }, async () =>
        (await kek.wrap(dek, { orgId: ORG })).ciphertext.toString('hex'),
      ),
    );

    expect(new Set(wraps).size).toBe(wraps.length);
  });

  it('does not put the DEK in the wrapped bytes', async () => {
    const kek = provider();
    const dek = generateDataEncryptionKey();
    const wrapped = await kek.wrap(dek, { orgId: ORG });

    expect(wrapped.ciphertext.toString('hex')).not.toContain(
      revealDataEncryptionKey(dek).toString('hex'),
    );
  });

  /**
   * The organisation is bound into the KEK layer too, so a `wrapped_dek` moved between rows of
   * `org_data_keys` fails exactly like a relocated `secrets.ciphertext` does. Without it, the
   * tenant binding would live only in the inner envelope and a swapped DEK row would unwrap fine.
   */
  it('refuses a wrapped key presented under another organisation', async () => {
    const kek = provider();
    const wrapped = await kek.wrap(generateDataEncryptionKey(), { orgId: ORG });

    await expect(kek.unwrap(wrapped, { orgId: OTHER_ORG })).rejects.toThrow(KekUnwrapError);
  });

  it('refuses a wrapped key produced by a different master key', async () => {
    const wrapped = await provider().wrap(generateDataEncryptionKey(), { orgId: ORG });
    const other = provider(randomBytes(32).toString('base64'));

    await expect(
      other.unwrap({ ciphertext: wrapped.ciphertext, kekId: other.kekId }, { orgId: ORG }),
    ).rejects.toThrow(KekUnwrapError);
  });

  it('refuses a wrapped key whose bytes were tampered with', async () => {
    const kek = provider();
    const wrapped = await kek.wrap(generateDataEncryptionKey(), { orgId: ORG });
    const last = wrapped.ciphertext.length - 1;

    wrapped.ciphertext.writeUInt8(wrapped.ciphertext.readUInt8(last) ^ 0x01, last);

    await expect(kek.unwrap(wrapped, { orgId: ORG })).rejects.toThrow(KekUnwrapError);
  });

  it.each([0, 1, 27])('refuses a %i-byte wrapped key', async (size) => {
    const kek = provider();

    await expect(
      kek.unwrap({ ciphertext: Buffer.alloc(size), kekId: kek.kekId }, { orgId: ORG }),
    ).rejects.toThrow(KekUnwrapError);
  });

  /**
   * A row wrapped under a retired KEK is an operational fact — the rotation has not reached it yet —
   * not an attack, so it is reported as itself rather than as a generic failure. It still names no
   * key material.
   */
  it('says so plainly when the wrap names a KEK this process does not hold', async () => {
    const kek = provider();
    const wrapped = await kek.wrap(generateDataEncryptionKey(), { orgId: ORG });

    await expect(
      kek.unwrap({ ciphertext: wrapped.ciphertext, kekId: 'env:0000000000000000' }, { orgId: ORG }),
    ).rejects.toThrow(UnknownKekError);
  });

  it('reports an unknown KEK as a kind of unwrap failure, so one catch covers both', () => {
    expect(new UnknownKekError('env:0000000000000000')).toBeInstanceOf(KekUnwrapError);
  });

  it('names no key material when it refuses', async () => {
    const kek = provider();
    const dek = generateDataEncryptionKey();
    const wrapped = await kek.wrap(dek, { orgId: ORG });
    let caught: unknown;

    try {
      await kek.unwrap(wrapped, { orgId: OTHER_ORG });
    } catch (error) {
      caught = error;
    }

    const rendered = `${(caught as Error).message} ${(caught as Error).stack ?? ''}`;

    expect(rendered).not.toContain(MASTER_KEY);
    expect(rendered).not.toContain(revealDataEncryptionKey(dek).toString('hex'));
    expect(rendered).not.toContain(wrapped.ciphertext.toString('base64'));
  });
});
