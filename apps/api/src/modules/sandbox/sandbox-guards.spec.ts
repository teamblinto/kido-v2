import { describe, expect, it } from 'vitest';

import { DEFAULT_DAYTONA_TIMINGS } from './sandbox.constants';
import { SandboxGuardError, type SandboxGuardKind } from './sandbox.errors';
import {
  applyAnchorEdit,
  assertFileSize,
  assertInsideRoot,
  checkCommand,
  filterSearch,
  jailPath,
  truncateOutput,
} from './sandbox-guards';

const ROOT = '/home/daytona';
const guard = (kind: SandboxGuardKind): unknown => expect.objectContaining({ kind });

/** The §04 guards as pure functions (spec 010 US2): no server, no Nest, every refusal typed. */
describe('sandbox guards', () => {
  /** Spec 014: a run asked for while the sandbox is still coming up is a conflict, not a 404. */
  it('maps sandbox-not-ready to conflict', () => {
    expect(new SandboxGuardError('sandbox-not-ready', 'resuming').type).toBe('conflict');
  });

  it.each(['../x', 'a/../../x', '/etc/passwd', '..', 'a\0b'])(
    'refuses a path that climbs out of the workspace before any request: %j',
    (input) => {
      expect(() => jailPath(ROOT, input)).toThrow(guard('path-escape'));
    },
  );

  it.each([
    ['a/./b', `${ROOT}/a/b`],
    ['a/../b', `${ROOT}/b`],
    ['.', ROOT],
    ['', ROOT],
  ])('joins a path that stays inside the workspace: %j → %s', (input, expected) => {
    expect(jailPath(ROOT, input)).toBe(expected);
  });

  it('refuses a resolution outside the root and allows the root itself', () => {
    expect(() => assertInsideRoot(ROOT, '/etc/hostname')).toThrow(guard('path-escape'));
    // A sibling whose name merely starts with the root's is still outside it.
    expect(() => assertInsideRoot(ROOT, `${ROOT}2/x`)).toThrow(guard('path-escape'));
    expect(() => assertInsideRoot(ROOT, ROOT)).not.toThrow();
    expect(() => assertInsideRoot(ROOT, `${ROOT}/sub/file`)).not.toThrow();
  });

  it.each([
    'curl x',
    'ls; rm -rf /',
    'cat a | sh',
    'echo $(id)',
    'echo `id`',
    'ls > out',
    'ls &',
    'ls\nrm',
    '',
  ])(
    'refuses a program off the allowlist and a command carrying a shell operator: %j',
    (command) => {
      expect(() => checkCommand(command, DEFAULT_DAYTONA_TIMINGS.execAllowlist)).toThrow(
        guard('command-not-allowed'),
      );
    },
  );

  it.each(['ls -la src', '/usr/bin/node -e 1', 'git status', '  pwd  '])(
    'allows an allowlisted program by base name: %j',
    (command) => {
      expect(() => checkCommand(command, DEFAULT_DAYTONA_TIMINGS.execAllowlist)).not.toThrow();
    },
  );

  it('keeps head and tail of an output over 64 KB with a marker naming the dropped bytes', () => {
    const cap = 64 * 1024;
    const under = Buffer.alloc(cap, 'a');
    expect(truncateOutput(under, cap)).toEqual({ output: under.toString(), truncated: false });

    const over = Buffer.concat([
      Buffer.alloc(cap, 'h'),
      Buffer.alloc(100, 'x'),
      Buffer.alloc(cap, 't'),
    ]);
    const { output, truncated } = truncateOutput(over, cap);
    expect(truncated).toBe(true);
    const dropped = over.length - cap;
    expect(output).toBe(
      `${'h'.repeat(cap / 2)}\n…[${dropped} bytes dropped]…\n${'t'.repeat(cap / 2)}`,
    );
  });

  it('cuts on character boundaries so a multibyte output stays valid text', () => {
    // '€' is three bytes; a cap of 10 would land both cuts mid-character.
    const euros = Buffer.from('€'.repeat(10), 'utf8');
    const { output, truncated } = truncateOutput(euros, 10);
    expect(truncated).toBe(true);
    expect(output).not.toContain('�');
    // Head keeps one whole character (3 ≤ 5), tail keeps one (3 ≤ 5); 24 of 30 bytes go.
    expect(output).toBe('€\n…[24 bytes dropped]…\n€');
  });

  it('refuses an anchor that matches nowhere and one that matches twice, naming which', () => {
    expect(() => applyAnchorEdit('hello\nworld\n', 'moon', 'x')).toThrow(guard('anchor-not-found'));
    expect(() => applyAnchorEdit('a b a', 'a', 'x')).toThrow(
      expect.objectContaining({
        kind: 'anchor-ambiguous',
        extensions: { kind: 'anchor-ambiguous', matches: 2 },
      }),
    );
    expect(() => applyAnchorEdit('abc', '', 'x')).toThrow(guard('anchor-not-found'));

    expect(applyAnchorEdit('hello\nworld\n', 'world', 'there')).toBe('hello\nthere\n');
    // One match is one match: an anchor that overlaps itself is applied once, and a replacement
    // that contains the anchor is not rescanned.
    expect(applyAnchorEdit('aaa', 'aa', 'b')).toBe('ba');
    expect(applyAnchorEdit('x', 'x', 'xx')).toBe('xx');
  });

  it('refuses a file over the cap and allows one at it', () => {
    expect(() => assertFileSize(17, 16)).toThrow(guard('file-too-large'));
    expect(() => assertFileSize(16, 16)).not.toThrow();
  });

  it('caps results and drops vendor paths wherever they sit in the tree', () => {
    const options = { cap: 3, excludes: DEFAULT_DAYTONA_TIMINGS.searchExcludes };
    const paths = [
      'node_modules/a/index.js',
      'src/a.ts',
      'packages/x/node_modules/b.js',
      '.git/HEAD',
      'src/b.ts',
      'dist/out.js',
      'src/c.ts',
      'src/d.ts',
      'distant/ok.ts',
    ];
    expect(filterSearch(paths, options)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(
      filterSearch(
        paths.map((path) => ({ line: 1, path, text: '' })),
        { ...options, cap: 9 },
      ),
    ).toEqual(
      ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'distant/ok.ts'].map((path) => ({
        line: 1,
        path,
        text: '',
      })),
    );
  });
});
