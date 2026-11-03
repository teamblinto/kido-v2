import { describe, expect, it } from 'vitest';

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../common/password';
import {
  PASSWORD_CHANGED,
  PASSWORD_RESET,
  PASSWORD_RESET_REQUESTED,
  changePasswordRequestSchema,
  changePasswordResponseSchema,
  requestPasswordResetRequestSchema,
  requestPasswordResetResponseSchema,
  resetPasswordRequestSchema,
  resetPasswordResponseSchema,
} from './password';

/** 32 bytes of `randomBytes` in base64url: 43 characters, exactly what the reset mail links. */
const TOKEN = 'F3s7NRy8Sk8ZBxSEqQqK0F4Zj-Zw6vMzBu1t2cN9xkQ';
const STRONG = 'thermos-quibble-tundra-vellum';

describe('changePasswordRequestSchema', () => {
  it('accepts a current password and a new one', () => {
    const body = { currentPassword: 'whatever-they-had-before', newPassword: STRONG };

    expect(changePasswordRequestSchema.parse(body)).toEqual(body);
  });

  /**
   * The current password is a *credential being checked*, not a candidate being chosen, and the two
   * cannot share a schema. `PASSWORD_MIN_LENGTH` is today's floor; an account created before it
   * moved — or by an import, or by a future OAuth link — may hold something shorter, and answering
   * that user with a `422` about the length of the password they already have tells them to fix
   * something they cannot reach. It has to reach the service and come back as "that is not your
   * password".
   */
  it('accepts a current password shorter than the floor a new one must clear', () => {
    const body = { currentPassword: 'short', newPassword: STRONG };

    expect(changePasswordRequestSchema.safeParse(body).success).toBe(true);
  });

  it('refuses an empty current password rather than spending an Argon2id verify on nothing', () => {
    const body = { currentPassword: '', newPassword: STRONG };

    expect(changePasswordRequestSchema.safeParse(body).success).toBe(false);
  });

  /** The field is fed to Argon2id, so an unbounded one is unbounded work an authenticated caller asks for. */
  it('refuses a current password past the ceiling', () => {
    const body = { currentPassword: 'a'.repeat(PASSWORD_MAX_LENGTH + 1), newPassword: STRONG };

    expect(changePasswordRequestSchema.safeParse(body).success).toBe(false);
  });

  it('holds the new password to the length floor every chosen password clears', () => {
    const body = { currentPassword: STRONG, newPassword: 'a'.repeat(PASSWORD_MIN_LENGTH - 1) };

    expect(changePasswordRequestSchema.safeParse(body).success).toBe(false);
  });

  it('refuses a field the endpoint does not read', () => {
    const body = { currentPassword: STRONG, email: 'ada@example.com', newPassword: STRONG };

    expect(changePasswordRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('changePasswordResponseSchema', () => {
  it('accepts the one body a changed password answers with', () => {
    expect(changePasswordResponseSchema.parse({ status: PASSWORD_CHANGED })).toEqual({
      status: PASSWORD_CHANGED,
    });
  });

  /**
   * The count of sessions that died is the sort of member that looks helpful and is not: it is a
   * device inventory handed to whoever holds the session, and §11 revokes the others whether or not
   * the response says how many.
   */
  it('refuses a body reporting how many sessions were revoked', () => {
    const leaky = { revokedSessions: 3, status: PASSWORD_CHANGED };

    expect(changePasswordResponseSchema.safeParse(leaky).success).toBe(false);
  });
});

describe('requestPasswordResetRequestSchema', () => {
  it('normalises the address, so a pasted spelling reaches the citext column as one mailbox', () => {
    expect(requestPasswordResetRequestSchema.parse({ email: '  Ada@Example.COM ' })).toEqual({
      email: 'ada@example.com',
    });
  });

  it('refuses a field the endpoint does not read', () => {
    const body = { email: 'ada@example.com', token: TOKEN };

    expect(requestPasswordResetRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('requestPasswordResetResponseSchema', () => {
  /**
   * Criterion 7's first half, expressed as a type. A known address and an unknown one get these
   * bytes and no others, so there is no member for a later task to add that could differ between
   * them — `strictObject` with a literal is what makes a well-meant `{ sent: true }` a failing test
   * here rather than an account enumerator in production.
   */
  it('accepts the one body every address gets', () => {
    expect(requestPasswordResetResponseSchema.parse({ status: PASSWORD_RESET_REQUESTED })).toEqual({
      status: PASSWORD_RESET_REQUESTED,
    });
  });

  it('refuses a body reporting whether an account was found', () => {
    const leaky = { accountExists: true, status: PASSWORD_RESET_REQUESTED };

    expect(requestPasswordResetResponseSchema.safeParse(leaky).success).toBe(false);
  });

  it('refuses a body reporting whether a mail went out', () => {
    const leaky = { sent: false, status: PASSWORD_RESET_REQUESTED };

    expect(requestPasswordResetResponseSchema.safeParse(leaky).success).toBe(false);
  });
});

describe('resetPasswordRequestSchema', () => {
  it('accepts the token from the link and the password being chosen', () => {
    const body = { password: STRONG, token: TOKEN };

    expect(resetPasswordRequestSchema.parse(body)).toEqual(body);
  });

  /** Same reason `verifyEmailRequestSchema` accepts a short one: a truncated link is not a `422`. */
  it('accepts a short token, leaving "is this a real token" to the service', () => {
    expect(resetPasswordRequestSchema.safeParse({ password: STRONG, token: 'F3s7NRy8' }).success) //
      .toBe(true);
  });

  it('refuses an empty token', () => {
    expect(resetPasswordRequestSchema.safeParse({ password: STRONG, token: '' }).success).toBe(
      false,
    );
  });

  it('holds the chosen password to the same floor every chosen password clears', () => {
    const body = { password: 'a'.repeat(PASSWORD_MIN_LENGTH - 1), token: TOKEN };

    expect(resetPasswordRequestSchema.safeParse(body).success).toBe(false);
  });

  /**
   * An address here would be accepted and ignored — the token names the account — and an endpoint
   * that takes a field it does not read is one whose callers come to believe it is being checked.
   */
  it('refuses a field the endpoint does not read', () => {
    const body = { email: 'ada@example.com', password: STRONG, token: TOKEN };

    expect(resetPasswordRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('resetPasswordResponseSchema', () => {
  it('accepts the one body a completed reset answers with', () => {
    expect(resetPasswordResponseSchema.parse({ status: PASSWORD_RESET })).toEqual({
      status: PASSWORD_RESET,
    });
  });

  /**
   * No session, no cookie, no user. Consuming a reset token revokes every session (§11) — a
   * response that established a new one would hand a session to whoever holds the link, which is
   * the person the revocation exists to lock out when the link was requested by an attacker.
   */
  it('refuses a body carrying a session token back', () => {
    const leaky = { session: TOKEN, status: PASSWORD_RESET };

    expect(resetPasswordResponseSchema.safeParse(leaky).success).toBe(false);
  });
});

describe('the three status constants', () => {
  /** Distinct, because a client branches on them and two flows answering the same word cannot be told apart. */
  it('are distinct from one another', () => {
    expect(new Set([PASSWORD_CHANGED, PASSWORD_RESET, PASSWORD_RESET_REQUESTED]).size).toBe(3);
  });
});
