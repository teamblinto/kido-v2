const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'narrow' });

/**
 * "2 hr ago", from a run's `createdAt`.
 *
 * `Intl.RelativeTimeFormat` rather than a date library: the platform already speaks this, and the
 * spec's dependency list approves nothing that would say it better.
 */
export function describeAge(iso: string, now: number): string {
  const elapsed = now - new Date(iso).getTime();

  if (Number.isNaN(elapsed) || elapsed < MINUTE) {
    return 'just now';
  }

  if (elapsed < HOUR) {
    return relative.format(-Math.floor(elapsed / MINUTE), 'minute');
  }

  if (elapsed < DAY) {
    return relative.format(-Math.floor(elapsed / HOUR), 'hour');
  }

  return relative.format(-Math.floor(elapsed / DAY), 'day');
}
