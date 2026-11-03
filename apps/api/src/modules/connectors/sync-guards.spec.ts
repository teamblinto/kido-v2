import { describe, expect, it } from 'vitest';

import { position, pullDecision, pushDecision } from './sync-guards';

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
