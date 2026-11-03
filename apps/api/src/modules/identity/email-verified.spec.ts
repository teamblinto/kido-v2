import { describe, expect, it } from 'vitest';

import { EmailNotVerifiedError, isEmailVerified, requireEmailVerified } from './email-verified';

const VERIFIED = { emailVerifiedAt: new Date('2026-08-16T10:00:00.000Z') };
const UNVERIFIED = { emailVerifiedAt: null };

describe('isEmailVerified', () => {
  it('is false for the account signup just created', () => {
    expect(isEmailVerified(UNVERIFIED)).toBe(false);
  });

  it('is true once the column carries a timestamp', () => {
    expect(isEmailVerified(VERIFIED)).toBe(true);
  });

  /**
   * The column is the whole predicate, and it is read as "is there a timestamp" rather than "is it
   * in the past". A verification row is written by the clock at the moment it is used (T14), so a
   * future value would mean the clock ran backwards — and answering `false` to that would lock a
   * verified user out of their own account over a leap second.
   */
  it('is true for a timestamp that has not arrived yet', () => {
    expect(isEmailVerified({ emailVerifiedAt: new Date('2099-01-01T00:00:00.000Z') })).toBe(true);
  });
});

describe('requireEmailVerified', () => {
  it('lets a verified account through', () => {
    expect(() => requireEmailVerified(VERIFIED, 'create a sandbox')).not.toThrow();
  });

  it('refuses an unverified one', () => {
    expect(() => requireEmailVerified(UNVERIFIED, 'create a sandbox')).toThrow(
      EmailNotVerifiedError,
    );
  });

  /**
   * §11's rule is "unverified accounts cannot create sandboxes", and sandboxes do not exist yet.
   * Naming the refused capability in the detail is what lets this one error serve every later
   * caller without the rule being restated — and re-stated slightly differently — at each of them.
   */
  it('names the capability it refused, so one error serves every caller', () => {
    expect(() => requireEmailVerified(UNVERIFIED, 'create a sandbox')).toThrow(/create a sandbox/);
    expect(() => requireEmailVerified(UNVERIFIED, 'invite a teammate')).toThrow(
      /invite a teammate/,
    );
  });

  it('answers 403 under a slug of its own, not a bare forbidden', () => {
    const error = new EmailNotVerifiedError('create a sandbox');

    expect(error.status).toBe(403);
    expect(error.type).toBe('email-not-verified');
  });
});
