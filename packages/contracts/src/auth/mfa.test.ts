import { describe, expect, it } from 'vitest';

import {
  MFA_CODE_MAX_LENGTH,
  MFA_DISABLED,
  MFA_STEPPED_UP,
  RECOVERY_CODE_COUNT,
  beginTotpEnrolmentResponseSchema,
  confirmTotpEnrolmentRequestSchema,
  confirmTotpEnrolmentResponseSchema,
  disableMfaResponseSchema,
  mfaChallengeRequestSchema,
  mfaCodeSchema,
  stepUpResponseSchema,
} from './mfa';

/** What `otpauth`'s `URI.stringify` produces for an issuer of "Forge" and a 20-byte seed. */
const OTPAUTH_URI =
  'otpauth://totp/Forge:ada@example.com?issuer=Forge&secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&algorithm=SHA1&digits=6&period=30';

/** Ten codes of the shape `POST /auth/mfa/totp/confirm` hands back exactly once. */
const RECOVERY_CODES = Array.from(
  { length: RECOVERY_CODE_COUNT },
  (_, index) => `abcd-efgh-${String(index).padStart(2, '0')}`,
);

describe('mfaCodeSchema', () => {
  it('accepts the six digits an authenticator app shows', () => {
    expect(mfaCodeSchema.parse('012345')).toBe('012345');
  });

  /**
   * The same field carries a recovery code, because the challenge accepts either and a client that
   * had to say which it was typing would be a client that can leak "this account is out of TOTP
   * codes" by which endpoint it called.
   */
  it('accepts a recovery code in the same field', () => {
    expect(mfaCodeSchema.parse('abcd-efgh-ij')).toBe('abcd-efgh-ij');
  });

  /**
   * A code arriving with the spaces an authenticator app renders it with is the user typing what
   * they see, not a malformed request. Trimmed here so the service compares the digits.
   */
  it('trims the whitespace a pasted code carries', () => {
    expect(mfaCodeSchema.parse('  012345  ')).toBe('012345');
  });

  it('refuses an empty code rather than spending a verification on nothing', () => {
    expect(mfaCodeSchema.safeParse('').success).toBe(false);
  });

  /** The ceiling bounds the work an unauthenticated caller can ask a constant-time compare for. */
  it('refuses a code past the length ceiling', () => {
    expect(mfaCodeSchema.safeParse('0'.repeat(MFA_CODE_MAX_LENGTH + 1)).success).toBe(false);
  });
});

describe('beginTotpEnrolmentResponseSchema', () => {
  it('accepts the otpauth URI a QR code is rendered from', () => {
    expect(beginTotpEnrolmentResponseSchema.parse({ otpauthUri: OTPAUTH_URI })).toEqual({
      otpauthUri: OTPAUTH_URI,
    });
  });

  /**
   * The URI is the *only* place the seed is ever rendered, and it is rendered once. A response that
   * also carried a bare `secret` would put the seed somewhere a client is far more likely to log,
   * store or echo than a string it hands straight to a QR renderer.
   */
  it('refuses a bare seed beside it', () => {
    expect(
      beginTotpEnrolmentResponseSchema.safeParse({
        otpauthUri: OTPAUTH_URI,
        secret: 'JBSWY3DPEHPK3PXP',
      }).success,
    ).toBe(false);
  });

  it('refuses anything that is not an otpauth URI', () => {
    expect(
      beginTotpEnrolmentResponseSchema.safeParse({ otpauthUri: 'https://forge.dev/enrol' }).success,
    ).toBe(false);
  });
});

describe('confirmTotpEnrolmentRequestSchema', () => {
  it('accepts the confirming code', () => {
    expect(confirmTotpEnrolmentRequestSchema.parse({ code: '012345' })).toEqual({ code: '012345' });
  });

  /**
   * The seed is not the client's to send back. Enrolment is confirmed against the pending seed the
   * server minted and is holding; accepting one from the body would let a caller enrol a seed of
   * their choosing — including one an attacker already knows.
   */
  it('refuses a seed the client tried to choose', () => {
    expect(
      confirmTotpEnrolmentRequestSchema.safeParse({ code: '012345', secret: 'JBSWY3DPEHPK3PXP' })
        .success,
    ).toBe(false);
  });
});

describe('confirmTotpEnrolmentResponseSchema', () => {
  it('accepts exactly ten recovery codes', () => {
    expect(confirmTotpEnrolmentResponseSchema.parse({ recoveryCodes: RECOVERY_CODES })).toEqual({
      recoveryCodes: RECOVERY_CODES,
    });
  });

  /** Criterion 8 says ten. Nine is a bug in the generator that no other test would catch. */
  it('refuses any other number of them', () => {
    expect(
      confirmTotpEnrolmentResponseSchema.safeParse({ recoveryCodes: RECOVERY_CODES.slice(1) })
        .success,
    ).toBe(false);
  });

  /**
   * Shown exactly once means shown *here* and nowhere else. A `seed` member would make the one
   * response that legitimately carries secrets carry one more that is never displayed again.
   */
  it('refuses a seed alongside the codes', () => {
    expect(
      confirmTotpEnrolmentResponseSchema.safeParse({
        recoveryCodes: RECOVERY_CODES,
        seed: 'JBSWY3DPEHPK3PXP',
      }).success,
    ).toBe(false);
  });
});

describe('mfaChallengeRequestSchema', () => {
  it('accepts the code and nothing else', () => {
    expect(mfaChallengeRequestSchema.parse({ code: '012345' })).toEqual({ code: '012345' });
  });

  /**
   * The challenge is bound to the cookie the login leg set, not to a user id in the body. A schema
   * that accepted one would be the first half of "complete anybody's challenge".
   */
  it('refuses a user id the caller tried to name', () => {
    expect(
      mfaChallengeRequestSchema.safeParse({
        code: '012345',
        userId: '0f6a9a3e-8c1e-4f6e-9c2f-6a1b0c9d8e7f',
      }).success,
    ).toBe(false);
  });
});

describe('the constant-bodied responses', () => {
  it('says only that MFA is off', () => {
    expect(disableMfaResponseSchema.parse({ status: MFA_DISABLED })).toEqual({
      status: MFA_DISABLED,
    });
  });

  it('says only that the caller stepped up', () => {
    expect(stepUpResponseSchema.parse({ status: MFA_STEPPED_UP })).toEqual({
      status: MFA_STEPPED_UP,
    });
  });

  /**
   * No `stepUpExpiresAt`. The window is the server's and a client that could read it is a client
   * that would schedule against it; the 403 with the `step-up-required` slug is the whole protocol.
   */
  it('refuses to carry the window it opened', () => {
    expect(
      stepUpResponseSchema.safeParse({
        expiresAt: '2026-08-16T10:05:00.000Z',
        status: MFA_STEPPED_UP,
      }).success,
    ).toBe(false);
  });
});
