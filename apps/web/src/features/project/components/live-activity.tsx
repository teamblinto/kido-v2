import type { RunResponse } from '@repo/contracts';
import { CheckCircle2Icon, CircleAlertIcon, CircleStopIcon } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';

import { cn } from '@/lib/utils';
import { type TimelineRow, formatDuration, liveActivity } from '../lib/timeline';

/*
 * One shared one-second clock (t3code's `secondTick`): every timer on screen reads the same tick,
 * and only the small components that show a time re-render on it — never the conversation.
 */
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let now = Date.now();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  if (timer === undefined) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, 1_000);
  }

  return () => {
    listeners.delete(listener);

    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** The wall clock, to the second. */
function useNow(): number {
  return useSyncExternalStore(
    subscribe,
    () => now,
    () => now,
  );
}

/** How long a run has been at it: from when a worker picked it up, else from when it was asked. */
function startOf(run: RunResponse): number {
  return new Date(run.startedAt ?? run.createdAt).getTime();
}

/** "12s", "1m 12s" — never negative, whatever the two clocks think of each other. */
function elapsed(from: number, to: number): string {
  return Number.isNaN(from) ? '' : formatDuration(Math.max(0, to - from));
}

/**
 * How long nothing new must have arrived before a reply counts as finished streaming. Long
 * enough to ride out a pause between tokens, short enough that "Wrapping up" appears while the
 * turn-end commit is still visibly in progress.
 */
const QUIET_MS = 1_500;

/**
 * The conversation's live foot (t3code's working row): what the run is doing now — queued,
 * waking its workspace, thinking, writing, wrapping up, stopping — and for how long. Present for
 * exactly as long as the run is live, so the screen never claims work that is not happening and
 * never goes silent while work is.
 */
export function LiveActivityRow({
  isStopping,
  preparing,
  rows,
  run,
}: {
  readonly isStopping: boolean;
  readonly preparing: string | undefined;
  readonly rows: readonly TimelineRow[];
  readonly run: RunResponse | undefined;
}): React.JSX.Element | null {
  const clock = useNow();
  // When the conversation last changed, on this clock — what tells a reply still streaming from
  // one that has stopped and is being committed. Adjusted during render when the rows change
  // (React's "storing information from previous renders"), not in an effect.
  const [seen, setSeen] = useState({ at: clock, rows });

  if (seen.rows !== rows) setSeen({ at: clock, rows });

  const activity = liveActivity(run, rows, {
    isQuiet: clock - seen.at >= QUIET_MS,
    isStopping,
    preparing,
  });

  if (activity === undefined || run === undefined) return null;

  return (
    <div
      className="animate-in fade-in-0 flex items-center gap-2 py-0.5"
      data-testid="live-activity"
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-2 shrink-0 rounded-full',
          activity.isActive ? 'bg-brand animate-breathe' : 'bg-warning',
        )}
      />
      <span
        role="status"
        className={cn(
          'text-label-xs font-medium',
          activity.isActive ? 'chat-shine text-foreground' : 'text-subdued',
        )}
      >
        {activity.label}
      </span>
      {activity.isActive ? (
        <span aria-hidden="true" className="text-caption text-faint tabular-nums">
          {elapsed(startOf(run), clock)}
        </span>
      ) : null}
    </div>
  );
}

/** When a finished run ended: its record's `endedAt`, else the terminal `state` event's time. */
function endOf(run: RunResponse, endedAt: string | undefined): number {
  return new Date(run.endedAt ?? endedAt ?? Number.NaN).getTime();
}

/**
 * How the turn ended, said once at the foot of a finished run (t3code's turn fold): "Worked for
 * 1m 12s", "Stopped after 12s", "Failed after 40s" — with the model it ran on.
 */
export function TurnOutcome({
  endedAt,
  model,
  run,
}: {
  /** The terminal `state` event's `at`, for the moment before the record has caught up. */
  readonly endedAt: string | undefined;
  readonly model: string;
  readonly run: RunResponse;
}): React.JSX.Element | null {
  const outcome =
    run.status === 'succeeded'
      ? { Icon: CheckCircle2Icon, tone: 'text-success', verb: 'Worked for' }
      : run.status === 'cancelled'
        ? { Icon: CircleStopIcon, tone: 'text-subdued', verb: 'Stopped after' }
        : run.status === 'failed'
          ? { Icon: CircleAlertIcon, tone: 'text-danger', verb: 'Failed after' }
          : undefined;

  if (outcome === undefined) return null;

  const took = elapsed(startOf(run), endOf(run, endedAt));
  const { Icon } = outcome;

  return (
    <p className="text-caption text-faint animate-in fade-in-0 flex items-center gap-1.5">
      <Icon className={cn('size-3.5 shrink-0', outcome.tone)} aria-hidden="true" />
      <span>
        {[took === '' ? undefined : `${outcome.verb} ${took}`, model].filter(Boolean).join(' · ')}
      </span>
    </p>
  );
}
