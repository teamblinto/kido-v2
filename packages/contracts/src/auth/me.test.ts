import { describe, expect, it } from 'vitest';

import { signedInResponseSchema } from './login';
import { currentUserResponseSchema } from './me';

const USER = {
  email: 'ada@example.com',
  emailVerified: true,
  id: '3f1b1f8e-6b1a-4c1e-9d2a-2a5b8f0c1d3e',
  mfaEnabled: true,
};

describe('currentUserResponseSchema', () => {
  it('accepts the account a resumed session resolves to', () => {
    expect(currentUserResponseSchema.parse({ user: USER })).toEqual({ user: USER });
  });

  /**
   * The property the file exists for. `POST /auth/login`, `POST /auth/mfa/challenge` and
   * `GET /auth/me` all answer "who is signed in", and a client that had to branch on which of them
   * told it would hold two spellings of the current user. An alias cannot drift; a parallel
   * definition would be identical the day it was written and would diverge the first time either
   * endpoint gained a field.
   */
  it('is the sign-in shape itself, not a copy that could drift from it', () => {
    expect(currentUserResponseSchema).toBe(signedInResponseSchema);
  });

  /**
   * Criterion 3, inherited. The session token lives in the `__Host-forge_session` cookie and
   * nowhere a client could read, log or forward it — and `GET /auth/me` is the response somebody
   * building a "your session expires in…" banner would reach for first.
   */
  it.each(['token', 'sessionId', 'expiresAt', 'cookie'])(
    'refuses a %s member outright',
    (member) => {
      expect(currentUserResponseSchema.safeParse({ user: USER, [member]: 'x' }).success).toBe(
        false,
      );
    },
  );

  it('refuses an extra member on the account itself', () => {
    expect(
      currentUserResponseSchema.safeParse({ user: { ...USER, passwordHash: 'x' } }).success,
    ).toBe(false);
  });

  /** No organisation here: which ones the caller belongs to is `GET /orgs`, and its own read. */
  it('carries the account and nothing about tenancy', () => {
    expect(Object.keys(currentUserResponseSchema.parse({ user: USER }))).toEqual(['user']);
  });

  it('refuses a body with no user at all', () => {
    expect(currentUserResponseSchema.safeParse({}).success).toBe(false);
  });
});
