import type { LinkPosition, RepoLink, SyncOperation } from '@repo/contracts';
import { useId, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useNow } from '@/hooks/use-now';
import { GitHubBranchPicker } from './github-branch-picker';
import { GitHubOperations } from './github-operations';
import { describeAge } from './lib/describe-age';
import { commitUrl, compareUrl, repoUrl, shortSha } from './lib/github-sync';

const POSITION: Record<
  LinkPosition,
  { readonly label: string; readonly variant: 'info' | 'muted' | 'success' | 'warning' }
> = {
  ahead: { label: 'Ahead of GitHub', variant: 'info' },
  behind: { label: 'Behind GitHub', variant: 'warning' },
  diverged: { label: 'Changed on both sides', variant: 'warning' },
  level: { label: 'Level with GitHub', variant: 'success' },
  unknown: { label: 'Not synced yet', variant: 'muted' },
};

function LastPushed({
  link,
  now,
  operations,
}: {
  readonly link: RepoLink;
  readonly now: number;
  readonly operations: readonly SyncOperation[];
}): React.JSX.Element {
  const last = operations.find(
    (op) => op.kind === 'push' && op.state === 'succeeded' && op.toSha !== null,
  );
  const sha = last?.toSha ?? link.remoteHeadSha;

  if (sha === null) return <>Not pushed yet</>;

  return (
    <>
      Last pushed{' '}
      <a
        href={commitUrl(link.repository.fullName, sha)}
        target="_blank"
        rel="noreferrer"
        className="hover:text-foreground font-mono underline"
      >
        {shortSha(sha)}
      </a>
      {last === undefined ? null : ` · ${describeAge(last.finishedAt ?? last.createdAt, now)}`}
    </>
  );
}

export interface GitHubLinkedProps {
  readonly base: string;
  /** A click of ours is on its way, as opposed to an operation GitHub-side. */
  readonly busy: boolean;
  /** What the last Commit & push came to, said beside the button. */
  readonly commitNote: string | undefined;
  readonly isInFlight: boolean;
  readonly isRunActive: boolean;
  readonly link: RepoLink;
  readonly onAutoSync: (autoSync: boolean) => void;
  readonly canWrite: boolean;
  /** `onSaved`: a refused commit keeps the message the person typed. */
  readonly onCommit: (message: string, onSaved: () => void) => void;
  readonly onCreateBranch: (name: string) => void;
  readonly onPull: () => void;
  readonly onPush: () => void;
  readonly onReconnect: () => void;
  readonly onSwitchBranch: (branch: string) => void;
  readonly onUnlink: () => void;
  readonly operations: readonly SyncOperation[];
}

/** A linked project: where it pushes, how that stands, and what a person can do about it. */
export function GitHubLinked({
  base,
  busy,
  commitNote,
  isInFlight,
  isRunActive,
  link,
  onAutoSync,
  canWrite,
  onCommit,
  onCreateBranch,
  onPull,
  onPush,
  onReconnect,
  onSwitchBranch,
  onUnlink,
  operations,
}: GitHubLinkedProps): React.JSX.Element {
  const [message, setMessage] = useState('');
  const now = useNow();
  const autoSyncId = useId();
  const disconnected = link.state === 'disconnected';
  const { fullName } = link.repository;
  const lockedBecause = isRunActive
    ? 'Branches can change once the run finishes.'
    : isInFlight
      ? 'Branches can change once this sync finishes.'
      : undefined;

  return (
    <div className="mt-3 flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <a
          href={repoUrl(fullName)}
          target="_blank"
          rel="noreferrer"
          className="text-body-sm min-w-0 truncate font-medium underline"
        >
          {fullName}
        </a>
        <Badge variant={POSITION[link.position].variant}>{POSITION[link.position].label}</Badge>
      </div>

      <p className="text-body-sm text-subdued">
        {isInFlight ? 'Syncing…' : <LastPushed link={link} now={now} operations={operations} />}
      </p>

      {disconnected ? (
        <Alert variant="warning" className="flex flex-col items-start gap-2">
          The connector was removed. Reconnect the organisation&apos;s GitHub to push or pull again.
          <Button size="sm" variant="outline" onClick={onReconnect}>
            Reconnect GitHub
          </Button>
        </Alert>
      ) : null}

      {/*
        Spec 044, decision 4: the work is safe on the side branch, so this is news and not an
        error. Pull is left to the server to answer; only a person can do the merge.
      */}
      {link.sideBranch !== null ? (
        <Alert role="status" className="text-foreground block" data-testid="side-branch">
          <span>
            The linked branch couldn&apos;t take your latest work, so it was saved to{' '}
            <code className="font-mono">{link.sideBranch}</code>. Nothing was overwritten.{' '}
            <a
              href={compareUrl(fullName, link.branch, link.sideBranch)}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              See the changes
            </a>
            . Merge it on GitHub, then pull.
          </span>
        </Alert>
      ) : null}

      {/*
        Spec 026 US3 (SC-010). A push at GitHub reaches this panel as one refreshed field — the
        link's `remoteHeadSha` — and nothing else moved: no run, no checkpoint, no operation to
        list. So the news is stated here rather than in the operation list, the commit is named so
        that it is a fact and not a mood, and the only thing offered is the pull that would answer
        it. Nothing is done automatically: FR-034 says a delivery never pulls.
      */}
      {!disconnected && link.position === 'behind' && link.remoteHeadSha !== null ? (
        <Alert variant="warning" className="flex flex-col items-start gap-2">
          <span data-testid="remote-ahead">
            The repository is ahead of the project at{' '}
            <code className="font-mono">{shortSha(link.remoteHeadSha)}</code>. Pull to bring the
            project up to date.
          </span>
          {canWrite ? (
            <Button size="sm" variant="outline" disabled={busy || isInFlight} onClick={onPull}>
              Pull from GitHub
            </Button>
          ) : null}
        </Alert>
      ) : null}

      {disconnected || !canWrite ? null : (
        <>
          <GitHubBranchPicker
            base={base}
            disabled={busy}
            link={link}
            lockedBecause={lockedBecause}
            onCreate={onCreateBranch}
            onSwitch={onSwitchBranch}
          />

          <div className="flex items-center justify-between gap-4">
            <label htmlFor={autoSyncId} className="text-body-sm font-medium">
              Push after every turn
            </label>
            <input
              id={autoSyncId}
              type="checkbox"
              role="switch"
              className="size-5 accent-current"
              checked={link.autoSync}
              aria-checked={link.autoSync}
              disabled={busy}
              onChange={(event) => {
                onAutoSync(event.target.checked);
              }}
            />
          </div>

          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              onCommit(message.trim(), () => {
                setMessage('');
              });
            }}
          >
            <Input
              aria-label="Commit message (optional)"
              className="h-8 min-w-0 flex-1"
              maxLength={200}
              placeholder="Message (optional)"
              value={message}
              onChange={(event) => {
                setMessage(event.target.value);
              }}
            />
            <Button type="submit" size="sm" disabled={busy}>
              Commit &amp; push
            </Button>
          </form>

          {commitNote === undefined ? null : (
            <p className="text-body-sm text-subdued" role="status">
              {commitNote}
            </p>
          )}
        </>
      )}

      {canWrite ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || isInFlight || disconnected}
            onClick={onPush}
          >
            Sync now
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || isInFlight || disconnected}
            onClick={onPull}
          >
            Pull
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onUnlink}>
            Unlink
          </Button>
        </div>
      ) : null}

      <GitHubOperations link={link} now={now} operations={operations.slice(0, 5)} />
    </div>
  );
}
