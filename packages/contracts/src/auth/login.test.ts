import { describe, expect, it } from 'vitest';

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../common/password';
import {
  MFA_REQUIRED,
  loginRequestSchema,
  loginResponseSchema,
  mfaRequiredResponseSchema,
  signedInResponseSchema,
} from './login';

const CREDENTIALS = { email: 'ada@example.com', password: 'correct horse battery staple' };

describe('loginRequestSchema', () => {
  it('normalises the address the same way signup did, so the row is found', () => {
    expect(loginRequestSchema.parse({ ...CREDENTIALS, email: '  Ada@Example.COM ' })).toEqual({
      ...CREDENTIALS,
      email: 'ada@example.com',
    });
  });

  /**
   * The signup policy is deliberately not applied here.
   *
   * A login form that rejects a nine-character password with "too short" answers a question the
   * caller did not ask and the endpoint must not answer: it tells them their guess was rejected
   * for its shape rather than for being wrong, and it locks out every account whose password
   * predates the policy the floor was last raised to. Length is checked where a password is
   * *chosen*, not where it is presented.
   */
  it('accepts a password the signup policy would reject', () => {
    const short = 'a'.repeat(PASSWORD_MIN_LENGTH - 1);

    expect(loginRequestSchema.safeParse({ ...CREDENTIALS, password: short }).success).toBe(true);
  });

  it('still refuses an empty password rather than spending a hash on it', () => {
    expect(loginRequestSchema.safeParse({ ...CREDENTIALS, password: '' }).success).toBe(false);
  });

  /**
   * The candidate is fed to Argon2id at 64 MB (§11), so the field is the amount of hashing work an
   * unauthenticated caller may ask for in one request. Unbounded here is unbounded there.
   */
  it('refuses a password longer than the hasher is willing to be handed', () => {
    const long = 'a'.repeat(PASSWORD_MAX_LENGTH + 1);

    expect(loginRequestSchema.safeParse({ ...CREDENTIALS, password: long }).success).toBe(false);
  });

  it('rejects a value that is not a mailbox', () => {
    expect(loginRequestSchema.safeParse({ ...CREDENTIALS, email: 'ada@' }).success).toBe(false);
  });

  it('refuses anything the endpoint does not read', () => {
    expect(
      loginRequestSchema.safeParse({
        ...CREDENTIALS,
        userId: '00000000-0000-4000-8000-000000000000',
      }).success,
    ).toBe(false);
  });
});

describe('loginResponseSchema', () => {
  const user = {
    email: 'ada@example.com',
    emailVerified: false,
    id: '3f1b1f8e-6b1a-4c1e-9d2a-2a5b8f0c1d3e',
    mfaEnabled: false,
  };

  it('describes the account that was signed in', () => {
    expect(loginResponseSchema.parse({ user })).toEqual({ user });
  });

  /**
   * Criterion 3, as a type. The token travels in `__Host-forge_session` and nowhere else, so the
   * response schema is `strict`: a field named `token` added in a later task fails to parse here
   * before it can reach a browser history entry, a client log or an error report.
   */
  it('has no room for a token', () => {
    expect(loginResponseSchema.safeParse({ token: 'anything', user }).success).toBe(false);
  });

  /**
   * Criterion 4's other branch. An account with MFA enabled is not signed in by the password leg,
   * so the response cannot describe an account — saying who the caller is before they have proved
   * it is the disclosure the challenge exists to withhold.
   */
  it('describes a challenge instead of an account when MFA is on', () => {
    expect(loginResponseSchema.parse({ status: MFA_REQUIRED })).toEqual({ status: MFA_REQUIRED });
  });

  /**
   * The two branches are disjoint, and that is the point. A body carrying both would be a login
   * that answered "you still owe me a second factor" while also handing over the account — which is
   * exactly the shape a client would read the second half of and the first half of never.
   */
  it('refuses a body that is both at once', () => {
    expect(loginResponseSchema.safeParse({ status: MFA_REQUIRED, user }).success).toBe(false);
  });

  /** No challenge id in the body: the challenge is bound to the cookie, not to a value clients hold. */
  it('refuses a challenge that names itself', () => {
    expect(
      mfaRequiredResponseSchema.safeParse({ challengeId: 'c-1', status: MFA_REQUIRED }).success,
    ).toBe(false);
  });

  it('shares one success shape with the MFA challenge', () => {
    expect(signedInResponseSchema.parse({ user })).toEqual({ user });
  });

  /**
   * Spec 003. The client offers "set up" or "remove" from this one field, so it is required rather
   * than optional: an optional boolean has three states, and a client would read the third one as
   * "off" — the wrong answer for an account that is enrolled.
   */
  it('says whether the account has a second factor, and will not guess', () => {
    const withoutTheField = { email: user.email, emailVerified: user.emailVerified, id: user.id };

    expect(signedInResponseSchema.safeParse({ user: withoutTheField }).success).toBe(false);
    expect(
      signedInResponseSchema.safeParse({ user: { ...user, mfaEnabled: 'true' } }).success,
    ).toBe(false);
  });
});
