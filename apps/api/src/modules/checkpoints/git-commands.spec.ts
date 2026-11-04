import { describe, expect, it } from 'vitest';

import { DEFAULT_DAYTONA_TIMINGS } from '../sandbox/sandbox.constants';
import { checkCommand } from '../sandbox/sandbox-guards';
import {
  DIFF_FILE_CAP_BYTES,
  EMPTY_TREE,
  filesLabel,
  gitAdd,
  gitBundle,
  gitCommit,
  gitDiff,
  gitDiffQuiet,
  gitDiffTree,
  gitFetchBundle,
  gitGitDir,
  gitInit,
  gitLogSubject,
  gitLsTree,
  gitMergeFfOnly,
  gitReadTree,
  gitRemoveFile,
  gitRevList,
  gitRevParse,
  gitStatus,
  isClean,
  parseLsTree,
  parseNameStatus,
  parseSha,
  sanitiseLabel,
  splitDiff,
  turnLabel,
} from './git-commands';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

/** Spec 016 R1/R3/R5/R6/R7: every git step is one string `checkCommand` admits, pure and parsed here. */
describe('git commands', () => {
  it('spells each step as the contract does', () => {
    expect(gitInit()).toBe('git init -q');
    expect(gitAdd()).toBe('git add -A');
    expect(gitCommit('Turn 3')).toBe(
      'git -c user.name=forge -c user.email=forge@forge.local commit -q -m "Turn 3"',
    );
    expect(gitRevParse()).toBe('git rev-parse HEAD');
    expect(gitGitDir()).toBe('git rev-parse --git-dir');
    expect(gitStatus()).toBe('git status --porcelain');
    expect(gitDiffTree(A, B)).toBe(`git diff-tree --name-status -r -M ${A} ${B}`);
    expect(gitDiffTree(null, B)).toBe(`git diff-tree --name-status -r -M ${EMPTY_TREE} ${B}`);
    expect(gitDiff(A, B)).toBe(`git diff ${A} ${B}`);
    expect(gitDiff(null, B)).toBe(`git diff ${EMPTY_TREE} ${B}`);
    expect(gitDiffQuiet(A, B)).toBe(`git diff --quiet ${A} ${B}`);
    expect(gitReadTree(A)).toBe(`git read-tree -u --reset ${A}`);
    expect(gitBundle()).toBe('git bundle create .git/forge-mirror.bundle --all');
    expect(gitLsTree(A)).toBe(`git ls-tree -r -l ${A}`);
    expect(gitFetchBundle('.git/forge-pull.bundle')).toBe('git fetch -q .git/forge-pull.bundle');
    expect(gitMergeFfOnly()).toBe('git merge -q --ff-only FETCH_HEAD');
    expect(gitRevList(A, B)).toBe(`git rev-list --reverse ${A}..${B}`);
    expect(gitLogSubject(A)).toBe(`git log -1 --format=%s ${A}`);
    expect(gitRemoveFile('.git/forge-pull.bundle')).toBe('rm -f .git/forge-pull.bundle');
  });

  it('refuses a path with a shell operator or outside .git in the pull steps (018 T033)', () => {
    expect(() => gitFetchBundle('.git/x; rm -rf /')).toThrow();
    expect(() => gitRemoveFile('a b')).toThrow();
    expect(() => gitFetchBundle('src/app.ts')).toThrow();
    expect(() => gitRevList('HEAD', B)).toThrow();
    expect(() => gitLogSubject('HEAD')).toThrow();
  });

  it('refuses a sha that is not forty hex characters in a command', () => {
    expect(() => gitReadTree('HEAD; rm -rf /')).toThrow();
    expect(() => gitDiffTree('abc', B)).toThrow();
  });

  it('passes every command through the sandbox guard', () => {
    for (const command of [
      gitInit(),
      gitAdd(),
      gitCommit('Baseline: vite-react forge-tpl-1'),
      gitCommit('Revert to "Turn 2"; rm -rf / && $(x) | y `z` <a >b\n'),
      gitRevParse(),
      gitGitDir(),
      gitStatus(),
      gitDiffTree(null, B),
      gitDiff(A, B),
      gitDiffQuiet(A, B),
      gitReadTree(A),
      gitBundle(),
      gitLsTree(A),
      gitFetchBundle('.git/forge-pull.bundle'),
      gitMergeFfOnly(),
      gitRevList(A, B),
      gitLogSubject(A),
      gitRemoveFile('.git/forge-pull.bundle'),
    ]) {
      expect(() => checkCommand(command, DEFAULT_DAYTONA_TIMINGS.execAllowlist)).not.toThrow();
    }
  });

  it('strips quotes and shell operators from a label, and never commits an empty one', () => {
    expect(sanitiseLabel('Revert to "Turn 2"; rm -rf / && $(x) | y `z` <a >b\n')).toBe(
      'Revert to Turn 2 rm -rf /  (x)  y z a b',
    );
    expect(sanitiseLabel('  ')).toBe('Checkpoint');
    // A backslash would escape the quote that closes `-m "…"` on the daemon's bash.
    expect(sanitiseLabel('Turn \\" 2')).toBe('Turn  2');
  });

  it('accepts only a forty-hex sha from rev-parse', () => {
    expect(parseSha(`${A}\n`)).toBe(A);
    expect(() => parseSha('fatal: not a git repository')).toThrow();
    expect(() => parseSha('')).toThrow();
  });

  it('reads a porcelain status as clean only when empty', () => {
    expect(isClean('\n')).toBe(true);
    expect(isClean(' M src/a.ts\n?? new.ts\n')).toBe(false);
  });

  it('parses name-status lines, renames with their score, type changes as modifications', () => {
    expect(
      parseNameStatus(
        'A\tsrc/new.ts\nM\tsrc/a.ts\nD\tsrc/old.ts\nR087\tsrc/x.ts\tsrc/y.ts\nT\tlink\n',
      ),
    ).toEqual([
      { path: 'src/new.ts', status: 'A' },
      { path: 'src/a.ts', status: 'M' },
      { path: 'src/old.ts', status: 'D' },
      { path: 'src/y.ts', status: 'R' },
      { path: 'link', status: 'M' },
    ]);
    expect(parseNameStatus('')).toEqual([]);
    expect(() => parseNameStatus('X\tsrc/a.ts')).toThrow();
  });

  it('reads ls-tree sizes per blob path and skips what is not a blob', () => {
    expect(
      parseLsTree(
        `100644 blob ${A}    1234\tsrc/a.ts\n` +
          `160000 commit ${B}       -\tvendor\n` +
          `100644 blob ${A}       0\tsrc/with space.ts\n`,
      ),
    ).toEqual(
      new Map([
        ['src/a.ts', 1234],
        ['src/with space.ts', 0],
      ]),
    );
    expect(parseLsTree('')).toEqual(new Map());
  });

  describe('splitDiff', () => {
    const text = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1 @@',
      '+hi',
      'diff --git a/src/gone.ts b/src/gone.ts',
      'deleted file mode 100644',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      'diff --git a/src/x.ts b/src/y.ts',
      'similarity index 90%',
      'rename from src/x.ts',
      'rename to src/y.ts',
      'diff --git a/logo.png b/logo.png',
      'index 3333333..4444444 100644',
      'Binary files a/logo.png and b/logo.png differ',
      '',
    ].join('\n');

    it('splits per file with status, marks binaries, keeps the patch text', () => {
      const files = splitDiff(text);
      expect(files.map((file) => [file.path, file.status, file.binary])).toEqual([
        ['src/a.ts', 'M', false],
        ['src/new.ts', 'A', false],
        ['src/gone.ts', 'D', false],
        ['src/y.ts', 'R', false],
        ['logo.png', 'M', true],
      ]);
      expect(files[0]).toEqual({
        binary: false,
        path: 'src/a.ts',
        patch: text.slice(0, text.indexOf('diff --git a/src/new.ts')),
        status: 'M',
        truncated: false,
      });
      expect(files[4]).toEqual({ binary: true, path: 'logo.png', status: 'M' });
      expect(splitDiff('')).toEqual([]);
    });

    it('caps a file patch at one MiB and says so', () => {
      const big = `diff --git a/big.txt b/big.txt\n--- a/big.txt\n+++ b/big.txt\n+${'x'.repeat(DIFF_FILE_CAP_BYTES)}\n`;
      const [file] = splitDiff(big);
      expect(file).toMatchObject({ binary: false, path: 'big.txt', status: 'M', truncated: true });
      expect(Buffer.byteLength((file as { patch: string }).patch)).toBe(DIFF_FILE_CAP_BYTES);
    });
  });
});

/** Spec 044 decision 6: deterministic, and never able to block the commit it heads. */
describe('turnLabel', () => {
  it('is the first non-empty line of the prompt, plain on the first turn', () => {
    expect(turnLabel('\n  \n  Fix the login page  \nand the footer', 1)).toBe('Fix the login page');
  });

  it('says which turn past the first', () => {
    expect(turnLabel('Fix the login page', 3)).toBe('Fix the login page (turn 3)');
  });

  it.each([
    ['no summary', undefined],
    ['null', null],
    ['an empty prompt', ''],
    ['only blank lines', ' \n\t\n'],
    ['nothing a commit message can carry', '$$$ ``` ;;; |||'],
  ])('%s falls back to Turn n', (_name, summary) => {
    expect(turnLabel(summary, 2)).toBe('Turn 2');
  });

  it('scrubs a secret before anything else', () => {
    const label = turnLabel(`deploy with ghp_${'a'.repeat(36)} please`, 1);

    expect(label).not.toContain('ghp_');
    expect(label).toContain('[Redacted');
  });

  it('keeps nothing a shell would read, and no control character', () => {
    const label = turnLabel('add `$(rm -rf /)` "now"; a\tb\u0000c \\ | d', 1);

    expect(label).not.toMatch(/["\\;&|`$<>\p{Cc}]/u);
    expect(() => gitCommit(label)).not.toThrow();
  });

  it('cuts at 72 on a word boundary, the turn suffix inside the width', () => {
    const prompt = `${'word '.repeat(30)}end`;

    expect(turnLabel(prompt, 1)).toHaveLength(69);
    expect(turnLabel(prompt, 1).endsWith('word')).toBe(true);
    expect(turnLabel(prompt, 12).length).toBeLessThanOrEqual(72);
    expect(turnLabel(prompt, 12).endsWith('word (turn 12)')).toBe(true);
  });

  it('cuts a line with no space at the width', () => {
    expect(turnLabel('x'.repeat(100), 1)).toBe('x'.repeat(72));
  });

  it('exactly 72 stays whole', () => {
    const prompt = `${'y'.repeat(30)} ${'z'.repeat(41)}`;

    expect(turnLabel(prompt, 1)).toBe(prompt);
  });
});

/** Spec 044 decision 8: `status --porcelain` read back as a subject. */
describe('filesLabel', () => {
  it.each([
    [' M src/a.ts\n', 'Update a.ts'],
    ['?? a.ts\n M b.ts\n', 'Update a.ts and b.ts'],
    [' M a.ts\n M b.ts\n?? c.ts\n', 'Update a.ts, b.ts and 1 more'],
    [' M a.ts\n M b.ts\n?? c.ts\n D d.ts\n', 'Update a.ts, b.ts and 2 more'],
    ['R  old.ts -> src/new.ts\n', 'Update new.ts'],
    ['?? web/\n', 'Update web'],
    ['?? "with space.ts"\n', 'Update with space.ts'],
  ])('%j', (status, label) => {
    expect(filesLabel(status)).toBe(label);
  });
});
