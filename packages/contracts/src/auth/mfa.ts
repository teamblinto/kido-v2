import { z } from 'zod';

import { signedInResponseSchema } from './login';

/**
 * The ceiling on a presented second factor, and the only thing this contract asserts about it.
 *
 * Deliberately loose enough to hold both things the field carries: six digits from an authenticator
 * app, and a recovery code. There is no `/^\d{6}$/` here on purpose — a regex would answer a
 * recovery code with a `422` about a string, and would bake the digit count into the wire format,
 * where changing it later becomes a breaking change rather than a configuration value.
 *
 * The ceiling stays, because every presented code costs the server a verification: a TOTP validation
 * across the drift window, or up to ten Argon2id comparisons against the account's recovery codes.
 */
export const MFA_CODE_MAX_LENGTH = 32;

/** Criterion 8's number, published so a client can render exactly the grid it is about to get. */
export const RECOVERY_CODE_COUNT = 10;

/**
 * A second factor as presented — a TOTP code or a recovery code, in one field.
 *
 * One field rather than two, because which one the caller typed is not something the API should
 * publish. Separate `code` and `recoveryCode` members would let anyone watching a client tell "this
 * account still has working TOTP" from "this account is down to its recovery codes", and there is
 * nothing a legitimate client does with that distinction that it cannot do with this.
 *
 * Trimmed, because an authenticator app renders `012 345` and a user types what they see.
 */
export const mfaCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(MFA_CODE_MAX_LENGTH)
  .meta({ description: 'A TOTP code or a one-time recovery code. Never stored as presented.' });

/**
 * `POST /api/v1/auth/mfa/totp`.
 *
 * The one member is the `otpauth://` URI a QR renderer takes, and it is `strictObject` for a reason
 * worth stating: that URI *contains* the seed, because RFC 6238 enrolment has no other way to move a
 * shared secret to a phone. That single, one-time rendering is the whole of the seed's exposure. A
 * `secret` member beside it would be the same bytes in a shape a client is far likelier to log,
 * cache or echo — so the schema refuses one, and the refusal is a failing test rather than a review
 * comment somebody has to remember to make.
 *
 * There is no `recoveryCodes` here either. Enrolment is not active until it is confirmed, and codes
 * issued at this step would be codes for an enrolment that may never complete.
 */
export const beginTotpEnrolmentResponseSchema = z.strictObject({
  otpauthUri: z.string().startsWith('otpauth://totp/').meta({
    description: 'The provisioning URI to render as a QR code. Shown once, never re-read.',
  }),
});

export type BeginTotpEnrolmentResponse = z.output<typeof beginTotpEnrolmentResponseSchema>;

/**
 * `POST /api/v1/auth/mfa/totp/confirm` — the step that makes an enrolment real.
 *
 * `strictObject` with one field. The seed is not the client's to send: it is confirmed against the
 * pending one the server minted and is holding, and a body that could carry a seed would let a
 * caller enrol one somebody else already knows.
 */
export const confirmTotpEnrolmentRequestSchema = z.strictObject({ code: mfaCodeSchema });

export type ConfirmTotpEnrolmentRequest = z.output<typeof confirmTotpEnrolmentRequestSchema>;

/**
 * The one response in this API that legitimately carries secrets, and the last time these ones are
 * ever readable.
 *
 * `.length(RECOVERY_CODE_COUNT)` rather than a bare array: criterion 8 says ten, and a generator
 * that emitted nine would otherwise be a silent halving of somebody's recovery budget that no other
 * test in the suite would notice.
 */
export const confirmTotpEnrolmentResponseSchema = z.strictObject({
  recoveryCodes: z
    .array(z.string().min(1))
    .length(RECOVERY_CODE_COUNT)
    .meta({ description: 'One-time codes, hashed at rest. Displayed here and never again.' }),
});

export type ConfirmTotpEnrolmentResponse = z.output<typeof confirmTotpEnrolmentResponseSchema>;

/**
 * `POST /api/v1/auth/mfa/challenge` — the second leg of a sign-in that answered `mfa_required`.
 *
 * The code and nothing else. Which account is being challenged comes from the pending-MFA cookie the
 * login leg set, never from the body: an endpoint that took a user id would let anyone who holds a
 * stolen TOTP code complete somebody else's challenge.
 */
export const mfaChallengeRequestSchema = z.strictObject({ code: mfaCodeSchema });

export type MfaChallengeRequest = z.output<typeof mfaChallengeRequestSchema>;

/**
 * What completing the challenge answers with — byte for byte what a sign-in without MFA answers
 * with, so a client has one success shape to parse and the session token stays in the cookie.
 */
export const mfaChallengeResponseSchema = signedInResponseSchema;

export type MfaChallengeResponse = z.output<typeof mfaChallengeResponseSchema>;

/** `POST /api/v1/auth/mfa/step-up`. Same single field, for the same reason. */
export const stepUpRequestSchema = z.strictObject({ code: mfaCodeSchema });

export type StepUpRequest = z.output<typeof stepUpRequestSchema>;

/** The only thing a successful step-up says. */
export const MFA_STEPPED_UP = 'stepped-up';

/**
 * `strictObject` with a literal, and deliberately no `expiresAt`.
 *
 * The step-up window is the server's. A client that could read it would schedule against it, which
 * turns a re-authentication into a countdown the user is racing; the `step-up-required` problem type
 * on the next sensitive call is the whole of the protocol a client needs.
 */
export const stepUpResponseSchema = z.strictObject({ status: z.literal(MFA_STEPPED_UP) });

export type StepUpResponse = z.output<typeof stepUpResponseSchema>;

/** The only thing turning MFA off says. */
export const MFA_DISABLED = 'mfa-disabled';

/**
 * `DELETE /api/v1/auth/mfa/totp` (criterion 12). No count of the recovery codes it burned and no
 * timestamp — the caller asked for MFA to be off, and it is.
 */
export const disableMfaResponseSchema = z.strictObject({ status: z.literal(MFA_DISABLED) });

export type DisableMfaResponse = z.output<typeof disableMfaResponseSchema>;
