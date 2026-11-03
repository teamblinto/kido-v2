import { z } from 'zod';

/** OWASP ASVS 2.1.1. The zxcvbn floor §11 mandates is a strength check, not a length check. */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * ASVS 2.1.2 requires at least 64 to be *permitted*; the ceiling exists because the candidate is
 * fed to Argon2id at 64 MB (§11), so an unbounded field is an unbounded amount of hashing work an
 * unauthenticated caller gets to ask for.
 */
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Deliberately the weakest schema in this file. Every byte is significant: no trim, no case
 * folding, no normalisation — a password that survives a round trip through the boundary unchanged
 * is the only one a user can retype.
 *
 * The checks §11 actually cares about — the zxcvbn strength floor, the k-anonymity breach lookup,
 * and rejecting passwords derived from the user's own email or name — are not here, because none
 * of them are decidable from this field alone. They belong to `identity/password/`, which can see
 * the rest of the request and can reach the network.
 */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH)
  .max(PASSWORD_MAX_LENGTH)
  .meta({
    description:
      'A candidate password. Length only — strength and breach checks run server-side and reject ' +
      'separately.',
  });

export type Password = z.output<typeof passwordSchema>;
