import { timingSafeEqual } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { bytesMatch, secretsMatch } from './constant-time';

describe('secretsMatch', () => {
  it('accepts two identical values', () => {
    expect(secretsMatch('a5f2-9c31-7b0e', 'a5f2-9c31-7b0e')).toBe(true);
  });

  it('rejects a value that differs in the last character', () => {
    expect(secretsMatch('a5f2-9c31-7b0e', 'a5f2-9c31-7b0f')).toBe(false);
  });

  it('rejects a value that differs in the first character', () => {
    expect(secretsMatch('a5f2-9c31-7b0e', 'b5f2-9c31-7b0e')).toBe(false);
  });

  it('accepts two empty values', () => {
    expect(secretsMatch('', '')).toBe(true);
  });

  it('rejects an empty value against a present one', () => {
    expect(secretsMatch('', 'a5f2-9c31-7b0e')).toBe(false);
  });

  /**
   * `crypto.timingSafeEqual` throws a `RangeError` when the two buffers differ in length, so a
   * naive implementation turns "the candidate was the wrong length" into an exception — a signal
   * that is both louder and earlier than the `false` a mismatch produces. Hashing first makes every
   * comparison the same size, so length is neither a crash nor a timing channel.
   */
  it('answers false rather than throwing when the lengths differ', () => {
    expect(() => timingSafeEqual(Buffer.from('a'), Buffer.from('ab'))).toThrow(RangeError);

    expect(secretsMatch('a', 'ab')).toBe(false);
    expect(secretsMatch('a'.repeat(4_096), 'a')).toBe(false);
  });

  it('compares by bytes, so two spellings of the same text are not confused', () => {
    expect(secretsMatch('é', 'é')).toBe(false);
  });

  it('is not fooled by values that share a prefix', () => {
    expect(secretsMatch('token', 'token-and-more')).toBe(false);
  });
});

describe('bytesMatch', () => {
  it('accepts two identical buffers', () => {
    expect(bytesMatch(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 3]))).toBe(true);
  });

  it('rejects buffers differing in one byte', () => {
    expect(bytesMatch(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 4]))).toBe(false);
  });

  it('accepts two empty buffers', () => {
    expect(bytesMatch(Buffer.alloc(0), Buffer.alloc(0))).toBe(true);
  });

  it('answers false rather than throwing when the lengths differ', () => {
    expect(bytesMatch(Buffer.from([1]), Buffer.from([1, 2]))).toBe(false);
  });

  /** A zero byte is a terminator in some comparison routines and must not be one here. */
  it('sees past an embedded zero byte', () => {
    expect(bytesMatch(Buffer.from([0, 1]), Buffer.from([0, 2]))).toBe(false);
    expect(bytesMatch(Buffer.from([0, 1]), Buffer.from([0, 1]))).toBe(true);
  });
});
