import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { DEFAULT_DAYTONA_TIMINGS } from '../../sandbox/sandbox.constants';
import { checkCommand } from '../../sandbox/sandbox-guards';
import { gitLsFiles, parseLsFiles, porcelainDigest } from './git-commands';

describe('gitLsFiles', () => {
  it('lists the tracked and untracked-but-not-ignored files, and passes the allowlist', () => {
    expect(gitLsFiles()).toBe('git ls-files --cached --others --exclude-standard');
    expect(() => checkCommand(gitLsFiles(), DEFAULT_DAYTONA_TIMINGS.execAllowlist)).not.toThrow();
  });
});

describe('parseLsFiles', () => {
  it('reads one path per line, unquotes C-style quoting with octal escapes, and sorts', () => {
    // git prints `café "x".ts` as `"caf\303\251 \"x\".ts"`.
    expect(parseLsFiles('src/b.ts\n"caf\\303\\251 \\"x\\".ts"\na.ts\n')).toEqual([
      'a.ts',
      'café "x".ts',
      'src/b.ts',
    ]);
  });

  it('is empty for an empty output', () => {
    expect(parseLsFiles('')).toEqual([]);
  });
});

describe('porcelainDigest', () => {
  it('is sha-256 over the sorted lines, so order does not matter', () => {
    const expected = createHash('sha256').update(' M a.ts\n?? b.ts\n').digest('hex');
    expect(porcelainDigest('?? b.ts\n M a.ts\n')).toBe(expected);
    expect(porcelainDigest(' M a.ts\n?? b.ts\n')).toBe(expected);
  });

  it('is stable for an empty output', () => {
    expect(porcelainDigest('')).toBe(createHash('sha256').update('').digest('hex'));
  });
});
