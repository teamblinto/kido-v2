import type { ClockPort } from './clock.port';

/** What a `Date`, an ISO string or epoch milliseconds all mean: one instant. */
export type Instant = Date | number | string;

/**
 * The clock every time-dependent test drives. It stands still until told otherwise, which is what
 * makes "the token expires in 24 h" an assertion about the code rather than about how long the
 * suite took to get to the second `expect`.
 *
 * It lives in `src/` rather than `test/` because it is part of the port's contract — a second
 * implementation that proves the interface is implementable without reading the host clock — and
 * because every module that injects {@link ClockPort} needs it to write its own tests.
 */
export class FakeClock implements ClockPort {
  private current: number;

  constructor(instant: Instant) {
    this.current = epochOf(instant);
  }

  now(): Date {
    return new Date(this.current);
  }

  /**
   * Move forward. Forward only: a negative advance is almost always an arithmetic slip, and the one
   * it produces — an expiry that has not happened yet — is exactly the bug these tests exist to
   * catch. Skew and drift are deliberate, and say so by calling {@link set}.
   */
  advance(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new RangeError(
        `advance takes a finite, non-negative number of milliseconds, got ${String(milliseconds)}`,
      );
    }

    this.current += milliseconds;
  }

  /** Jump to an arbitrary instant, in either direction. */
  set(instant: Instant): void {
    this.current = epochOf(instant);
  }
}

/**
 * `new Date('yesterday')` is an `Invalid Date` and every arithmetic on it is `NaN`, which compares
 * false against everything — a token that expires at `NaN` never expires. Refuse at the boundary,
 * where the value is still traceable to the line that wrote it.
 */
function epochOf(instant: Instant): number {
  const epoch = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();

  if (Number.isNaN(epoch)) {
    throw new RangeError(`not a valid instant: ${String(instant)}`);
  }

  return epoch;
}
