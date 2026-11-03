import { describe, expect, it } from 'vitest';

import { nextCheckAt } from './check-schedule';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const WINDOW_START = new Date('2026-09-01T12:00:00.000Z');

/** The next check of a `pending` domain whose window is `ageMs` old. */
function pendingNext(ageMs: number, outcome: 'failed' | 'inconclusive' | 'passed' = 'failed') {
  const now = new Date(WINDOW_START.getTime() + ageMs);
  return (
    nextCheckAt(
      { removalRequestedAt: null, state: 'pending', windowStartedAt: WINDOW_START },
      outcome,
      now,
    ).getTime() - now.getTime()
  );
}

describe('nextCheckAt (research R7)', () => {
  describe('pending, by the age of the window', () => {
    it('checks every minute for the first 10 minutes', () => {
      expect(pendingNext(0)).toBe(MINUTE);
      expect(pendingNext(9 * MINUTE)).toBe(MINUTE);
      expect(pendingNext(10 * MINUTE - 1)).toBe(MINUTE);
    });

    it('checks every 5 minutes from 10 minutes, for the rest of the first hour', () => {
      expect(pendingNext(10 * MINUTE)).toBe(5 * MINUTE);
      expect(pendingNext(30 * MINUTE)).toBe(5 * MINUTE);
      expect(pendingNext(HOUR - 1)).toBe(5 * MINUTE);
    });

    it('checks every 15 minutes from 1 hour, for the rest of the first day', () => {
      expect(pendingNext(HOUR)).toBe(15 * MINUTE);
      expect(pendingNext(12 * HOUR)).toBe(15 * MINUTE);
      expect(pendingNext(24 * HOUR - 1)).toBe(15 * MINUTE);
    });

    it('checks every hour from 24 hours', () => {
      expect(pendingNext(24 * HOUR)).toBe(HOUR);
      expect(pendingNext(71 * HOUR)).toBe(HOUR);
    });

    it('keeps the cadence whether the check passed or failed', () => {
      expect(pendingNext(5 * MINUTE, 'passed')).toBe(MINUTE);
      expect(pendingNext(2 * HOUR, 'passed')).toBe(15 * MINUTE);
    });

    it('waits 5 minutes after an inconclusive check, however young the window (FR-021)', () => {
      expect(pendingNext(0, 'inconclusive')).toBe(5 * MINUTE);
      expect(pendingNext(2 * HOUR, 'inconclusive')).toBe(5 * MINUTE);
      expect(pendingNext(30 * HOUR, 'inconclusive')).toBe(5 * MINUTE);
    });

    it('returns a new Date, leaving `now` alone', () => {
      const now = new Date(WINDOW_START.getTime() + MINUTE);
      const before = now.getTime();
      const next = nextCheckAt(
        { removalRequestedAt: null, state: 'pending', windowStartedAt: WINDOW_START },
        'failed',
        now,
      );
      expect(next).not.toBe(now);
      expect(now.getTime()).toBe(before);
    });
  });

  describe('active and drifted (US3)', () => {
    /** The next check of a domain in `state` after a check at `NOW` that came out `outcome`. */
    function liveNext(
      state: 'active' | 'drifted',
      outcome: 'failed' | 'inconclusive' | 'passed',
    ): number {
      const now = new Date(WINDOW_START.getTime() + 40 * 24 * HOUR);
      return (
        nextCheckAt(
          { removalRequestedAt: null, state, windowStartedAt: WINDOW_START },
          outcome,
          now,
        ).getTime() - now.getTime()
      );
    }

    it('checks an active domain 24 hours after a pass (FR-020)', () => {
      expect(liveNext('active', 'passed')).toBe(24 * HOUR);
    });

    it('checks an active domain an hour after a failure, so drift is declared in about 2 hours', () => {
      expect(liveNext('active', 'failed')).toBe(HOUR);
    });

    it('checks a drifted domain every hour, so recovery is noticed quickly', () => {
      expect(liveNext('drifted', 'failed')).toBe(HOUR);
      expect(liveNext('drifted', 'passed')).toBe(HOUR);
    });

    it('waits 5 minutes after an inconclusive check (FR-021)', () => {
      expect(liveNext('active', 'inconclusive')).toBe(5 * MINUTE);
      expect(liveNext('drifted', 'inconclusive')).toBe(5 * MINUTE);
    });
  });

  describe('removing, by the time since removal was requested (R10)', () => {
    const REQUESTED = new Date('2026-09-02T08:00:00.000Z');

    /** The next deregistration attempt of a domain whose removal is `ageMs` old. */
    function removingNext(
      ageMs: number,
      outcome: 'failed' | 'inconclusive' | 'passed' = 'inconclusive',
    ) {
      const now = new Date(REQUESTED.getTime() + ageMs);
      return (
        nextCheckAt(
          { removalRequestedAt: REQUESTED, state: 'removing', windowStartedAt: WINDOW_START },
          outcome,
          now,
        ).getTime() - now.getTime()
      );
    }

    it('tries again a minute after the first attempts', () => {
      expect(removingNext(0)).toBe(MINUTE);
      expect(removingNext(30 * 1000)).toBe(MINUTE);
      expect(removingNext(MINUTE)).toBe(MINUTE);
    });

    it('doubles the wait with each attempt: the next one is as far away as the removal is old', () => {
      // Attempts at 0, 1, 2, 4, 8, 16 minutes after the request, then capped.
      expect(removingNext(2 * MINUTE)).toBe(2 * MINUTE);
      expect(removingNext(4 * MINUTE)).toBe(4 * MINUTE);
      expect(removingNext(8 * MINUTE)).toBe(8 * MINUTE);
      expect(removingNext(16 * MINUTE)).toBe(16 * MINUTE);
    });

    it('never waits more than 30 minutes', () => {
      expect(removingNext(30 * MINUTE)).toBe(30 * MINUTE);
      expect(removingNext(32 * MINUTE)).toBe(30 * MINUTE);
      expect(removingNext(3 * 24 * HOUR)).toBe(30 * MINUTE);
    });

    it('keeps the backoff whatever the attempt came to', () => {
      expect(removingNext(4 * MINUTE, 'failed')).toBe(4 * MINUTE);
      expect(removingNext(4 * MINUTE, 'passed')).toBe(4 * MINUTE);
    });

    it('starts from a minute when the request time is somehow ahead of the clock', () => {
      expect(removingNext(-5 * MINUTE)).toBe(MINUTE);
    });

    it('starts from a minute when no request time is stored (the data-model CHECK forbids it)', () => {
      const now = new Date(REQUESTED.getTime() + HOUR);
      expect(
        nextCheckAt(
          { removalRequestedAt: null, state: 'removing', windowStartedAt: WINDOW_START },
          'inconclusive',
          now,
        ).getTime() - now.getTime(),
      ).toBe(MINUTE);
    });
  });

  it('refuses a state that is never checked', () => {
    for (const state of ['failed', 'removed'] as const) {
      expect(() =>
        nextCheckAt(
          { removalRequestedAt: null, state, windowStartedAt: WINDOW_START },
          'failed',
          WINDOW_START,
        ),
      ).toThrow(/never checked/);
    }
  });
});
