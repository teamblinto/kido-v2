import { describe, expect, it } from 'vitest';

import { formatCost, formatResetsIn, formatRunStatus, formatUpdatedAgo } from './usage-format';

const NOW = Date.parse('2026-11-03T10:00:00.000Z');
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

describe('usage format', () => {
  it('counts down to a reset in days, hours and minutes, rounding minutes up', () => {
    expect(formatResetsIn(at(130), NOW)).toBe('Resets in 2 h 10 min');
    expect(formatResetsIn(at(0.1), NOW)).toBe('Resets in 1 min');
    expect(formatResetsIn(at(3 * 24 * 60 + 120), NOW)).toBe('Resets in 3 d 2 h');
    expect(formatResetsIn(at(-1), NOW)).toBe('Resets now');
  });

  it('says how long ago the limits were read', () => {
    expect(formatUpdatedAgo(at(-0.5), NOW)).toBe('Updated just now');
    expect(formatUpdatedAgo(at(-3), NOW)).toBe('Updated 3 min ago');
    expect(formatUpdatedAgo(at(-125), NOW)).toBe('Updated 2 h ago');
  });

  it('prices micros in dollars, and an unpriced run as a dash', () => {
    expect(formatCost(12_300)).toBe('$0.0123');
    expect(formatCost(2_500_000)).toBe('$2.50');
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(null)).toBe('—');
  });

  it('reads a run status as words', () => {
    expect(formatRunStatus('awaiting_input')).toBe('Awaiting input');
  });
});
