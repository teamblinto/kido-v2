import { describe, expect, it } from 'vitest';

import { describeAgent, describeLastSeen } from './device';

const NOW = Date.parse('2026-08-18T12:00:00.000Z');

function iso(offsetMs: number): string {
  return new Date(NOW - offsetMs).toISOString();
}

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

describe('describeAgent', () => {
  it.each([
    [CHROME_WINDOWS, 'Chrome on Windows'],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      'Safari on macOS',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0', 'Firefox on Linux'],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Version/17.0 Mobile/15E148 Safari/604.1',
      'Safari on iOS',
    ],
  ])('recognises %o as %o', (agent, expected) => {
    expect(describeAgent(agent)).toBe(expected);
  });

  it('does not dress up the fallback the fingerprint records', () => {
    // `device-fingerprint.ts` answers `unknown` rather than nothing, so this arrives verbatim.
    // Inventing a friendlier label for a device nobody can identify would be worse than saying so.
    expect(describeAgent('unknown')).toBe('Unrecognised device');
  });

  it('shows an unrecognised agent rather than hiding it', () => {
    expect(describeAgent('curl/8.19.0')).toBe('curl/8.19.0');
  });
});

describe('describeLastSeen', () => {
  it.each([
    [30_000, 'just now'],
    [10 * 60_000, '10 minutes ago'],
    [2 * 3_600_000, '2 hours ago'],
    [86_400_000, 'yesterday'],
    [4 * 86_400_000, '4 days ago'],
  ])('describes %dms ago as %o', (offset, expected) => {
    expect(describeLastSeen(iso(offset), NOW)).toBe(expected);
  });
});
