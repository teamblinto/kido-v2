import { describe, expect, it } from 'vitest';

import { ownershipToken, ownershipTxtValue } from './ownership-token';

describe('ownershipToken', () => {
  it('is 32 lowercase base32 characters (20 random bytes)', () => {
    expect(ownershipToken()).toMatch(/^[a-z2-7]{32}$/);
  });

  it('encodes the injected bytes as RFC 4648 base32, lowercase, unpadded', () => {
    expect(ownershipToken(() => Buffer.alloc(20, 0))).toBe('a'.repeat(32));
    expect(ownershipToken(() => Buffer.alloc(20, 0xff))).toBe('7'.repeat(32));
    // 0x00 0x44 0x32 0x14 0xc7 is 00000 00001 00010 00011 00100 00101 00110 00111.
    const pattern = Buffer.from(
      Array.from({ length: 4 }, () => [0x00, 0x44, 0x32, 0x14, 0xc7]).flat(),
    );
    expect(ownershipToken(() => pattern)).toBe('abcdefgh'.repeat(4));
  });

  it('asks the random source for exactly 20 bytes', () => {
    const sizes: number[] = [];
    ownershipToken((size) => {
      sizes.push(size);
      return Buffer.alloc(size);
    });
    expect(sizes).toEqual([20]);
  });

  it('draws 1,000 distinct tokens', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => ownershipToken()));
    expect(tokens.size).toBe(1000);
  });
});

describe('ownershipTxtValue', () => {
  it('is forge-verify=<token>', () => {
    const token = ownershipToken();
    expect(ownershipTxtValue(token)).toBe(`forge-verify=${token}`);
  });
});
