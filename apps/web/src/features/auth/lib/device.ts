/**
 * Turning a session row into something a person can recognise their own laptop by.
 *
 * Its own module rather than helpers beside the dialog: they are pure, they are the part worth
 * testing exhaustively, and a component file that also exports functions loses Fast Refresh.
 */

const BROWSERS: readonly (readonly [string, string])[] = [
  // Order matters and is not alphabetical. Every Chromium browser claims `Chrome`, and Chrome
  // itself claims `Safari` — so the specific ones have to be asked first or everything is Chrome.
  ['Edg/', 'Edge'],
  ['OPR/', 'Opera'],
  ['Firefox/', 'Firefox'],
  ['Chrome/', 'Chrome'],
  ['Safari/', 'Safari'],
];

const PLATFORMS: readonly (readonly [readonly string[], string])[] = [
  [['Windows'], 'Windows'],
  [['Macintosh', 'Mac OS X'], 'macOS'],
  // Before Linux: an Android agent says both, and "Linux" is the less useful of the two.
  [['Android'], 'Android'],
  [['iPhone', 'iPad'], 'iOS'],
  [['Linux'], 'Linux'],
];

/** The literal `device-fingerprint.ts` falls back to when a request arrived without an agent. */
const UNKNOWN_AGENT = 'unknown';

const MAX_RAW_LENGTH = 48;

/**
 * A `User-Agent` as a short, recognisable label.
 *
 * An agent it cannot classify is shown as-is rather than replaced with a friendly guess: the whole
 * point of this row is that somebody can tell which device is theirs, and a wrong label is worse
 * than an ugly one.
 */
export function describeAgent(userAgent: string): string {
  const browser = BROWSERS.find(([needle]) => userAgent.includes(needle))?.[1];
  const platform = PLATFORMS.find(([needles]) =>
    needles.some((needle) => userAgent.includes(needle)),
  )?.[1];

  if (browser === undefined && platform === undefined) {
    return userAgent === UNKNOWN_AGENT ? 'Unrecognised device' : truncate(userAgent);
  }

  return [browser, platform].filter((part) => part !== undefined).join(' on ');
}

function truncate(value: string): string {
  return value.length > MAX_RAW_LENGTH ? `${value.slice(0, MAX_RAW_LENGTH - 1)}…` : value;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Relative phrasing for the last request a session made.
 *
 * "just now" covers the first two minutes rather than the first one: the row for the device you are
 * reading this on is always the most recent, and "0 minutes ago" is a worse way to say so.
 */
export function describeLastSeen(iso: string, now: number): string {
  const elapsed = now - new Date(iso).getTime();

  if (Number.isNaN(elapsed)) {
    return 'unknown';
  }

  if (elapsed < 2 * MINUTE) {
    return 'just now';
  }

  if (elapsed < HOUR) {
    return `${String(Math.floor(elapsed / MINUTE))} minutes ago`;
  }

  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);

    return `${String(hours)} hour${hours === 1 ? '' : 's'} ago`;
  }

  const days = Math.floor(elapsed / DAY);

  return days === 1 ? 'yesterday' : `${String(days)} days ago`;
}
