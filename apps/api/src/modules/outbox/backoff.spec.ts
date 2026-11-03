import { describe, expect, it } from 'vitest';

import { fullJitter } from './backoff';

const SAMPLES = 200;
const CAP_MS = 900_000;

function samples(attemptsMade: number): number[] {
  return Array.from({ length: SAMPLES }, () => fullJitter(attemptsMade));
}

/**
 * FR-018: retries wait `U[0, min(15 min, 2 s · 2^(attempt−1))]`. The strategy is random by design,
 * so each case draws a sample and checks the bound rather than a value; 200 draws make a strategy
 * that ever leaves the window fail with probability 1 − (1 − p)^200 for any p worth catching.
 */
describe('fullJitter', () => {
  it('draws every delay from [0, min(cap, 2 s · 2^(n−1))]', () => {
    for (const [attemptsMade, ceiling] of [
      [1, 2_000],
      [3, 8_000],
      [5, 32_000],
      [12, CAP_MS],
    ] as const) {
      for (const delay of samples(attemptsMade)) {
        expect(delay, `attempt ${attemptsMade}`).toBeGreaterThanOrEqual(0);
        expect(delay, `attempt ${attemptsMade}`).toBeLessThan(ceiling);
        expect(Number.isInteger(delay), `attempt ${attemptsMade}`).toBe(true);
      }
    }
  });

  it('is not constant', () => {
    expect(new Set(samples(5)).size).toBeGreaterThan(1);
  });

  it('caps at fifteen minutes from attempt 10 on', () => {
    for (const attemptsMade of [10, 20, 40]) {
      const drawn = samples(attemptsMade);

      expect(Math.max(...drawn), `attempt ${attemptsMade}`).toBeLessThanOrEqual(CAP_MS);
      expect(Math.max(...drawn), `attempt ${attemptsMade}`).toBeGreaterThan(0);
    }
  });
});
