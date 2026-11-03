import { DomainError } from '../../common/errors/domain-error';

/**
 * The part of an account this rule reads. Structural rather than `User`, so a caller holding a
 * projection — a session lookup that selected three columns, a join — can be asked the question
 * without loading the row again.
 */
export interface EmailVerifiable {
  readonly emailVerifiedAt: Date | null;
}

/**
 * §11: "Account is usable immediately but unverified accounts cannot create sandboxes."
 *
 * This is that rule, in one place, and the reason it exists before anything enforces it. Sandboxes
 * are a later phase, so the obvious alternative is to write the check when the first caller needs
 * it — by which time there are several callers, each spelling it as
 * `user.emailVerifiedAt !== null` inline. That is how a rule ends up with an exception nobody
 * decided on: one of those spellings will eventually be `!= null`, or will be written against a
 * column that a projection left undefined, and it will read as correct in review.
 *
 * The predicate is deliberately "is there a timestamp", not "is it in the past". T14 writes the
 * column from the injected clock at the moment the link is used; a value in the future would mean
 * the clock moved backwards, and locking a verified user out of their own account over that is a
 * worse failure than the one it would be guarding against.
 */
export function isEmailVerified(account: EmailVerifiable): boolean {
  return account.emailVerifiedAt !== null;
}

/**
 * The refusal, under a slug of its own so the client can offer the one action that resolves it.
 *
 * `capability` is the thing that was refused, phrased as a verb the user would recognise — "create
 * a sandbox". It is in the detail rather than in a second error class because the alternative is a
 * class per capability, and the first one written in a hurry will say "forbidden" instead.
 */
export class EmailNotVerifiedError extends DomainError {
  constructor(capability: string) {
    super(
      'email-not-verified',
      `Confirm your email address before you ${capability}. Check your mail for the link.`,
      { capability },
    );
  }
}

/** {@link isEmailVerified} as a gate. Returns silently, or throws the refusal. */
export function requireEmailVerified(account: EmailVerifiable, capability: string): void {
  if (!isEmailVerified(account)) {
    throw new EmailNotVerifiedError(capability);
  }
}
