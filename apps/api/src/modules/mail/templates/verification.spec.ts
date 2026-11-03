import { describe, expect, it } from 'vitest';

import { verificationMail } from './verification';

const INPUT = {
  appUrl: 'https://app.forge.dev',
  expiresInMinutes: 1_440,
  to: 'someone@example.com',
  token: 'PJmOx0m9k-2wQ7bYt1RfZs3aLdN6uVcH',
} as const;

describe('verificationMail', () => {
  it('is the email-verification template', () => {
    expect(verificationMail(INPUT).template).toBe('email-verification');
  });

  it('points at the verification route', () => {
    expect(verificationMail(INPUT).text).toContain('/auth/verify?token=');
  });

  /** T14 fixes the window at 24 hours; the mail has to say the same number the token enforces. */
  it('states the expiry it was given, in the units a reader thinks in', () => {
    expect(verificationMail(INPUT).text).toContain('24 hours');
  });

  it('restates a shorter window rather than hardcoding a day', () => {
    expect(verificationMail({ ...INPUT, expiresInMinutes: 30 }).text).toContain('30 minutes');
  });

  /**
   * Signup is enumeration-safe (T13): the response is identical whether or not the address is
   * already registered, and the mail is what tells the two apart. A mail that says "you already
   * have an account" is expected here; one that accuses the reader of signing up is not, because
   * the reader may be someone whose address a stranger typed in.
   */
  it('tells a reader who did not sign up that ignoring it is enough', () => {
    expect(verificationMail(INPUT).text.toLowerCase()).toContain('ignore');
  });

  it('does not ask the reader to reply with anything', () => {
    expect(verificationMail(INPUT).text.toLowerCase()).not.toContain('reply with');
  });
});
