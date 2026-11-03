import { describe, expect, it } from 'vitest';

import {
  afterFailure,
  afterSuccess,
  CIRCUIT_OPEN_MS,
  FAILURES_TO_OPEN,
  isOpen,
  retryAfterSeconds,
} from './circuit';

const now = new Date('2026-09-21T12:00:00Z');
const closed = { circuitOpenUntil: null, failureCount: 0 };

describe('circuit (R10)', () => {
  it('counts failures below the threshold without opening', () => {
    expect(afterFailure({ ...closed, failureCount: 3 }, now)).toEqual({
      circuitOpenUntil: null,
      failureCount: 4,
    });
  });

  it('opens for 10 minutes on the fifth failure', () => {
    expect(afterFailure({ ...closed, failureCount: FAILURES_TO_OPEN - 1 }, now)).toEqual({
      circuitOpenUntil: new Date(now.getTime() + CIRCUIT_OPEN_MS),
      failureCount: FAILURES_TO_OPEN,
    });
  });

  it('keeps an already-open circuit open and counting', () => {
    const open = { circuitOpenUntil: new Date(now.getTime() + 1_000), failureCount: 5 };

    expect(afterFailure(open, now)).toEqual({
      circuitOpenUntil: new Date(now.getTime() + CIRCUIT_OPEN_MS),
      failureCount: 6,
    });
  });

  it('a success zeros the count and clears the window', () => {
    expect(afterSuccess()).toEqual(closed);
  });

  it('isOpen is true only while circuit_open_until is in the future', () => {
    expect(isOpen(closed, now)).toBe(false);
    expect(isOpen({ ...closed, circuitOpenUntil: now }, now)).toBe(false);
    expect(isOpen({ ...closed, circuitOpenUntil: new Date(now.getTime() + 1) }, now)).toBe(true);
  });

  it('retryAfterSeconds rounds up to a whole second and never below 1', () => {
    expect(
      retryAfterSeconds({ ...closed, circuitOpenUntil: new Date(now.getTime() + 90_500) }, now),
    ).toBe(91);
    expect(retryAfterSeconds({ ...closed, circuitOpenUntil: now }, now)).toBe(1);
    expect(retryAfterSeconds(closed, now)).toBe(1);
  });
});
