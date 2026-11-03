import { afterEach, describe, expect, it, vi } from 'vitest';

import { SystemClock } from './system-clock';

const INSTANT = new Date('2026-08-14T09:30:00.000Z');

describe('SystemClock', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers with the host clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(INSTANT);

    expect(new SystemClock().now()).toEqual(INSTANT);
  });

  it('moves when the host clock moves', () => {
    vi.useFakeTimers();
    vi.setSystemTime(INSTANT);

    const clock = new SystemClock();

    vi.advanceTimersByTime(1_500);

    expect(clock.now().getTime()).toBe(INSTANT.getTime() + 1_500);
  });

  /**
   * `Date` is mutable, so a shared instance would let any caller that called `setUTCFullYear` on the
   * answer move time for everyone holding it. Every read is its own object.
   */
  it('hands out a fresh Date, so mutating an answer cannot move the clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(INSTANT);

    const clock = new SystemClock();
    const first = clock.now();

    first.setUTCFullYear(1999);

    expect(clock.now()).toEqual(INSTANT);
    expect(clock.now()).not.toBe(first);
  });
});
