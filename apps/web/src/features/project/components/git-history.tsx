import type { Checkpoint } from '@repo/contracts';
import { useState } from 'react';

import { messageFor } from '@/lib/api/problem';
import { cn } from '@/lib/utils';
import { useCheckpointDiff, useCheckpoints } from '../hooks/use-checkpoints';
import { CheckpointDiff } from './checkpoint-diff';
import { EmptyPane } from './empty-pane';

interface GitHistoryProps {
  readonly orgId: string | undefined;
  readonly projectId: string | undefined;
  /**
   * The revert control for one row, when the caller offers one (T020 passes the dialog's
   * trigger). `isHead` is true for the newest checkpoint, which cannot be reverted to.
   */
  readonly renderRevert?: (checkpoint: Checkpoint, isHead: boolean) => React.ReactNode;
}

/**
 * The project's history, newest first, and the diff at whichever point is open.
 *
 * Each row says its kind in plain words rather than in git's (FR-008), and a `revert` row names
 * the checkpoint it went back to — looked up among the rows already loaded, falling back to the
 * server's own label when the target is further back than the pane has paged.
 */
export function GitHistory({ orgId, projectId, renderRevert }: GitHistoryProps): React.JSX.Element {
  const project = { orgId, projectId };
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const checkpoints = useCheckpoints(project);
  const diff = useCheckpointDiff(project, selectedId);

  const rows = checkpoints.data?.checkpoints ?? [];

  if (checkpoints.isPending) {
    return <p className="text-faint text-body-sm px-6 py-5">Loading the project's history…</p>;
  }

  if (checkpoints.error !== null) {
    return (
      <EmptyPane title="The history could not be loaded" body={messageFor(checkpoints.error)} />
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyPane
        title="Nothing has been saved yet"
        body="Each turn that changes a file adds a point here."
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 px-6 py-5">
      <h2 className="text-overline text-faint font-medium uppercase">History</h2>

      <ul className="mt-3 flex flex-col gap-1.5">
        {rows.map((checkpoint, index) => {
          const isOpen = checkpoint.id === selectedId;

          return (
            <li key={checkpoint.id} className="border-line-subtle rounded border">
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => {
                  setSelectedId(isOpen ? undefined : checkpoint.id);
                }}
                className={cn(
                  'hover:bg-subtle flex w-full flex-col items-start gap-0.5 px-4 py-2.5 text-left',
                  isOpen && 'bg-subtle',
                )}
              >
                <span className="text-body-md text-foreground font-medium">
                  {describe(checkpoint, rows)}
                </span>
                <span className="text-faint text-body-sm">
                  {new Date(checkpoint.createdAt).toLocaleString()} · {who(checkpoint)} ·{' '}
                  {countFiles(checkpoint.files.length)}
                </span>
              </button>

              {renderRevert?.(checkpoint, index === 0)}

              {isOpen && (
                <CheckpointDiff
                  error={diff.error}
                  files={diff.data?.files}
                  isPending={diff.isPending}
                />
              )}
            </li>
          );
        })}
      </ul>

      {checkpoints.hasNextPage && (
        <button
          type="button"
          disabled={checkpoints.isFetchingNextPage}
          onClick={() => void checkpoints.fetchNextPage()}
          className="border-line text-body-sm text-subdued hover:bg-subtle mt-3 rounded border px-3 py-1.5 disabled:opacity-60"
        >
          {checkpoints.isFetchingNextPage ? 'Loading…' : 'Load older'}
        </button>
      )}
    </div>
  );
}

/** FR-008's plain words. A `revert` row names the point it went back to. */
function describe(checkpoint: Checkpoint, rows: readonly Checkpoint[]): string {
  switch (checkpoint.kind) {
    case 'baseline':
      return 'Starting point';
    case 'turn':
      return checkpoint.turn === null ? 'Run turn' : `Run turn ${String(checkpoint.turn)}`;
    case 'pull':
      return 'Pulled from GitHub';
    case 'revert': {
      const target = rows.find((row) => row.id === checkpoint.revertsId);
      return `Went back to ${target === undefined ? checkpoint.label : describe(target, rows)}`;
    }
    case 'edit': {
      // Spec 024's fifth kind, worded like the branches above rather than shown raw. The server's
      // label is `Edit <path>`; the row's own file summary is the better source for the path, and
      // the label is the fallback when a save ever records more or fewer than one file.
      const path = checkpoint.files[0]?.path;

      return path === undefined ? checkpoint.label : `Edited ${path}`;
    }
  }
}

/** Who or what made the point. The list carries ids, not names, so the run is the better handle. */
function who(checkpoint: Checkpoint): string {
  if (checkpoint.runId !== null) return 'By a run';
  return checkpoint.actorId === null ? 'By the system' : 'By a member';
}

function countFiles(count: number): string {
  return count === 1 ? '1 file' : `${String(count)} files`;
}
