/**
 * The pure decisions of a push and a pull (contracts § 5–6). The consumer supplies the heads and
 * `isAncestor(a, b)` — git's `merge-base --is-ancestor a b`, true when `a` is reachable from `b`.
 */
export interface SyncHeads {
  readonly isAncestor: (a: string, b: string) => boolean;
  readonly localHead: string;
  /** `null` when the remote branch does not exist yet. */
  readonly remoteHead: string | null;
}

export type PushDecision = 'nothing-to-push' | 'push' | 'remote-ahead';
export type PullDecision = 'diverged' | 'level' | 'pull';
export type Position = 'ahead' | 'behind' | 'diverged' | 'level' | 'unknown';

/** A push is a fast-forward of the remote or nothing; never `--force`. */
export function pushDecision({ isAncestor, localHead, remoteHead }: SyncHeads): PushDecision {
  if (remoteHead === null) return 'push';
  if (remoteHead === localHead) return 'nothing-to-push';

  return isAncestor(remoteHead, localHead) ? 'push' : 'remote-ahead';
}

/** A pull is a fast-forward of the local head or nothing; anything else is `diverged`. */
export function pullDecision({ isAncestor, localHead, remoteHead }: SyncHeads): PullDecision {
  if (remoteHead === null || remoteHead === localHead) return 'level';

  return isAncestor(localHead, remoteHead) ? 'pull' : 'diverged';
}

export interface LinkHeads {
  /** The sha of `last_pushed_checkpoint_id`, `null` when nothing was pushed. */
  readonly lastPushedSha: string | null;
  readonly remoteHeadSha: string | null;
}

/** Contracts § 5: a hint from the last sync; the consumer's `isAncestor` is the truth. */
export function position({ lastPushedSha, remoteHeadSha }: LinkHeads, head: string): Position {
  if (remoteHeadSha === null) return 'unknown';
  if (head === remoteHeadSha) return 'level';
  if (remoteHeadSha === lastPushedSha) return 'ahead';
  if (head === lastPushedSha) return 'behind';

  return 'diverged';
}
