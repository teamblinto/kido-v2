import { z } from 'zod';

import { emailSchema } from '../common/email';
import { PASSWORD_MAX_LENGTH, passwordSchema } from '../common/password';
import { verificationTokenSchema } from './verify';

/**
 * A password being *presented*, not chosen — the one the caller claims is already theirs.
 *
 * Deliberately not {@link passwordSchema}. That schema carries `PASSWORD_MIN_LENGTH`, which is a
 * floor on what may be chosen from now on; the password an account already holds may predate it, or
 * have arrived through an import. Refusing a short one here answers "your current password is too
 * short" to somebody who is trying to replace exactly that, and does it before anything has checked
 * whether they even typed the right one.
 *
 * The ceiling is the same, and for the reason `common/password.ts` gives: this value is fed to
 * Argon2id at 64 MB, so an unbounded field is an unbounded amount of hashing a caller can ask for.
 * The floor is one character, which is not a policy — it is the point below which there is nothing
 * to verify.
 */
export const currentPasswordSchema = z
  .string()
  .min(1)
  .max(PASSWORD_MAX_LENGTH)
  .meta({ description: 'The password the account currently has. Verified, never stored.' });

/**
 * `POST /api/v1/auth/password/change` (§11, criterion 7).
 *
 * `strictObject`, so a client sending an `email` beside the two passwords is refused rather than
 * quietly changing the signed-in account's password while appearing to name another one.
 */
export const changePasswordRequestSchema = z.strictObject({
  currentPassword: currentPasswordSchema,
  newPassword: passwordSchema,
});

export type ChangePasswordRequest = z.output<typeof changePasswordRequestSchema>;

export const PASSWORD_CHANGED = 'password-changed';

/**
 * What a completed change answers with, and nothing else.
 *
 * In particular no count of the sessions that were revoked. §11 revokes every *other* session here
 * whether or not the response mentions it, and a number that varies with how many devices the
 * account has is a device inventory published to whoever holds the session — including an attacker
 * who has just been handed the password.
 */
export const changePasswordResponseSchema = z.strictObject({
  status: z.literal(PASSWORD_CHANGED),
});

export type ChangePasswordResponse = z.output<typeof changePasswordResponseSchema>;

/** `POST /api/v1/auth/password/reset`. One address, normalised exactly as signup normalises it. */
export const requestPasswordResetRequestSchema = z.strictObject({ email: emailSchema });

export type RequestPasswordResetRequest = z.output<typeof requestPasswordResetRequestSchema>;

/**
 * The only thing a reset request ever says.
 *
 * An address with an account and one with none resolve the same way and answer the same bytes —
 * criterion 7's first half, and the same stance ADR 007 takes for signup. The word is "requested"
 * rather than "sent" on purpose: whether a mail went out is precisely the fact being withheld, and
 * a constant that claimed delivery would be a lie on one of the two branches.
 */
export const PASSWORD_RESET_REQUESTED = 'password-reset-requested';

/**
 * The absence of every useful member is the enumeration-safety property expressed as a type. There
 * is no `sent`, no `accountExists` and no `expiresAt` — the last of which would leak nothing on its
 * own but would have to be absent on the branch where no token was minted, which is the same oracle
 * with an extra step.
 */
export const requestPasswordResetResponseSchema = z.strictObject({
  status: z.literal(PASSWORD_RESET_REQUESTED),
});

export type RequestPasswordResetResponse = z.output<typeof requestPasswordResetResponseSchema>;

/**
 * `POST /api/v1/auth/password/reset/confirm` — spending the link.
 *
 * The token is shared with `POST /auth/verify` via {@link verificationTokenSchema}: both are minted
 * by the same primitive, and a length ceiling that disagreed between the two would refuse one flow's
 * links and accept the other's. No address: the token names the account, and a body that also
 * carried one would be a field the endpoint accepts and ignores.
 */
export const resetPasswordRequestSchema = z.strictObject({
  password: passwordSchema,
  token: verificationTokenSchema,
});

export type ResetPasswordRequest = z.output<typeof resetPasswordRequestSchema>;

export const PASSWORD_RESET = 'password-reset';

/**
 * What a completed reset answers with.
 *
 * Note what it cannot carry: a session. Consuming a reset token revokes **every** session (§11), and
 * an endpoint that signed the caller straight back in would hand a live session to whoever presented
 * the link — which is the person the wholesale revocation exists to lock out in the case where they
 * were not the account's owner. The caller signs in afterwards, with the password they just chose,
 * like anybody else.
 */
export const resetPasswordResponseSchema = z.strictObject({ status: z.literal(PASSWORD_RESET) });

export type ResetPasswordResponse = z.output<typeof resetPasswordResponseSchema>;
