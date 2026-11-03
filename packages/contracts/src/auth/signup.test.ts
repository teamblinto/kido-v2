import { describe, expect, it } from 'vitest';

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../common/password';
import { SIGNUP_ACCEPTED, signupRequestSchema, signupResponseSchema } from './signup';

const REGISTRATION = { email: 'ada@example.com', password: 'correct horse battery staple' };

describe('signupRequestSchema', () => {
  it('normalises the address, so a pasted spelling reaches the citext column as one mailbox', () => {
    expect(signupRequestSchema.parse({ ...REGISTRATION, email: '  Ada@Example.COM ' })).toEqual({
      ...REGISTRATION,
      email: 'ada@example.com',
    });
  });

  /**
   * The opposite of `login.ts`. A password is *chosen* here, so the ASVS floor applies — the whole
   * point of the distinction the login contract documents.
   */
  it('rejects a password below the ASVS length floor', () => {
    const short = 'a'.repeat(PASSWORD_MIN_LENGTH - 1);

    expect(signupRequestSchema.safeParse({ ...REGISTRATION, password: short }).success).toBe(false);
  });

  it('rejects a password above the hashing-work ceiling', () => {
    const long = 'a'.repeat(PASSWORD_MAX_LENGTH + 1);

    expect(signupRequestSchema.safeParse({ ...REGISTRATION, password: long }).success).toBe(false);
  });

  /** Every byte is significant: a password that survives the boundary unchanged is retypable. */
  it('leaves the password exactly as typed', () => {
    const padded = '  correct horse battery staple  ';

    expect(signupRequestSchema.parse({ ...REGISTRATION, password: padded }).password).toBe(padded);
  });

  it('refuses a field the endpoint does not read', () => {
    const body = { ...REGISTRATION, organisationName: 'Analytical Engines' };

    expect(signupRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('signupResponseSchema', () => {
  /**
   * The enumeration-safety property expressed as a type.
   *
   * The response is a constant. It cannot carry a user id, an address or a `created` flag, because
   * the existing-address path creates nothing and has none of them to report — any member that
   * varied with whether the account already existed would be the oracle this endpoint is built to
   * withhold. `strictObject` is what makes a later task's helpful `{ userId }` fail here, in a
   * test, rather than in production.
   */
  it('accepts the one body the endpoint is allowed to answer with', () => {
    expect(signupResponseSchema.parse({ status: SIGNUP_ACCEPTED })).toEqual({
      status: SIGNUP_ACCEPTED,
    });
  });

  it('refuses a body carrying anything about the account', () => {
    const leaky = { status: SIGNUP_ACCEPTED, userId: '00000000-0000-4000-8000-000000000000' };

    expect(signupResponseSchema.safeParse(leaky).success).toBe(false);
  });

  it('refuses a second status, so the body cannot vary with the branch taken', () => {
    expect(signupResponseSchema.safeParse({ status: 'created' }).success).toBe(false);
  });
});
