import { useEffect, useState } from 'react';

/** A minute is the smallest unit any relative label on these screens renders. */
const DEFAULT_INTERVAL_MS = 60_000;

/**
 * The current time, as a value that re-renders when it changes.
 *
 * `Date.now()` read in a component body is impure — two renders of the same state produce different
 * output, which is exactly what React's concurrent rendering is allowed to do and what the compiler
 * assumes never happens. Holding it in state makes the clock an ordinary input.
 *
 * The interval earns its place beyond that: "Created 1 minute ago" is wrong sixty seconds later,
 * and a label that only refreshes when something else happens to re-render is a label that is
 * quietly stale on a screen nobody has touched.
 */
export function useNow(intervalMs = DEFAULT_INTERVAL_MS): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, intervalMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [intervalMs]);

  return now;
}
