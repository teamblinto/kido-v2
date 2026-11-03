import { z } from 'zod';

import { emailSchema } from '../common/email';
import { passwordSchema } from '../common/password';

/**
 * `POST /api/v1/auth/signup`.
 *
 * `passwordSchema` rather than the login contract's `presentedPasswordSchema`: a password is being
 * *chosen* here, so the ASVS length floor applies. The checks §11 actually cares about — the zxcvbn
 * floor, the k-anonymity breach lookup, and rejecting a password derived from the user's own
 * address — are not decidable from this field alone and live in `identity/password/`.
 *
 * `strictObject`, so a field the endpoint does not read is a `422` rather than something silently
 * ignored. That matters more here than on most endpoints: an `organisationName` accepted and
 * dropped would look exactly like a working feature to the client that sent it (ADR 007).
 */
/**
 * Spec 031 (research R7): where to go once the account is verified — the page that sent the visitor
 * to sign up, such as a project invitation. A same-origin relative path only: it starts with one
 * `/`, never `//` or `/\` (both read as protocol-relative by a browser), and carries no control
 * characters, so the link can never leave the app.
 */
export function isSameOriginRelativePath(value: string): boolean {
  return (
    value.length <= 2048 &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export const nextPathSchema = z
  .string()
  .refine(isSameOriginRelativePath, { error: 'Must be a relative path within the app.' });

export const signupRequestSchema = z.strictObject({
  email: emailSchema,
  next: nextPathSchema.optional(),
  password: passwordSchema,
});

export type SignupRequest = z.output<typeof signupRequestSchema>;

/**
 * The only thing signup ever says. A constant, and that is the entire design.
 *
 * "Accepted" rather than "created" because the caller is not told which happened. An address with
 * no account gets one; an address that already has one gets a mail instead (ADR 007), and the two
 * answers are the same bytes.
 */
export const SIGNUP_ACCEPTED = 'pending-verification';

/**
 * What signup answers with, for both branches, always.
 *
 * The absence of every useful member is the enumeration-safety property expressed as a type. There
 * is no user id and no address, because the existing-address branch created nothing and has
 * neither to report — and no session, because a cookie on one branch and not the other is a
 * perfect oracle regardless of what the body says. A caller signs in afterwards like anyone else.
 *
 * `strictObject` with a literal is what makes a later task's well-meant `{ userId }` a failing
 * test here rather than an account enumerator in production.
 */
export const signupResponseSchema = z.strictObject({
  status: z.literal(SIGNUP_ACCEPTED),
});

export type SignupResponse = z.output<typeof signupResponseSchema>;
