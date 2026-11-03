import { z } from 'zod';

import { emailSchema } from '../common/email';
import { nextPathSchema } from './signup';

/**
 * The ceiling on a presented token, and the only thing this contract asserts about its shape.
 *
 * There is deliberately no floor and no character class. A 32-byte mint is 43 base64url characters
 * and nothing else ever will be, so a length check would be free — but it would answer a link a mail
 * client wrapped, or a user pasted half of, with a `422` about a string, when the actionable answer
 * is the `token-invalid` slug the service already has for "this is not a token we know". One broken
 * link, one response.
 *
 * The ceiling stays, because the field is an unauthenticated caller's handle on a database lookup
 * and a SHA-256 of whatever they send. Generous enough that no real link is refused.
 */
export const VERIFICATION_TOKEN_MAX_LENGTH = 256;

/**
 * The value in a `?token=` link, as presented. Shared by `POST /auth/verify` and — once T19 and T29
 * land — by password reset and invitation acceptance, which mint theirs from the same primitive.
 */
export const verificationTokenSchema = z
  .string()
  .trim()
  .min(1)
  .max(VERIFICATION_TOKEN_MAX_LENGTH)
  .meta({ description: 'The token from the verification link. Single use, hashed at rest.' });

/**
 * `POST /api/v1/auth/verify`.
 *
 * `strictObject`, so a client sending `{ email, token }` is refused rather than quietly verified
 * against the token alone — an endpoint that accepts and ignores an address is one whose callers
 * come to believe the address is being checked.
 */
export const verifyEmailRequestSchema = z.strictObject({ token: verificationTokenSchema });

export type VerifyEmailRequest = z.output<typeof verifyEmailRequestSchema>;

/** The one thing a confirmed address is told. `strictObject` keeps it that way. */
export const EMAIL_VERIFIED = 'verified';

/**
 * What a successful confirmation answers with.
 *
 * No token, because the token was the credential in the request and echoing a credential puts it in
 * every client log and browser history entry the response reaches. No address and no user id
 * either: the caller of this endpoint is whoever holds a link, which is not the same as whoever
 * holds the account, and the response should not turn the one into a reader of the other.
 */
export const verifyEmailResponseSchema = z.strictObject({ status: z.literal(EMAIL_VERIFIED) });

export type VerifyEmailResponse = z.output<typeof verifyEmailResponseSchema>;

/** `POST /api/v1/auth/verify/resend`. One field, and the same normalisation signup applies. */
export const resendVerificationRequestSchema = z.strictObject({
  email: emailSchema,
  /** Spec 031: the return address sign-up carried, carried again (see `nextPathSchema`). */
  next: nextPathSchema.optional(),
});

export type ResendVerificationRequest = z.output<typeof resendVerificationRequestSchema>;

/**
 * The only thing a resend request ever says — the same constant signup answers with, and
 * deliberately the same word.
 *
 * An address with no account, an address already verified and an address genuinely awaiting a link
 * all get this. Signup is enumeration-safe (ADR 007), and an endpoint that answered "no such
 * account" here would hand back through a second route exactly what the first one withholds.
 */
export const VERIFICATION_RESEND_ACCEPTED = 'pending-verification';

/**
 * The absence of every useful member is the enumeration-safety property expressed as a type: no
 * `sent`, no `expiresAt`, no address. `strictObject` with a literal is what makes a later task's
 * well-meant `{ sent: false }` a failing test here rather than an account enumerator in production.
 */
export const resendVerificationResponseSchema = z.strictObject({
  status: z.literal(VERIFICATION_RESEND_ACCEPTED),
});

export type ResendVerificationResponse = z.output<typeof resendVerificationResponseSchema>;
