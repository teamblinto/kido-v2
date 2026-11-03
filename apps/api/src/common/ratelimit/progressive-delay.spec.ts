import { describe, expect, it } from 'vitest';

import {
  type ThrottlePolicy,
  type ThrottleState,
  evaluate,
  failureCeiling,
  delaySecondsFor,
  decayedFailures,
  maxRecoverySeconds,
  penalise,
  retentionSeconds,
} from './progressive-delay';

/**
 * The policy the assertions below are written against. Small numbers, so an arithmetic slip shows
 * up as a wrong integer rather than as a plausible-looking one: five free failures, then 2 s, 4 s,
 * 8 s … up to a 64 s ceiling, with one failure forgiven every ten minutes.
 */
const POLICY: ThrottlePolicy = {
  burst: 5,
  decaySeconds: 600,
  firstDelaySeconds: 2,
  maxDelaySeconds: 64,
};

/** An arbitrary instant. Nothing here reads the host clock — every `now` is an argument. */
const T0 = Date.parse('2026-03-01T12:00:00.000Z');

const seconds = (count: number): number => count * 1_000;

function state(failures: number, lastFailureAt = T0): ThrottleState {
  return { failures, lastFailureAt };
}

describe('progressive delay', () => {
  describe('the delay a failure count earns', () => {
    it('is nothing at all while the count is inside the burst', () => {
      for (let failures = 0; failures <= POLICY.burst; failures += 1) {
        expect(delaySecondsFor(failures, POLICY)).toBe(0);
      }
    });

    it('is the first delay on the failure that leaves the burst', () => {
      expect(delaySecondsFor(POLICY.burst + 1, POLICY)).toBe(POLICY.firstDelaySeconds);
    });

    it('doubles with each further failure', () => {
      expect(delaySecondsFor(POLICY.burst + 2, POLICY)).toBe(4);
      expect(delaySecondsFor(POLICY.burst + 3, POLICY)).toBe(8);
      expect(delaySecondsFor(POLICY.burst + 4, POLICY)).toBe(16);
    });

    /**
     * The ceiling is the whole difference between a throttle and a lock. Doubling without one
     * reaches a delay measured in days after twenty failures, and a delay measured in days is a
     * lock wearing a rate limit's name — which anyone who knows the address can impose on it.
     */
    it('stops doubling at the ceiling', () => {
      expect(delaySecondsFor(POLICY.burst + 6, POLICY)).toBe(POLICY.maxDelaySeconds);
      expect(delaySecondsFor(POLICY.burst + 7, POLICY)).toBe(POLICY.maxDelaySeconds);
    });

    /**
     * `2 ** 1000` is `Infinity`, and `Infinity` seconds is the permanent lock this task exists to
     * rule out. The clamp has to happen before the exponentiation, not after it.
     */
    it('stays at the ceiling for a count no attacker could reach', () => {
      expect(delaySecondsFor(1_000, POLICY)).toBe(POLICY.maxDelaySeconds);
      expect(Number.isFinite(delaySecondsFor(Number.MAX_SAFE_INTEGER, POLICY))).toBe(true);
    });
  });

  describe('decay', () => {
    it('forgives nothing before a whole decay interval has passed', () => {
      expect(decayedFailures(state(4), T0 + seconds(599), POLICY)).toBe(4);
    });

    it('forgives one failure per decay interval', () => {
      expect(decayedFailures(state(4), T0 + seconds(600), POLICY)).toBe(3);
      expect(decayedFailures(state(4), T0 + seconds(1_800), POLICY)).toBe(1);
    });

    it('never goes below zero, however long the account is left alone', () => {
      expect(decayedFailures(state(4), T0 + seconds(600_000), POLICY)).toBe(0);
    });

    /** A clock that went backwards is a skew, not a reprieve: it must not forgive anything. */
    it('forgives nothing when the instant is earlier than the last failure', () => {
      expect(decayedFailures(state(4), T0 - seconds(600), POLICY)).toBe(4);
    });
  });

  describe('recording a failure', () => {
    it('starts a record at one for an account with no history', () => {
      expect(penalise(null, T0, POLICY)).toEqual({ failures: 1, lastFailureAt: T0 });
    });

    it('counts up and stamps the instant', () => {
      expect(penalise(state(2), T0 + seconds(5), POLICY)).toEqual({
        failures: 3,
        lastFailureAt: T0 + seconds(5),
      });
    });

    /**
     * Counting up from the *stored* number rather than the decayed one is how a counter ratchets:
     * every hour of an attacker's noise would leave a residue the victim never sheds.
     */
    it('counts up from what decay has already forgiven, not from what is stored', () => {
      expect(penalise(state(4), T0 + seconds(1_800), POLICY).failures).toBe(2);
    });

    /**
     * The ceiling on the stored count is what bounds recovery. Without it, an attacker who keeps
     * attempting — one attempt per ceiling delay costs them nothing — drives the count up faster
     * than decay sheds it, and the time the victim needs to get back to zero grows without limit.
     * The delay is already capped, so the failures past the ceiling buy an attacker nothing except
     * that unbounded recovery, which is exactly what they must not buy.
     */
    it('refuses to count past the ceiling, however many failures arrive', () => {
      let current: ThrottleState | null = null;

      for (let attempt = 0; attempt < 500; attempt += 1) {
        current = penalise(current, T0 + seconds(attempt), POLICY);
      }

      expect(current?.failures).toBe(failureCeiling(POLICY));
      expect(failureCeiling(POLICY)).toBe(POLICY.burst + 6);
    });
  });

  describe('the decision an attempt gets', () => {
    it('allows an account with no record at all', () => {
      expect(evaluate(null, T0, POLICY)).toEqual({
        allowed: true,
        failures: 0,
        retryAfterSeconds: 0,
      });
    });

    it('allows an account still inside its burst', () => {
      expect(evaluate(state(POLICY.burst), T0, POLICY)).toMatchObject({
        allowed: true,
        retryAfterSeconds: 0,
      });
    });

    it('refuses while the delay the last failure earned is still running', () => {
      expect(evaluate(state(POLICY.burst + 2), T0 + seconds(1), POLICY)).toEqual({
        allowed: false,
        failures: POLICY.burst + 2,
        retryAfterSeconds: 3,
      });
    });

    /** `Retry-After: 0` tells a client to retry immediately, which is not what "wait" means. */
    it('rounds a part-second wait up to a whole second', () => {
      expect(evaluate(state(POLICY.burst + 1), T0 + 1_500, POLICY).retryAfterSeconds).toBe(1);
    });

    it('allows the attempt the moment the delay has run out', () => {
      expect(evaluate(state(POLICY.burst + 2), T0 + seconds(4), POLICY)).toMatchObject({
        allowed: true,
        retryAfterSeconds: 0,
      });
    });

    /**
     * Criterion 16, as arithmetic. Whatever an account's history — and this is the worst history
     * the record can hold — leaving it alone for the recovery bound puts it back to untouched.
     * A test that asserted "recovers eventually" would pass on a policy that takes a year.
     */
    it('recovers completely from the worst record it can hold', () => {
      const worst = state(failureCeiling(POLICY));

      expect(evaluate(worst, T0 + seconds(maxRecoverySeconds(POLICY)), POLICY)).toEqual({
        allowed: true,
        failures: 0,
        retryAfterSeconds: 0,
      });
    });

    it('bounds that recovery to something a human can wait out', () => {
      expect(maxRecoverySeconds(POLICY)).toBe(failureCeiling(POLICY) * POLICY.decaySeconds);
      expect(Number.isFinite(maxRecoverySeconds(POLICY))).toBe(true);
    });
  });

  /**
   * The store's key expires; that is the belt to the decay arithmetic's braces. It has to outlive
   * the record's usefulness — expiring early forgives an attacker mid-climb — and it has to be
   * finite, because a record that never expires is a lock that survives every deploy.
   */
  describe('how long a record is worth keeping', () => {
    it('outlives the decay of everything the record holds', () => {
      expect(retentionSeconds(state(POLICY.burst + 3), POLICY)).toBeGreaterThanOrEqual(
        (POLICY.burst + 3) * POLICY.decaySeconds,
      );
    });

    it('is finite for the worst record the store can hold', () => {
      expect(retentionSeconds(state(failureCeiling(POLICY)), POLICY)).toBeLessThanOrEqual(
        maxRecoverySeconds(POLICY) + POLICY.decaySeconds,
      );
    });
  });

  describe('a policy that cannot mean anything', () => {
    it('is refused rather than silently reinterpreted', () => {
      expect(() => delaySecondsFor(1, { ...POLICY, firstDelaySeconds: 0 })).toThrow(RangeError);
      expect(() => delaySecondsFor(1, { ...POLICY, maxDelaySeconds: 1 })).toThrow(RangeError);
      expect(() => delaySecondsFor(1, { ...POLICY, decaySeconds: 0 })).toThrow(RangeError);
      expect(() => delaySecondsFor(1, { ...POLICY, burst: -1 })).toThrow(RangeError);
    });
  });
});
