/**
 * The arithmetic behind "throttled, not locked out".
 *
 * Everything here is a pure function of a stored record and an instant. No clock, no Redis, no
 * injection: `redis-throttler.storage.ts` supplies both, and the policy that decides whether an
 * attempt is refused stays something a test can drive through five hundred failures in a
 * millisecond (spec 001 makes this a TDD-first module for that reason).
 *
 * Three properties make it a delay rather than a lock, and each one is asserted next door:
 *
 * The delay has a **ceiling**. Doubling from two seconds is a fine deterrent for the first minute
 * and an unbounded one after twenty failures, and an unbounded delay against a known address is a
 * denial-of-service vector rather than a rate limit.
 *
 * The count **decays**. One failure is forgiven per decay interval of quiet, so an account walks
 * back to untouched on its own — nobody has to clear anything, and no operator is in the loop.
 *
 * The stored count has a **ceiling of its own**, which is the half that is easy to miss. The delay
 * is already capped, so failures past the cap change nothing an attacker can see — but each one
 * still has to decay, so without a bound on the count, an attacker attempting once per capped delay
 * drives the victim's recovery time up for as long as they care to keep going. Bounding the count
 * bounds the recovery: {@link maxRecoverySeconds} is a fixed number of seconds, whatever history
 * the record has.
 */

/** The knobs one bucket is tuned with. Accounts and addresses get different values, not different code. */
export interface ThrottlePolicy {
  /** Failures allowed before any delay at all — a mistyped password is not an attack. */
  readonly burst: number;
  /** Seconds of quiet that forgive one recorded failure. */
  readonly decaySeconds: number;
  /** The delay the first failure past the burst earns. Doubles from there. */
  readonly firstDelaySeconds: number;
  /** The delay ceiling: the longest any caller is ever asked to wait. */
  readonly maxDelaySeconds: number;
}

/** What the store holds for one account or one address. Two numbers, so it survives as a Redis hash. */
export interface ThrottleState {
  readonly failures: number;
  /** Epoch milliseconds, from {@link ClockPort} at the call site — never `Date.now()` here. */
  readonly lastFailureAt: number;
}

export interface ThrottleDecision {
  readonly allowed: boolean;
  /** The count after decay, which is what a subsequent {@link penalise} counts up from. */
  readonly failures: number;
  /** Whole seconds, for the `Retry-After` header. Zero exactly when the attempt is allowed. */
  readonly retryAfterSeconds: number;
}

/**
 * How many doublings separate the first delay from the ceiling. Beyond this the delay is the
 * ceiling, so the exponent is clamped here rather than after the exponentiation — `2 ** 1000` is
 * `Infinity`, and `Infinity` seconds is the lock this module exists to make impossible.
 */
function stepsToCeiling(policy: ThrottlePolicy): number {
  return Math.max(0, Math.ceil(Math.log2(policy.maxDelaySeconds / policy.firstDelaySeconds)));
}

/**
 * The largest failure count worth storing: the one at which the delay first reaches the ceiling.
 * Counting past it lengthens recovery without lengthening the delay, which is a cost to the account
 * holder and nothing to an attacker.
 */
export function failureCeiling(policy: ThrottlePolicy): number {
  assertPolicy(policy);

  return policy.burst + stepsToCeiling(policy) + 1;
}

/**
 * The longest an account can ever need to be left alone before its record is gone — the number that
 * makes "never a permanent lock" checkable rather than aspirational. A successful sign-in clears
 * the record outright, so this is the bound on the *pessimistic* path, where nobody ever succeeds.
 */
export function maxRecoverySeconds(policy: ThrottlePolicy): number {
  return failureCeiling(policy) * policy.decaySeconds;
}

/** The delay a given number of failures has earned, in seconds. */
export function delaySecondsFor(failures: number, policy: ThrottlePolicy): number {
  assertPolicy(policy);

  if (failures <= policy.burst) {
    return 0;
  }

  const steps = Math.min(failures - policy.burst - 1, stepsToCeiling(policy));

  return Math.min(policy.firstDelaySeconds * 2 ** steps, policy.maxDelaySeconds);
}

/** What the record's count has decayed to by `nowMs`. */
export function decayedFailures(
  state: ThrottleState,
  nowMs: number,
  policy: ThrottlePolicy,
): number {
  assertPolicy(policy);

  // Clamped at zero: a clock that has gone backwards — skew between two API nodes, an NTP step —
  // is not a reason to forgive failures, and an unclamped elapsed time would *add* them.
  const elapsedSeconds = Math.max(0, (nowMs - state.lastFailureAt) / 1_000);
  const forgiven = Math.floor(elapsedSeconds / policy.decaySeconds);

  return Math.max(0, state.failures - forgiven);
}

/** Whether an attempt may proceed, and how long it must wait if not. */
export function evaluate(
  state: ThrottleState | null,
  nowMs: number,
  policy: ThrottlePolicy,
): ThrottleDecision {
  assertPolicy(policy);

  if (state === null) {
    return { allowed: true, failures: 0, retryAfterSeconds: 0 };
  }

  const failures = decayedFailures(state, nowMs, policy);
  const releasesAt = state.lastFailureAt + delaySecondsFor(failures, policy) * 1_000;
  const remainingMs = releasesAt - nowMs;

  if (remainingMs <= 0) {
    return { allowed: true, failures, retryAfterSeconds: 0 };
  }

  // Rounded up, because `Retry-After: 0` tells a client to try again immediately and a client that
  // does is refused again — which looks like a broken endpoint rather than a throttle.
  return { allowed: false, failures, retryAfterSeconds: Math.ceil(remainingMs / 1_000) };
}

/**
 * The record after one more failed attempt.
 *
 * Counting up from the decayed number rather than the stored one is what stops the counter
 * ratcheting: otherwise an hour of an attacker's noise leaves a residue the account never sheds.
 */
export function penalise(
  state: ThrottleState | null,
  nowMs: number,
  policy: ThrottlePolicy,
): ThrottleState {
  assertPolicy(policy);

  const current = state === null ? 0 : decayedFailures(state, nowMs, policy);

  return {
    failures: Math.min(current + 1, failureCeiling(policy)),
    lastFailureAt: nowMs,
  };
}

/**
 * How long the store should keep a record. Long enough to outlive its own decay — expiring early
 * would forgive an attacker mid-climb — and finite, because a record that never expires is the
 * permanent lock by another route.
 */
export function retentionSeconds(state: ThrottleState, policy: ThrottlePolicy): number {
  assertPolicy(policy);

  return (Math.min(state.failures, failureCeiling(policy)) + 1) * policy.decaySeconds;
}

/**
 * A policy is read from the environment, so a nonsensical one is a deployment mistake rather than a
 * programming one — and every way of being nonsensical here fails *open*. A zero first delay never
 * grows, a ceiling below the first delay throws the doubling away, and a zero decay interval
 * divides by zero and forgives `Infinity` failures. Each would leave the endpoint unthrottled while
 * looking configured, so they are refused at the first call instead.
 */
function assertPolicy(policy: ThrottlePolicy): void {
  if (!Number.isInteger(policy.burst) || policy.burst < 0) {
    throw new RangeError(`throttle burst must be a non-negative integer, got ${policy.burst}`);
  }

  if (!(policy.firstDelaySeconds > 0)) {
    throw new RangeError(
      `throttle first delay must be positive, got ${policy.firstDelaySeconds} seconds`,
    );
  }

  if (!(policy.maxDelaySeconds >= policy.firstDelaySeconds)) {
    throw new RangeError(
      `throttle ceiling ${policy.maxDelaySeconds}s is below its first delay ` +
        `${policy.firstDelaySeconds}s, which would discard the progression`,
    );
  }

  if (!(policy.decaySeconds > 0)) {
    throw new RangeError(`throttle decay must be positive, got ${policy.decaySeconds} seconds`);
  }
}
