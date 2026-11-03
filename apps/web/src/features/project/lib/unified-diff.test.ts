import { describe, expect, it } from 'vitest';

import { parseUnifiedDiff } from './unified-diff';

describe('parseUnifiedDiff', () => {
  it('numbers a single hunk of add, remove and context lines', () => {
    const hunks = parseUnifiedDiff(
      [
        '@@ -3,3 +3,3 @@ function greet()',
        ' const a = 1;',
        '-const b = 2;',
        '+const b = 3;',
        ' const c = 4;',
      ].join('\n'),
    );

    expect(hunks).toEqual([
      {
        header: '@@ -3,3 +3,3 @@ function greet()',
        lines: [
          { content: 'const a = 1;', kind: 'context', newLine: 3, oldLine: 3 },
          { content: 'const b = 2;', kind: 'remove', newLine: null, oldLine: 4 },
          { content: 'const b = 3;', kind: 'add', newLine: 4, oldLine: null },
          { content: 'const c = 4;', kind: 'context', newLine: 5, oldLine: 5 },
        ],
        newStart: 3,
        oldStart: 3,
      },
    ]);
  });

  // The whole point of a `@@` header: numbering is not a running count over the file, it restarts
  // from whatever the header says.
  it('restarts numbering at each hunk header', () => {
    const hunks = parseUnifiedDiff(
      ['@@ -1,1 +1,1 @@', ' first', '@@ -40,2 +50,2 @@', ' fortieth', '+added'].join('\n'),
    );

    expect(hunks).toHaveLength(2);
    expect(hunks[1]?.oldStart).toBe(40);
    expect(hunks[1]?.newStart).toBe(50);
    expect(hunks[1]?.lines).toEqual([
      { content: 'fortieth', kind: 'context', newLine: 50, oldLine: 40 },
      { content: 'added', kind: 'add', newLine: 51, oldLine: null },
    ]);
  });

  // git's marker for a file that ends without a newline. It belongs on screen, but it is a note
  // about the line above rather than a line of either side, so it consumes no number.
  it('keeps a no-newline marker as an unnumbered context line', () => {
    const hunks = parseUnifiedDiff(
      ['@@ -1,1 +1,1 @@', '-old', '\\ No newline at end of file', '+new'].join('\n'),
    );

    expect(hunks[0]?.lines).toEqual([
      { content: 'old', kind: 'remove', newLine: null, oldLine: 1 },
      { content: '\\ No newline at end of file', kind: 'context', newLine: null, oldLine: null },
      { content: 'new', kind: 'add', newLine: 1, oldLine: null },
    ]);
  });

  it('reads an empty or whitespace-only patch as no hunks', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('   \n\n')).toEqual([]);
  });

  it('ignores the file headers git puts above the first hunk', () => {
    const hunks = parseUnifiedDiff(
      [
        'diff --git a/x.ts b/x.ts',
        'index 111..222 100644',
        '--- a/x.ts',
        '+++ b/x.ts',
        '@@ -1 +1 @@',
        '+x',
      ].join('\n'),
    );

    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.lines).toEqual([{ content: 'x', kind: 'add', newLine: 1, oldLine: null }]);
  });
});
