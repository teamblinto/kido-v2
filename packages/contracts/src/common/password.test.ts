import { describe, expect, it } from 'vitest';

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordSchema } from './password';

describe('passwordSchema', () => {
  it('leaves every byte alone, including the ones that look like noise', () => {
    const candidate = '  correct horse battery staple  ';

    expect(passwordSchema.parse(candidate)).toBe(candidate);
  });

  it('enforces the ASVS length floor and the Argon2id work ceiling', () => {
    expect(passwordSchema.safeParse('a'.repeat(PASSWORD_MIN_LENGTH - 1)).success).toBe(false);
    expect(passwordSchema.safeParse('a'.repeat(PASSWORD_MIN_LENGTH)).success).toBe(true);
    expect(passwordSchema.safeParse('a'.repeat(PASSWORD_MAX_LENGTH)).success).toBe(true);
    expect(passwordSchema.safeParse('a'.repeat(PASSWORD_MAX_LENGTH + 1)).success).toBe(false);
  });

  it('permits at least the 64 characters ASVS 2.1.2 requires', () => {
    expect(PASSWORD_MAX_LENGTH).toBeGreaterThanOrEqual(64);
  });

  /**
   * The boundary deliberately does not have an opinion on strength. If this ever starts failing,
   * a complexity rule has been smuggled into the contract and §11's zxcvbn floor has been weakened
   * into the thing OWASP ASVS 2.1 tells us not to ship.
   */
  it('does not pre-empt the server-side strength and breach checks', () => {
    expect(passwordSchema.safeParse('password1234').success).toBe(true);
  });
});
