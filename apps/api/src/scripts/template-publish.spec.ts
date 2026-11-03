import { describe, expect, it } from 'vitest';

import { formatPublishLine, formatShowRow, parseArgs } from './template-publish';

const DIGEST = 'abcdef0123456789'.repeat(4);

/** The pure halves of `template:publish` / `template:show` (spec 015 contract § 4). */
describe('template-publish parseArgs', () => {
  it('publish defaults to all', () => {
    expect(parseArgs(['publish'])).toEqual({ command: 'publish', templates: 'all' });
    expect(parseArgs(['publish', 'all'])).toEqual({ command: 'publish', templates: 'all' });
  });

  it('publish <template>', () => {
    expect(parseArgs(['publish', 'nextjs'])).toEqual({ command: 'publish', templates: ['nextjs'] });
  });

  it('drops the `--` pnpm passes through from `template:publish -- <template>`', () => {
    expect(parseArgs(['publish', '--', 'nextjs'])).toEqual({
      command: 'publish',
      templates: ['nextjs'],
    });
    expect(parseArgs(['publish', '--'])).toEqual({ command: 'publish', templates: 'all' });
  });

  it('show', () => {
    expect(parseArgs(['show'])).toEqual({ command: 'show' });
  });

  it.each([
    [['publish', 'rails'], 'unknown template rails'],
    [['publish', 'nextjs', 'python'], 'usage'],
    [['show', 'nextjs'], 'usage'],
    [['drop'], 'usage'],
    [[], 'usage'],
  ])('%j is refused mentioning %s', (argv, word) => {
    expect(() => parseArgs(argv)).toThrow(word);
  });
});

describe('template-publish formatPublishLine', () => {
  it('prints template digest[0:12] outcome, and the reason when failed', () => {
    expect(formatPublishLine('nextjs', DIGEST, { kind: 'built' })).toBe(
      'nextjs abcdef012345 built',
    );
    expect(
      formatPublishLine('python', DIGEST, { kind: 'failed', reason: 'npm ERR! code E404' }),
    ).toBe('python abcdef012345 failed npm ERR! code E404');
  });
});

describe('template-publish formatShowRow', () => {
  const READY_AT = new Date('2026-09-17T10:00:00.000Z');

  it('prints current ready-at building failed retired-count, `-` for absent', () => {
    expect(
      formatShowRow({
        building: null,
        current: DIGEST,
        failed: null,
        readyAt: READY_AT,
        retired: 0,
        template: 'nextjs',
        unavailable: null,
      }),
    ).toBe('nextjs abcdef012345 2026-09-17T10:00:00.000Z - - 0');
    expect(
      formatShowRow({
        building: 'b'.repeat(64),
        current: null,
        failed: 'f'.repeat(64),
        readyAt: null,
        retired: 2,
        template: 'python',
        unavailable: null,
      }),
    ).toBe('python - - bbbbbbbbbbbb ffffffffffff 2');
  });

  it('appends `unavailable: <reason>` when the current snapshot is not active at the provider', () => {
    expect(
      formatShowRow({
        building: null,
        current: DIGEST,
        failed: null,
        readyAt: READY_AT,
        retired: 0,
        template: 'nextjs',
        unavailable: 'snapshot not found at the provider',
      }),
    ).toBe(
      'nextjs abcdef012345 2026-09-17T10:00:00.000Z - - 0 unavailable: snapshot not found at the provider',
    );
  });
});
