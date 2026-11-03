import { describe, expect, it } from 'vitest';

import { EMPTY_MAP_NOTICE, renderMap } from './repo-map';

const scaffold = [
  { path: 'package.json', exports: [] },
  { path: 'src/index.ts', exports: ['main', 'run'] },
  { path: 'src/lib/util.ts', exports: [] },
  { path: 'README.md', exports: [] },
];

describe('renderMap', () => {
  it('renders an indented tree with one line per file and an exports suffix for source files', () => {
    expect(renderMap(scaffold)).toBe(
      [
        'README.md',
        'package.json',
        'src/',
        '  index.ts  · exports: main, run',
        '  lib/',
        '    util.ts',
      ].join('\n'),
    );
  });

  it('is byte-identical for the same paths and exports in any input order', () => {
    const shuffled = [...scaffold].reverse().map((f) => ({
      ...f,
      exports: [...f.exports].reverse(),
    }));
    expect(renderMap(shuffled)).toBe(renderMap(scaffold));
  });

  it('drops searchExcludes paths', () => {
    const map = renderMap([
      ...scaffold,
      { path: 'node_modules/x/index.js', exports: ['x'] },
      { path: '.git/HEAD', exports: [] },
      { path: 'dist/index.js', exports: [] },
    ]);
    expect(map).toBe(renderMap(scaffold));
    expect(map).not.toMatch(/node_modules|\.git|dist/);
  });

  const big = Array.from({ length: 400 }, (_, i) => ({
    path: `src/${['a', 'b', 'c'][i % 3]}/deep/${i % 2 ? 'x' : 'y'}/file${i}.ts`,
    exports: [`sym${i}`],
  }));

  it('trims over-budget maps by collapsing the deepest, then largest directory to a count and ends with [trimmed]', () => {
    const map = renderMap(big, 2048);
    expect(Buffer.byteLength(map)).toBeLessThanOrEqual(2048);
    expect(map.endsWith('\n[trimmed]')).toBe(true);
    expect(map).toMatch(/^ {6}x\/ \(\d+ files\)$/m);
    expect(map).not.toMatch(/file\d+\.ts/);
    expect(renderMap(big, 1 << 20)).not.toContain('[trimmed]');
    expect(Buffer.byteLength(renderMap(big))).toBeLessThanOrEqual(6144);
  });

  it('the same over-budget tree always trims the same way', () => {
    const a = renderMap(big, 2048);
    const b = renderMap([...big].reverse(), 2048);
    expect(b).toBe(a);
  });

  it('an empty tree renders the one-line empty notice', () => {
    expect(renderMap([])).toBe(EMPTY_MAP_NOTICE);
    expect(EMPTY_MAP_NOTICE).not.toContain('\n');
    expect(renderMap([{ path: 'node_modules/a.js', exports: [] }])).toBe(EMPTY_MAP_NOTICE);
  });
});
