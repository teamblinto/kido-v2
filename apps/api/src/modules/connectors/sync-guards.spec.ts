import { describe, expect, it } from 'vitest';

import { classifyPushRejection, position, pullDecision, pushDecision } from './sync-guards';

const H = 'h'.repeat(40);
const R = 'r'.repeat(40);
const L = 'l'.repeat(40);

/** `isAncestor(a, b)` is true when `a` is reachable from `b` — the git `merge-base --is-ancestor a b` answer. */
function ancestry(pairs: readonly (readonly [string, string])[]) {
  return (a: string, b: string) => pairs.some(([x, y]) => x === a && y === b);
}

describe('pushDecision', () => {
  it('pushes into an empty remote', () => {
    expect(pushDecision({ isAncestor: ancestry([]), localHead: H, remoteHead: null })).toBe('push');
  });

  it('has nothing to push when the remote already holds the head', () => {
    expect(pushDecision({ isAncestor: ancestry([]), localHead: H, remoteHead: H })).toBe(
      'nothing-to-push',
    );
  });

  it('pushes when the remote is an ancestor of the head (fast-forward)', () => {
    expect(pushDecision({ isAncestor: ancestry([[R, H]]), localHead: H, remoteHead: R })).toBe(
      'push',
    );
  });

  it('refuses as remote-ahead when the remote is not behind the head', () => {
    expect(pushDecision({ isAncestor: ancestry([[H, R]]), localHead: H, remoteHead: R })).toBe(
      'remote-ahead',
    );
    expect(pushDecision({ isAncestor: ancestry([]), localHead: H, remoteHead: R })).toBe(
      'remote-ahead',
    );
  });
});

describe('pullDecision', () => {
  it('is level when the heads match or the remote is empty', () => {
    expect(pullDecision({ isAncestor: ancestry([]), localHead: H, remoteHead: H })).toBe('level');
    expect(pullDecision({ isAncestor: ancestry([]), localHead: H, remoteHead: null })).toBe(
      'level',
    );
  });

  it('pulls when the local head is an ancestor of the remote (fast-forward)', () => {
    expect(pullDecision({ isAncestor: ancestry([[H, R]]), localHead: H, remoteHead: R })).toBe(
      'pull',
    );
  });

  it('is diverged otherwise, including when the local side is ahead', () => {
    expect(pullDecision({ isAncestor: ancestry([[R, H]]), localHead: H, remoteHead: R })).toBe(
      'diverged',
    );
    expect(pullDecision({ isAncestor: ancestry([]), localHead: H, remoteHead: R })).toBe(
      'diverged',
    );
  });
});

describe('position (contracts § 5)', () => {
  it('is unknown when the remote head was never fetched', () => {
    expect(position({ lastPushedSha: L, remoteHeadSha: null }, H)).toBe('unknown');
  });

  it('is level when the project head equals the remote head', () => {
    expect(position({ lastPushedSha: L, remoteHeadSha: H }, H)).toBe('level');
  });

  it('is ahead when the remote still holds the last push and the head moved on', () => {
    expect(position({ lastPushedSha: L, remoteHeadSha: L }, H)).toBe('ahead');
  });

  it('is behind when the head is the last push and the remote moved on', () => {
    expect(position({ lastPushedSha: L, remoteHeadSha: R }, L)).toBe('behind');
  });

  it('is diverged otherwise, including with no push recorded', () => {
    expect(position({ lastPushedSha: L, remoteHeadSha: R }, H)).toBe('diverged');
    expect(position({ lastPushedSha: null, remoteHeadSha: R }, H)).toBe('diverged');
  });
});

/** Spec 044: stderr as git and GitHub print it; the reason is all that goes further. */
describe('classifyPushRejection', () => {
  const rejected = (detail: string) =>
    `To https://github.com/acme/site.git\n ! [rejected]        abc -> main (${detail})\nerror: failed to push some refs to 'https://github.com/acme/site.git'\n`;

  it.each([
    ['non-fast-forward', rejected('non-fast-forward'), 'remote-ahead'],
    ['fetch first', rejected('fetch first'), 'remote-ahead'],
    ['stale info', rejected('stale info'), 'remote-ahead'],
    [
      'GH006',
      `remote: error: GH006: Protected branch update failed for refs/heads/main.\nremote: error: Changes must be made through a pull request.\n ! [remote rejected] abc -> main (protected branch hook declined)\n`,
      'branch-protected',
    ],
    [
      'a ruleset',
      `remote: error: GH013: Repository rule violations found for refs/heads/main.\nremote: Review all repository rules at https://github.com/acme/site/rules?ref=refs%2Fheads%2Fmain\nremote:\nremote: - Changes must be made through a pull request.\n ! [remote rejected] abc -> main (push declined due to repository rule violations)\n`,
      'branch-protected',
    ],
    [
      'secret scanning under GH013',
      `remote: error: GH013: Repository rule violations found for refs/heads/main.\nremote: - GITHUB PUSH PROTECTION\nremote:   Resolve the following violations before pushing again\nremote:   - Push cannot contain secrets\n ! [remote rejected] abc -> main (push declined due to repository rule violations)\n`,
      'push-rejected',
    ],
    [
      'GH001',
      `remote: error: GH001: Large files detected. You may want to try Git Large File Storage.\nremote: error: File big.bin is 120.00 MB; this exceeds GitHub's file size limit of 100.00 MB\n ! [remote rejected] abc -> main (pre-receive hook declined)\n`,
      'push-rejected',
    ],
    [
      'a workflow without the permission',
      ` ! [remote rejected] abc -> main (refusing to allow a GitHub App to create or update workflow \`.github/workflows/ci.yml\` without \`workflows\` permission)\n`,
      'workflow-permission',
    ],
  ])('%s', (_name, stderr, reason) => {
    expect(classifyPushRejection(stderr)).toBe(reason);
  });

  it.each([
    ['nothing', ''],
    ['a lost connection', 'fatal: unable to access: Could not resolve host: github.com\n'],
    ['an auth failure', 'remote: Invalid username or password.\nfatal: Authentication failed\n'],
    ['a generic hook', ' ! [remote rejected] abc -> main (pre-receive hook declined)\n'],
  ])('%s stays git-failed', (_name, stderr) => {
    expect(classifyPushRejection(stderr)).toBeUndefined();
  });
});
