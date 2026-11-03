import { describe, expect, it } from 'vitest';

import { passwordResetMail } from './password-reset';

const INPUT = {
  appUrl: 'https://app.forge.dev',
  expiresInMinutes: 30,
  to: 'someone@example.com',
  token: 'PJmOx0m9k-2wQ7bYt1RfZs3aLdN6uVcH',
} as const;

describe('passwordResetMail', () => {
  it('is the password-reset template', () => {
    expect(passwordResetMail(INPUT).template).toBe('password-reset');
  });

  it('points at the reset route', () => {
    expect(passwordResetMail(INPUT).text).toContain('/auth/password/reset?token=');
  });

  /** T19 fixes the window at 30 minutes. */
  it('states the expiry it was given', () => {
    expect(passwordResetMail(INPUT).text).toContain('30 minutes');
  });

  /**
   * §11: consuming a reset token revokes every session and refresh token. Saying so in the mail is
   * what stops the "why was I signed out everywhere?" support ticket, and it is also the sentence
   * that tells a victim of an attempted takeover that something happened.
   */
  it('warns that completing the reset signs every device out', () => {
    expect(passwordResetMail(INPUT).text.toLowerCase()).toMatch(/sign(ed)? out|signs you out/);
  });

  /**
   * Reset is enumeration-safe (T19): the endpoint answers identically for a known and an unknown
   * address. This mail is only sent to a real account, so it may safely tell the reader that
   * ignoring it leaves the password unchanged.
   */
  it('tells a reader who did not ask that ignoring it changes nothing', () => {
    const text = passwordResetMail(INPUT).text.toLowerCase();

    expect(text).toContain('ignore');
    expect(text).toContain('unchanged');
  });

  it('never states the current password or hints at it', () => {
    expect(passwordResetMail(INPUT).text.toLowerCase()).not.toContain('your current password is');
  });
});
