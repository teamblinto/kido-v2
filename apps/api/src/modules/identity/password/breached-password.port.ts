import { DomainError } from '../../../common/errors/domain-error';

/**
 * "Has this password appeared in a public breach corpus?"
 *
 * The answer is a plain boolean, and that is a decision rather than an omission. The check **fails
 * open** (ADR 008): a corpus we cannot reach answers `false`, because a third party's availability
 * must not become our signup availability. Returning a three-way outcome instead would push that
 * decision to every call site, where the obvious-looking `if (outcome !== 'clean') reject` would
 * quietly turn an HIBP outage into an outage of our own. An adapter that cannot answer says so in a
 * log line and a counter, not in a value the caller has to remember to interpret.
 *
 * The zxcvbn floor and Argon2id are unaffected by any of this and still apply.
 */
export interface BreachedPasswordPort {
  isBreached(password: string): Promise<boolean>;
}

/** Symbol for the reason `database.constants.ts` gives: a string token collides silently. */
export const BREACHED_PASSWORD_PORT = Symbol('forge.identity.breachedPasswordPort');

/**
 * The rejection a caller throws when the port answers `true`. Distinct from `password-too-weak`:
 * this password may be long and unguessable and is still unusable, and "make it longer" is the
 * wrong advice — the only fix is a different password.
 */
export class BreachedPasswordError extends DomainError {
  constructor() {
    super(
      'password-breached',
      'This password has appeared in a public data breach and cannot be used here.',
    );
  }
}
