import type { ConfigService } from '@nestjs/config';
import { hash as argon2Hash } from '@node-rs/argon2';
import { describe, expect, it } from 'vitest';

import type { Environment } from '../../../config/environment';
import { argon2ParametersOf, PasswordHasher } from './hasher';

/** §11: "Argon2id (64 MB, t=3, p=1)". The environment schema defaults to exactly these. */
const MANDATED = {
  ARGON2_MEMORY_KIB: 65_536,
  ARGON2_PARALLELISM: 1,
  ARGON2_TIME_COST: 3,
};

/** `Algorithm.Argon2i`, spelled as a number for the reason `hasher.ts` gives. */
const ARGON2I = 1;

const MANDATED_PARAMETERS = { memoryKib: 65_536, parallelism: 1, timeCost: 3, version: 19 };

const PASSWORD = 'correct horse battery staple';

function hasher(overrides: Partial<typeof MANDATED> = {}): PasswordHasher {
  const values = { ...MANDATED, ...overrides };

  return new PasswordHasher({
    get: (key: keyof typeof values) => values[key],
  } as unknown as ConfigService<Environment, true>);
}

describe('PasswordHasher', () => {
  /**
   * The parameters are read back out of the encoded hash rather than out of the configuration the
   * test just supplied, because the failure worth catching is a hasher that accepts the numbers and
   * then hashes with the library defaults — 4 MB, a sixteen-fold cut in what an attacker pays.
   */
  it('hashes with the Argon2id parameters §11 mandates', async () => {
    const encoded = await hasher().hash(PASSWORD);

    expect(encoded.startsWith('$argon2id$v=19$m=65536,t=3,p=1$')).toBe(true);
    expect(argon2ParametersOf(encoded)).toEqual(MANDATED_PARAMETERS);
  });

  it('salts every hash, so one password never encodes to the same string twice', async () => {
    const subject = hasher();

    expect(await subject.hash(PASSWORD)).not.toBe(await subject.hash(PASSWORD));
  });

  it('accepts the password it hashed', async () => {
    const subject = hasher();

    await expect(subject.verify(await subject.hash(PASSWORD), PASSWORD)).resolves.toEqual({
      rehashed: null,
      valid: true,
    });
  });

  it('rejects a wrong password', async () => {
    const subject = hasher();

    await expect(subject.verify(await subject.hash(PASSWORD), 'Correct Horse')).resolves.toEqual({
      rehashed: null,
      valid: false,
    });
  });

  /**
   * A stored value that is not an Argon2 hash — a truncated column, a bcrypt hash from an import, an
   * empty string — makes the library throw. That has to read as "wrong password" at the call site,
   * or a login endpoint turns a data problem into a 500 that also tells the caller the row exists.
   */
  it.each([
    ['not PHC at all', 'not-a-hash'],
    ['empty', ''],
    ['a bcrypt hash', '$2b$12$K1x5jsSp6vJ.NLE8sVoS2eZ1Ib3Gg9L0Rq0YlH5cU8L2mQ0dQzWvC'],
  ])(
    'treats an unusable stored hash (%s) as a failed verification, not an error',
    async (_name, stored) => {
      await expect(hasher().verify(stored, PASSWORD)).resolves.toEqual({
        rehashed: null,
        valid: false,
      });
    },
  );

  describe('rehashing', () => {
    it('leaves a hash alone when its parameters already match the configuration', async () => {
      const subject = hasher();

      const { rehashed } = await subject.verify(await subject.hash(PASSWORD), PASSWORD);

      expect(rehashed).toBeNull();
    });

    it.each([
      ['memory cost', { ARGON2_MEMORY_KIB: 19_456 }],
      ['time cost', { ARGON2_TIME_COST: 2 }],
      ['parallelism', { ARGON2_PARALLELISM: 2 }],
    ])('rehashes a hash stored with a different %s', async (_name, stale) => {
      const stored = await hasher(stale).hash(PASSWORD);

      const { rehashed, valid } = await hasher().verify(stored, PASSWORD);

      expect(valid).toBe(true);
      expect(rehashed).not.toBeNull();
      expect(argon2ParametersOf(rehashed!)).toEqual(MANDATED_PARAMETERS);
    });

    /**
     * Argon2i verifies with the same call, so an imported hash of the wrong variant would otherwise
     * satisfy a comparison that only looked at m, t and p and keep its algorithm forever.
     */
    it('rehashes a hash of an Argon2 variant that is not Argon2id', async () => {
      const stored = await argon2Hash(PASSWORD, {
        algorithm: ARGON2I,
        memoryCost: 19_456,
        parallelism: 1,
        timeCost: 2,
      });

      const { rehashed, valid } = await hasher().verify(stored, PASSWORD);

      expect(valid).toBe(true);
      expect(argon2ParametersOf(rehashed!)).toEqual(MANDATED_PARAMETERS);
    });

    /**
     * The rehash is of the password the caller supplied, so doing it after a *failed* verification
     * would store a hash of whatever the attacker guessed and lock the owner out. Order matters
     * here, not just the outcome.
     */
    it('never rehashes when the password did not verify', async () => {
      const stored = await hasher({ ARGON2_MEMORY_KIB: 19_456 }).hash(PASSWORD);

      await expect(hasher().verify(stored, 'not the password')).resolves.toEqual({
        rehashed: null,
        valid: false,
      });
    });
  });
});

describe('argon2ParametersOf', () => {
  it('reads the header of a real hash', async () => {
    const encoded = await hasher({ ARGON2_MEMORY_KIB: 19_456, ARGON2_TIME_COST: 2 }).hash(PASSWORD);

    expect(argon2ParametersOf(encoded)).toEqual({
      memoryKib: 19_456,
      parallelism: 1,
      timeCost: 2,
      version: 19,
    });
  });

  it('reads a v=16 header, which is older than anything this codebase writes', () => {
    expect(argon2ParametersOf('$argon2id$v=16$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2g')).toEqual({
      memoryKib: 65_536,
      parallelism: 1,
      timeCost: 3,
      version: 16,
    });
  });

  it.each([
    ['empty', ''],
    ['not PHC at all', 'not-a-hash'],
    ['a bcrypt hash', '$2b$12$K1x5jsSp6vJ.NLE8sVoS2eZ1Ib3Gg9L0Rq0YlH5cU8L2mQ0dQzWvC'],
    ['an Argon2 variant that is not Argon2id', '$argon2i$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA'],
    ['a header with no version', '$argon2id$m=65536,t=3,p=1$c2FsdA$aGFzaA'],
    ['a header missing a cost', '$argon2id$v=19$m=65536,p=1$c2FsdA$aGFzaA'],
    ['a non-numeric cost', '$argon2id$v=19$m=lots,t=3,p=1$c2FsdA$aGFzaA'],
    ['costs in an unexpected order', '$argon2id$v=19$t=3,m=65536,p=1$c2FsdA$aGFzaA'],
    ['no salt or digest', '$argon2id$v=19$m=65536,t=3,p=1'],
  ])('returns null for %s', (_name, encoded) => {
    expect(argon2ParametersOf(encoded)).toBeNull();
  });
});
