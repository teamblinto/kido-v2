import { describe, expect, it } from 'vitest';

import {
  PasswordStrengthPolicy,
  passwordUserInputs,
  PersonalInformationPasswordError,
  WeakPasswordError,
} from './strength-policy';

const OWNER = { email: 'ada.lovelace@forge.dev', name: 'Ada Lovelace' };

const policy = new PasswordStrengthPolicy();

describe('passwordUserInputs', () => {
  it('takes the whole address, the local part, its words and the domain labels from an email', () => {
    expect(passwordUserInputs({ email: 'ada.lovelace@forge.dev' })).toEqual(
      expect.arrayContaining([
        'ada.lovelace@forge.dev',
        'ada.lovelace',
        'ada',
        'lovelace',
        'forge',
      ]),
    );
  });

  it('drops a plus tag, which is not part of anyone’s identity', () => {
    expect(passwordUserInputs({ email: 'ada+signups@forge.dev' })).toContain('ada');
    expect(passwordUserInputs({ email: 'ada+signups@forge.dev' })).not.toContain('ada+signups');
  });

  it('takes the whole name and each of its words', () => {
    expect(passwordUserInputs({ name: 'Ada Lovelace' })).toEqual(
      expect.arrayContaining(['ada lovelace', 'ada', 'lovelace']),
    );
  });

  /**
   * A two-character token matches inside almost every password, so keeping them would classify
   * unrelated passwords as personal information — the one rejection a user cannot act on if it is
   * wrong, because they cannot see which token matched.
   */
  it('ignores tokens shorter than three characters', () => {
    expect(passwordUserInputs({ email: 'jo@x.io', name: 'Jo Ng' })).not.toContain('jo');
    expect(passwordUserInputs({ name: 'Jo Ng' })).not.toContain('ng');
  });

  it('de-duplicates case-insensitively', () => {
    const inputs = passwordUserInputs({ email: 'lovelace@forge.dev', name: 'Lovelace' });

    expect(inputs).toEqual([...new Set(inputs)]);
    expect(inputs.filter((token) => token === 'lovelace')).toHaveLength(1);
  });

  /**
   * Validating the address is the contract layer's job, not this one's. Whatever the account is
   * called, the tokens still have to come out — a policy that threw here would fail a signup over a
   * value it was only ever asked to read.
   */
  it('takes a value with no @ as a single address', () => {
    expect(passwordUserInputs({ email: 'not-an-email' })).toEqual(['not-an-email', 'not', 'email']);
  });

  it('returns nothing for an owner it knows nothing about', () => {
    expect(passwordUserInputs({})).toEqual([]);
    expect(passwordUserInputs({ email: null, name: undefined })).toEqual([]);
  });
});

describe('PasswordStrengthPolicy', () => {
  it('accepts a passphrase well above the floor', () => {
    expect(() => policy.assert('thermos-quibble-tundra-vellum', OWNER)).not.toThrow();
  });

  it('applies the floor with no owner to compare against', () => {
    expect(() => policy.assert('thermos-quibble-tundra-vellum')).not.toThrow();
    expect(() => policy.assert('password123')).toThrow(WeakPasswordError);
  });

  it.each([
    ['empty', ''],
    ['a top-list password', 'password123'],
    ['a keyboard walk', 'qwerty123456'],
  ])('rejects %s as too weak', (_name, password) => {
    expect(() => policy.assert(password, OWNER)).toThrow(WeakPasswordError);
  });

  /**
   * The test that decides the design. `AdaLovelace1815` scores **3** — at the floor — and
   * `Ada-Lovelace-forge` scores **4**, so a policy that checked the score and only then asked why
   * would accept both. Personal information is therefore its own rule, not a diagnosis of a low
   * score: a password mostly made of the owner's own name is rejected however well it scores.
   */
  it.each([
    ['the email local part', 'ada.lovelace!'],
    ['the name, scoring at the floor', 'AdaLovelace1815'],
    ['the name and the email domain, scoring above the floor', 'Ada-Lovelace-forge'],
  ])('rejects a password built from %s', (_name, password) => {
    expect(() => policy.assert(password, OWNER)).toThrow(PersonalInformationPasswordError);
  });

  /**
   * The other side of that rule: "derived from" is not "contains". A strong password that happens to
   * mention the owner somewhere is still a strong password, and rejecting it teaches users that the
   * meter is arbitrary.
   */
  it('accepts a strong password that merely mentions the owner', () => {
    expect(() => policy.assert('lovelace-quibble7-tundra!', OWNER)).not.toThrow();
  });

  it('prefers the personal-information rejection when a password is both weak and personal', () => {
    expect(() => policy.assert('lovelace', OWNER)).toThrow(PersonalInformationPasswordError);
  });

  it('gives the two rejections distinct problem slugs a caller can act on', () => {
    const weak = new WeakPasswordError('', []);
    const personal = new PersonalInformationPasswordError();

    expect(weak.type).toBe('password-too-weak');
    expect(personal.type).toBe('password-uses-personal-information');
    expect(weak.status).toBe(422);
    expect(personal.status).toBe(422);
  });

  it('carries zxcvbn’s own feedback so the caller can tell the user what to change', () => {
    try {
      policy.assert('password123', OWNER);
      expect.unreachable('should have rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(WeakPasswordError);
      expect((error as WeakPasswordError).extensions).toMatchObject({
        score: expect.any(Number) as number,
        suggestions: expect.any(Array) as string[],
        warning: 'This is a commonly used password.',
      });
    }
  });

  /** Never the password itself, or the rejection ends up in a log or an error tracker verbatim. */
  it('never puts the password in the problem it throws', () => {
    try {
      policy.assert('password123', OWNER);
      expect.unreachable('should have rejected');
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('password123');
      expect((error as WeakPasswordError).detail).not.toContain('password123');
    }
  });

  /**
   * zxcvbn's own `maxLength` caps how much of a password it scores, which is what stops a submitted
   * megabyte from costing measurable CPU. Asserted because it is a property of the *policy*, and a
   * later change to the options object could silently remove it.
   */
  it('scores an absurdly long password without burning CPU on it', () => {
    const started = performance.now();

    expect(() => policy.assert('a'.repeat(50_000), OWNER)).toThrow(WeakPasswordError);

    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
