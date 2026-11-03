import { describe, expect, it } from 'vitest';

import {
  EMAIL_VERIFIED,
  VERIFICATION_RESEND_ACCEPTED,
  VERIFICATION_TOKEN_MAX_LENGTH,
  resendVerificationRequestSchema,
  resendVerificationResponseSchema,
  verifyEmailRequestSchema,
  verifyEmailResponseSchema,
} from './verify';

/** 32 bytes of `randomBytes` in base64url: 43 characters, no padding. What the mail actually links. */
const TOKEN = 'F3s7NRy8Sk8ZBxSEqQqK0F4Zj-Zw6vMzBu1t2cN9xkQ';

describe('verifyEmailRequestSchema', () => {
  it('accepts the 43-character token a 32-byte mint produces', () => {
    expect(verifyEmailRequestSchema.parse({ token: TOKEN })).toEqual({ token: TOKEN });
  });

  /**
   * A truncated link is the single most common way this endpoint is called wrongly — mail clients
   * wrap long URLs, and users paste half of one. It must reach the service and come back as the
   * "this link is not a token we know" slug, not as a `422` about a string length: the two are the
   * same problem to the reader and only one of them tells them what to do about it.
   */
  it('accepts a short token, leaving "is this a real token" to the service', () => {
    expect(verifyEmailRequestSchema.safeParse({ token: 'F3s7NRy8' }).success).toBe(true);
  });

  it('refuses an empty token rather than sending a lookup for nothing', () => {
    expect(verifyEmailRequestSchema.safeParse({ token: '' }).success).toBe(false);
  });

  /** The ceiling is the whole point of having one: an unauthenticated caller bounds our work. */
  it('refuses a token past the length ceiling', () => {
    const long = 'a'.repeat(VERIFICATION_TOKEN_MAX_LENGTH + 1);

    expect(verifyEmailRequestSchema.safeParse({ token: long }).success).toBe(false);
  });

  it('refuses a field the endpoint does not read', () => {
    expect(verifyEmailRequestSchema.safeParse({ email: 'ada@example.com', token: TOKEN }).success) //
      .toBe(false);
  });
});

describe('verifyEmailResponseSchema', () => {
  it('accepts the one body a confirmed address answers with', () => {
    expect(verifyEmailResponseSchema.parse({ status: EMAIL_VERIFIED })).toEqual({
      status: EMAIL_VERIFIED,
    });
  });

  /**
   * The token is the credential in this request, and a response that echoed it would put it in
   * every client log, error report and browser history entry the response reaches.
   */
  it('refuses a body echoing the token back', () => {
    expect(verifyEmailResponseSchema.safeParse({ status: EMAIL_VERIFIED, token: TOKEN }).success) //
      .toBe(false);
  });
});

describe('resendVerificationRequestSchema', () => {
  it('normalises the address, so a pasted spelling reaches the citext column as one mailbox', () => {
    expect(resendVerificationRequestSchema.parse({ email: '  Ada@Example.COM ' })).toEqual({
      email: 'ada@example.com',
    });
  });

  it('refuses a field the endpoint does not read', () => {
    const body = { email: 'ada@example.com', token: TOKEN };

    expect(resendVerificationRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('resendVerificationResponseSchema', () => {
  /**
   * The same enumeration-safety property `signupResponseSchema` documents, and for the same reason:
   * an address with no account, one already verified and one awaiting a link all get these bytes.
   * A member that varied with which of the three it was would be the oracle signup declines to be,
   * reachable through a second endpoint.
   */
  it('accepts the one body every address gets', () => {
    expect(
      resendVerificationResponseSchema.parse({ status: VERIFICATION_RESEND_ACCEPTED }),
    ).toEqual({ status: VERIFICATION_RESEND_ACCEPTED });
  });

  it('refuses a body reporting whether anything was sent', () => {
    const leaky = { sent: true, status: VERIFICATION_RESEND_ACCEPTED };

    expect(resendVerificationResponseSchema.safeParse(leaky).success).toBe(false);
  });
});
