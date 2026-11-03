import { describe, expect, it } from 'vitest';

import { formatRow, parseArgs } from './sandbox-pool';

/** The pure halves of `sandbox:pool` (spec 014 contract § 6): the argument parser and the row. */
describe('sandbox-pool parseArgs', () => {
  it('show', () => {
    expect(parseArgs(['show'])).toEqual({ command: 'show' });
  });

  it('set <template> --depth N', () => {
    expect(parseArgs(['set', 'nextjs', '--depth', '3'])).toEqual({
      command: 'set',
      depth: 3,
      template: 'nextjs',
    });
  });

  it.each([
    // Spec 015: the snapshot is the template's current version, not a dial.
    [['set', 'nextjs', '--depth', '3', '--snapshot', 'snap-1'], 'usage'],
    [['set', 'nextjs'], 'depth'],
    [['set', 'nextjs', '--depth'], 'depth'],
    [['set', 'nextjs', '--depth', 'three'], 'integer'],
    [['set', 'nextjs', '--depth', '1.5'], 'integer'],
    [['set', '--depth', '3'], 'usage'],
    [['drop'], 'usage'],
    [[], 'usage'],
  ])('%j is refused mentioning %s', (argv, word) => {
    expect(() => parseArgs(argv)).toThrow(word);
  });
});

describe('sandbox-pool formatRow', () => {
  it('prints template target ready creating releasing last-ready-at, `-` for null', () => {
    expect(
      formatRow({
        creating: 1,
        lastReadyAt: new Date('2026-09-13T10:00:00.000Z'),
        ready: 4,
        releasing: 0,
        target: 4,
        template: 'nextjs',
      }),
    ).toBe('nextjs 4 4 1 0 2026-09-13T10:00:00.000Z');
    expect(
      formatRow({
        creating: 0,
        lastReadyAt: null,
        ready: 0,
        releasing: 0,
        target: 1,
        template: 'python',
      }),
    ).toBe('python 1 0 0 0 -');
  });
});
