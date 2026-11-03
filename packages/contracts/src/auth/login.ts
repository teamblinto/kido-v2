import { z } from 'zod';

import { emailSchema } from '../common/email';
import { PASSWORD_MAX_LENGTH } from '../common/password';

/**
 * A password as *presented*, which is a different thing from a password being *chosen*.
 *
 * `passwordSchema` carries the ASVS length floor, and applying it here would do two harmful things
 * at once: reject every account whose password predates the last time that floor was raised, and
 * answer a failed sign-in with "too short" — a different response for a different reason, on the
 * one endpoint whose answer must not vary with anything except whether the credentials were right.
 *
 * The ceiling stays. The candidate is fed to Argon2id at 64 MB (§11), so this field is the amount
 * of hashing work an unauthenticated caller may ask for in a single request.
 */
const presentedPasswordSchema = z.string().min(1).max(PASSWORD_MAX_LENGTH).meta({
  description: 'The password as typed. Checked against the stored hash, never against a policy.',
});

/**
 * `POST /api/v1/auth/login`.
 *
 * `strictObject`, so a field the endpoint does not read is a `422` rather than something silently
 * ignored — a client sending `remember: true` and being quietly signed in for the default window
 * is a bug that never surfaces.
 */
export const loginRequestSchema = z.strictObject({
  email: emailSchema,
  password: presentedPasswordSchema,
});

export type LoginRequest = z.output<typeof loginRequestSchema>;

/**
 * What a *completed* sign-in answers with, and the whole of it.
 *
 * `strictObject` is criterion 3 expressed as a type: the session token is written to the
 * `__Host-forge_session` cookie and appears nowhere a client could read, log or forward. A `token`
 * field added by a later task fails to parse here, in a test, rather than in a browser history
 * entry. `emailVerified` is present because an unverified account is usable but cannot create
 * sandboxes (§11), and the client has to be able to say so without a second round trip.
 * `mfaEnabled` is there for the same reason (spec 003): the account screen offers "set up" or
 * "remove" from it, and a pending, unconfirmed enrolment is not a second factor — it reports
 * `false` until the confirming code lands.
 *
 * Exported in its own right because `POST /auth/mfa/challenge` answers with exactly this. The two
 * ways to finish signing in produce one success shape, so a client has one branch to write.
 */
export const signedInResponseSchema = z.strictObject({
  user: z.strictObject({
    email: emailSchema,
    emailVerified: z.boolean(),
    id: z.uuid(),
    mfaEnabled: z.boolean(),
  }),
});

export type SignedInResponse = z.output<typeof signedInResponseSchema>;

/** The word criterion 4 names, published so a client branches on a constant rather than a string. */
export const MFA_REQUIRED = 'mfa_required';

/**
 * The other state a password leg can end in: the credentials were right and they were not enough.
 *
 * Deliberately empty apart from the marker. No challenge id — the challenge is bound to the
 * short-lived, pending-MFA cookie this response sets, and an id in the body would be a second
 * handle on it for a client to store, log or hand to the wrong tab. No account either: naming the
 * user before the second factor has been presented would answer "does this address have an account,
 * and does it have MFA" for anyone who can guess a password right.
 */
export const mfaRequiredResponseSchema = z.strictObject({ status: z.literal(MFA_REQUIRED) });

export type MfaRequiredResponse = z.output<typeof mfaRequiredResponseSchema>;

/**
 * `POST /api/v1/auth/login`, in both of the states criterion 4 allows it to end in.
 *
 * A union rather than one object with optional members, because the two states are genuinely
 * disjoint: a body carrying both a `user` and `mfa_required` would describe a session that exists
 * and does not, and an optional-member schema would accept it. Both arms are strict, so the union
 * refuses that at the contract instead of leaving a client to decide which half to believe.
 */
export const loginResponseSchema = z.union([signedInResponseSchema, mfaRequiredResponseSchema]);

export type LoginResponse = z.output<typeof loginResponseSchema>;
