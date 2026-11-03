import { describe, expect, it } from 'vitest';

import { MAX_ATTEMPTS, nextAttemptAt, RETRY_GAPS_MS, RETRY_WINDOW_MS } from './schedule';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const FIRST = new Date('2026-09-23T00:00:00.000Z');

/** The gap after `attempt`, measured from `now`, with `random` fixed. */
function gapAfter(attempt: number, random: number, now = FIRST): number | null {
  const next = nextAttemptAt({
    attempt,
    firstAttemptAt: FIRST,
    now,
    random: () => random,
    retryAfterMs: null,
  });
  return next === null ? null : next.getTime() - now.getTime();
}

/**
 * Spec 029 T055 — the retry schedule (research R7): eight attempts, gaps of 1 m, 5 m, 30 m, 2 h,
 * 5 h, 8 h and 8 h, each scaled by a uniform factor in [0.8, 1.2], clamped to 24 h after the first
 * attempt, with a longer `Retry-After` replacing the gap.
 */
describe('nextAttemptAt', () => {
  it('has eight attempts inside a 24 h window', () => {
    expect(MAX_ATTEMPTS).toBe(8);
    expect(RETRY_WINDOW_MS).toBe(24 * HOUR);
  });

  it('with random at 0.5, the gaps after attempts 1–7 are exactly 1 m, 5 m, 30 m, 2 h, 5 h, 8 h and 8 h', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((attempt) => gapAfter(attempt, 0.5))).toEqual([
      MINUTE,
      5 * MINUTE,
      30 * MINUTE,
      2 * HOUR,
      5 * HOUR,
      8 * HOUR,
      8 * HOUR,
    ]);
  });

  it.each([
    [0, 0.8],
    [1, 1.2],
  ])('with random at %s, each gap is %s× nominal', (random, factor) => {
    for (const [index, gap] of RETRY_GAPS_MS.slice(0, 5).entries()) {
      expect(gapAfter(index + 1, random)).toBe(Math.round(gap * factor));
    }
  });

  it('is null after attempt 8', () => {
    expect(gapAfter(8, 0.5)).toBeNull();
    expect(gapAfter(9, 0.5)).toBeNull();
  });

  it('never lands later than firstAttemptAt + 24 h, even at 1.2×', () => {
    let now = FIRST;
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      const next = nextAttemptAt({
        attempt,
        firstAttemptAt: FIRST,
        now,
        random: () => 1,
        retryAfterMs: null,
      });
      expect(next).not.toBeNull();
      expect(next!.getTime()).toBeLessThanOrEqual(FIRST.getTime() + 24 * HOUR);
      now = next!;
    }
    // At 1.2× the seventh gap would reach 28 h 19 m: it is clamped to the window's end.
    expect(now).toEqual(new Date(FIRST.getTime() + 24 * HOUR));
  });

  it('a Retry-After longer than the gap replaces it, and one shorter does not', () => {
    const args = { attempt: 1, firstAttemptAt: FIRST, now: FIRST, random: () => 0.5 };
    expect(nextAttemptAt({ ...args, retryAfterMs: 10 * MINUTE })).toEqual(
      new Date(FIRST.getTime() + 10 * MINUTE),
    );
    expect(nextAttemptAt({ ...args, retryAfterMs: 10_000 })).toEqual(
      new Date(FIRST.getTime() + MINUTE),
    );
  });

  it('a Retry-After beyond the 24 h window is clamped, and a clamp at or before now gives null', () => {
    const now = new Date(FIRST.getTime() + 20 * HOUR);
    expect(
      nextAttemptAt({
        attempt: 3,
        firstAttemptAt: FIRST,
        now,
        random: () => 0.5,
        retryAfterMs: 48 * HOUR,
      }),
    ).toEqual(new Date(FIRST.getTime() + 24 * HOUR));
    expect(
      nextAttemptAt({
        attempt: 3,
        firstAttemptAt: FIRST,
        now: new Date(FIRST.getTime() + 24 * HOUR),
        random: () => 0.5,
        retryAfterMs: 48 * HOUR,
      }),
    ).toBeNull();
  });

  it('defaults random to Math.random, staying within the bounds', () => {
    const next = nextAttemptAt({
      attempt: 1,
      firstAttemptAt: FIRST,
      now: FIRST,
      retryAfterMs: null,
    });
    const gap = next!.getTime() - FIRST.getTime();
    expect(gap).toBeGreaterThanOrEqual(0.8 * MINUTE);
    expect(gap).toBeLessThanOrEqual(1.2 * MINUTE);
  });

  it('the minimum sum of the first six gaps is at least 12 h (SC-004)', () => {
    const minimum = RETRY_GAPS_MS.slice(0, 6).reduce((sum, gap) => sum + 0.8 * gap, 0);
    expect(minimum).toBeGreaterThanOrEqual(12 * HOUR);
  });
});
