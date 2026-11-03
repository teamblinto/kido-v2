import { describe, expect, it } from 'vitest';

import { unifiedDiff } from './unified-diff';

/**
 * Every expected string below is what `git diff --no-index a/<path> b/<path>` printed for the same
 * two inputs, from the `---` line down. One deliberate difference: git appends a "function context"
 * hint after a hunk's second `@@` (`@@ -12,4 +12,4 @@ l11`), a heuristic over the file's syntax
 * that a diff meant for a model to read does not need — the header here ends at the `@@`.
 */
describe('unifiedDiff', () => {
  const lines = (...items: string[]) => `${items.join('\n')}\n`;

  it('prints a git-shaped unified diff for a one-line change, an insertion, a deletion and a new file', () => {
    expect(
      unifiedDiff(
        lines('alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'),
        lines('alpha', 'beta', 'gamma', 'DELTA', 'epsilon', 'zeta', 'eta', 'theta'),
        'change.txt',
      ),
    ).toBe(
      lines(
        '--- a/change.txt',
        '+++ b/change.txt',
        '@@ -1,7 +1,7 @@',
        ' alpha',
        ' beta',
        ' gamma',
        '-delta',
        '+DELTA',
        ' epsilon',
        ' zeta',
        ' eta',
      ),
    );

    expect(
      unifiedDiff(
        lines('one', 'two', 'three'),
        lines('one', 'two', 'two and a half', 'three'),
        'insert.txt',
      ),
    ).toBe(
      lines(
        '--- a/insert.txt',
        '+++ b/insert.txt',
        '@@ -1,3 +1,4 @@',
        ' one',
        ' two',
        '+two and a half',
        ' three',
      ),
    );

    expect(
      unifiedDiff(
        lines('one', 'two', 'three', 'four'),
        lines('one', 'three', 'four'),
        'delete.txt',
      ),
    ).toBe(
      lines(
        '--- a/delete.txt',
        '+++ b/delete.txt',
        '@@ -1,4 +1,3 @@',
        ' one',
        '-two',
        ' three',
        ' four',
      ),
    );

    expect(unifiedDiff(null, lines('hello', 'world'), 'new.txt')).toBe(
      lines('--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1,2 @@', '+hello', '+world'),
    );
  });

  it('splits distant changes into hunks and keeps three lines of context around each', () => {
    const before = lines(...Array.from({ length: 15 }, (_, index) => `l${String(index + 1)}`));
    const after = before.replace('l1\n', 'L1\n').replace('l15\n', 'L15\n');

    expect(unifiedDiff(before, after, 'twohunks.txt')).toBe(
      lines(
        '--- a/twohunks.txt',
        '+++ b/twohunks.txt',
        '@@ -1,4 +1,4 @@',
        '-l1',
        '+L1',
        ' l2',
        ' l3',
        ' l4',
        '@@ -12,4 +12,4 @@',
        ' l12',
        ' l13',
        ' l14',
        '-l15',
        '+L15',
      ),
    );
  });

  it('marks a missing final newline the way git does', () => {
    expect(unifiedDiff('no newline', 'no newline\n', 'nonl.txt')).toBe(
      lines(
        '--- a/nonl.txt',
        '+++ b/nonl.txt',
        '@@ -1 +1 @@',
        '-no newline',
        '\\ No newline at end of file',
        '+no newline',
      ),
    );
  });

  it('prints nothing for identical input', () => {
    expect(unifiedDiff(lines('same'), lines('same'), 'same.txt')).toBe('');
    expect(unifiedDiff('', '', 'empty.txt')).toBe('');
  });
});
