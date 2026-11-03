import { describe, expect, it } from 'vitest';

import { FakeClock } from './fake-clock';

const START = '2026-08-14T09:30:00.000Z';

describe('FakeClock', () => {
  it('starts at the instant it was given, as a Date, an ISO string or epoch milliseconds', () => {
    const asDate = new FakeClock(new Date(START));
    const asString = new FakeClock(START);
    const asEpoch = new FakeClock(Date.parse(START));

    expect(asDate.now().toISOString()).toBe(START);
    expect(asString.now().toISOString()).toBe(START);
    expect(asEpoch.now().toISOString()).toBe(START);
  });

  /**
   * The property every time-dependent test depends on: an expiry that is asserted twice in one test
   * must not have moved between the assertions because the suite was slow.
   */
  it('does not move on its own', () => {
    const clock = new FakeClock(START);

    expect(clock.now()).toEqual(clock.now());
  });

  it('advances by exactly the milliseconds asked for', () => {
    const clock = new FakeClock(START);

    clock.advance(24 * 60 * 60 * 1_000);

    expect(clock.now().toISOString()).toBe('2026-08-15T09:30:00.000Z');
  });

  it('accumulates successive advances', () => {
    const clock = new FakeClock(START);

    clock.advance(30_000);
    clock.advance(30_000);

    expect(clock.now().toISOString()).toBe('2026-08-14T09:31:00.000Z');
  });

  /**
   * Backwards is expressed with `set`, never with a negative `advance`: TOTP drift and clock skew
   * are deliberate jumps, whereas a negative advance is almost always an arithmetic slip that would
   * otherwise make an expired token look valid.
   */
  it('jumps anywhere on set, including backwards', () => {
    const clock = new FakeClock(START);

    clock.set('2020-01-01T00:00:00.000Z');

    expect(clock.now().toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });

  it('refuses a negative advance', () => {
    const clock = new FakeClock(START);

    expect(() => clock.advance(-1)).toThrow(RangeError);
    expect(clock.now().toISOString()).toBe(START);
  });

  it('refuses a non-finite advance', () => {
    const clock = new FakeClock(START);

    expect(() => clock.advance(Number.NaN)).toThrow(RangeError);
    expect(() => clock.advance(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  /**
   * `new Date('yesterday')` is an `Invalid Date`, and every arithmetic on it is `NaN` — a token that
   * expires at `NaN` compares false against everything and never expires. Fail at construction.
   */
  it('refuses an instant it cannot parse rather than becoming an Invalid Date', () => {
    expect(() => new FakeClock('yesterday')).toThrow(RangeError);
    expect(() => new FakeClock(Number.NaN)).toThrow(RangeError);
  });

  it('refuses an unparseable instant on set too', () => {
    const clock = new FakeClock(START);

    expect(() => clock.set('yesterday')).toThrow(RangeError);
    expect(clock.now().toISOString()).toBe(START);
  });

  it('hands out a fresh Date, so mutating an answer cannot move the clock', () => {
    const clock = new FakeClock(START);
    const first = clock.now();

    first.setUTCFullYear(1999);

    expect(clock.now().toISOString()).toBe(START);
    expect(clock.now()).not.toBe(first);
  });
});
