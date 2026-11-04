import type { RunLineResponse, RunResponse } from '@repo/contracts';
import { useMutation } from '@tanstack/react-query';

import { useNow } from '@/hooks/use-now';
import { cn } from '@/lib/utils';
import { cancelRun } from '../api';
import { useRunLine } from '../hooks/use-run-line';
import { useRunList } from '../hooks/use-run-list';
import { describeAge } from '../lib/describe-age';
import { statusToPhase } from '../lib/run-phase';
import { EmptyPane } from './empty-pane';
import { RunStatusChip } from './run-status-chip';

interface RunListProps {
  readonly className?: string;
  /**
   * Put a run on screen. The caller hands `useRun`'s own `selectRun`, so choosing a row and
   * opening `?run=<id>` are the same act (FR-019) rather than two paths that can drift.
   */
  onSelect: (runId: string) => void;
  readonly orgId: string | undefined;
  /**
   * What the caller holds on this project; `project:agent.run` offers cancel on waiting runs.
   */
  readonly permissions?: readonly string[] | undefined;
  readonly projectId: string | undefined;
  /** The run the address currently names, so the list can mark where you are. */
  readonly selectedRunId?: string | undefined;
}

/**
 * A run, as a way back into it. A run waiting for input is answered from the chat composer once it
 * is on screen (spec 043), so the row carries no answer box of its own.
 */
function RunRow({
  isSelected,
  now,
  onSelect,
  run,
}: {
  isSelected: boolean;
  now: number;
  onSelect: (runId: string) => void;
  run: RunResponse;
}): React.JSX.Element {
  const phase = statusToPhase(run.status);

  return (
    <li>
      <button
        type="button"
        aria-current={isSelected ? 'true' : undefined}
        onClick={() => {
          onSelect(run.id);
        }}
        className={cn(
          'hover:bg-secondary/60 flex w-full flex-col items-start gap-1.5 rounded-lg px-3 py-2.5 text-left transition-colors',
          isSelected && 'bg-secondary',
        )}
      >
        <span className="flex w-full items-center gap-2">
          <RunStatusChip phase={phase} />
          <span className="text-caption text-faint ml-auto">{describeAge(run.createdAt, now)}</span>
        </span>
        <span
          className={cn(
            'text-body-sm line-clamp-2',
            run.promptExcerpt === '' ? 'text-faint italic' : 'text-foreground',
          )}
        >
          {run.promptExcerpt === '' ? 'No prompt' : run.promptExcerpt}
        </span>
      </button>
    </li>
  );
}

const ordinal = new Intl.PluralRules('en', { type: 'ordinal' });
const SUFFIX: Readonly<Record<string, string>> = { few: 'rd', one: 'st', other: 'th', two: 'nd' };

function nth(n: number): string {
  return `${n}${SUFFIX[ordinal.select(n)] ?? 'th'}`;
}

/** What the holder is doing, so a line that is not moving says why (spec 031 edge cases). */
function holderSentence(holder: NonNullable<RunLineResponse['holder']>): string {
  const who = holder.startedBy.email;

  if (holder.status === 'awaiting_input') return `${who}’s run is waiting for an answer`;
  if (holder.status === 'paused') return `${who}’s run is paused`;

  return `${who} is running`;
}

/** The project's holder and the runs waiting behind it (spec 031 US1). Nothing when both are empty. */
function RunLine({
  mayCancel,
  orgId,
  projectId,
}: {
  mayCancel: boolean;
  orgId: string | undefined;
  projectId: string | undefined;
}): React.JSX.Element | null {
  const line = useRunLine({ orgId, projectId });
  const cancel = useMutation({
    mutationFn: (runId: string) => cancelRun(orgId ?? '', projectId ?? '', runId),
    onSettled: () => line.refetch(),
  });
  const data = line.data;

  if (data === undefined || (data.holder === null && data.waiting.length === 0)) {
    return null;
  }

  return (
    <section
      aria-label="Run line"
      className="border-line-subtle flex flex-col gap-1 border-b px-3 pb-2"
    >
      {data.holder === null ? null : (
        <p className="text-body-sm text-foreground">{holderSentence(data.holder)}</p>
      )}
      <ol className="flex flex-col gap-1">
        {data.waiting.map((entry) => (
          <li key={entry.runId} className="flex items-center gap-2">
            <span className="text-body-sm text-subdued">
              Waiting, {nth(entry.position)} in line
            </span>
            <span className="text-caption text-faint">{entry.startedBy.email}</span>
            {mayCancel ? (
              <button
                type="button"
                aria-label={`Cancel waiting run, ${nth(entry.position)} in line`}
                disabled={cancel.isPending}
                onClick={() => {
                  cancel.mutate(entry.runId);
                }}
                className="text-subdued hover:text-foreground text-caption ml-auto transition-colors"
              >
                Cancel
              </button>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * The project's runs, newest first, as a way back into any of them.
 *
 * The list does not own which run is on screen — the address does. Choosing a row calls the
 * caller's `onSelect`, which is `useRun`'s `selectRun`, which writes `?run=<id>` through the
 * router: exactly what typing that URL does (FR-019).
 */
export function RunList({
  className,
  onSelect,
  orgId,
  permissions,
  projectId,
  selectedRunId,
}: RunListProps): React.JSX.Element {
  const mayRun = permissions?.includes('project:agent.run') === true;
  const line = <RunLine mayCancel={mayRun} orgId={orgId} projectId={projectId} />;
  const { hasMore, isError, isLoading, isLoadingMore, loadMore, runs } = useRunList({
    orgId,
    projectId,
  });
  const now = useNow();

  if (isLoading) {
    return <p className="text-faint text-body-sm px-3 py-5">Loading this project's runs…</p>;
  }

  if (isError) {
    return (
      <EmptyPane
        title="The runs could not be loaded"
        body="Something went wrong reading this project's runs. Try again in a moment."
      />
    );
  }

  if (runs.length === 0) {
    return (
      <div className={cn('flex flex-col gap-1', className)}>
        {line}
        <EmptyPane
          title="Nothing has run yet"
          body="Every instruction you send starts a run, and it is listed here."
        />
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {line}
      <ul className="flex flex-col gap-0.5">
        {runs.map((run) => (
          <RunRow
            key={run.id}
            isSelected={run.id === selectedRunId}
            now={now}
            onSelect={onSelect}
            run={run}
          />
        ))}
      </ul>

      {hasMore ? (
        <button
          type="button"
          onClick={loadMore}
          disabled={isLoadingMore}
          className="text-subdued hover:text-foreground text-body-sm self-start px-3 py-2 transition-colors disabled:opacity-60"
        >
          {isLoadingMore ? 'Loading older runs…' : 'Load older'}
        </button>
      ) : null}
    </div>
  );
}
