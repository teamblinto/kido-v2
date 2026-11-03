/**
 * The one source of "now" for anything that decides an outcome from the time.
 *
 * Spec 001 makes this a rule rather than a convenience: **no `new Date()` inside a service**. Token
 * expiry, throttle windows, session TTL, TOTP drift and idempotency replay all compare an instant
 * against a stored one, and a test that cannot move the clock has to either sleep — which makes the
 * suite slow and flaky — or assert a tolerance, which is how an off-by-an-hour bug survives.
 *
 * One method, deliberately. A port with `now()` and a parallel `nowMs()` has two states that an
 * implementation can get out of step, and `now().getTime()` costs nothing at the call site.
 */
export interface ClockPort {
  /** The current instant, as a fresh `Date` the caller may keep or mutate. */
  now(): Date;
}

/**
 * The injection token, beside the interface rather than in a `*.constants.ts`, because this folder
 * has exactly one. A symbol for the reason `database.constants.ts` gives: a string token collides
 * silently with any other package that reaches for the same word.
 */
export const CLOCK = Symbol('forge.clock');
