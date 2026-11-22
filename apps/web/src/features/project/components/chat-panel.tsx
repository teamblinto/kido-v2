import { type RunEvent, type RunResponse, SUBSCRIPTION_PROVIDERS } from '@repo/contracts';
import { ArrowDownIcon, BookmarkIcon, BoxIcon, MonitorIcon, RotateCcwIcon } from 'lucide-react';
import { useMemo } from 'react';

import { stateReason } from '@/features/settings/subscription-limit';
import { cn } from '@/lib/utils';
import { useFollowBottom } from '../hooks/use-follow-bottom';
import { isTerminal } from '../lib/run-phase';
import { type TimelineRow, type UserTurn, buildTimeline } from '../lib/timeline';
import type { Connection, TranscriptItem, TranscriptSource } from '../lib/transcript';
import { MessageAttachments } from './attachment-parts';
import { ChatMarkdown } from './chat-markdown';
import { LiveActivityRow, TurnOutcome } from './live-activity';
import { RunStateCard } from './run-state-card';
import { WorkGroup } from './work-group';

interface ChatPanelProps {
  /** Where an attachment's bytes are read (spec 048); without it a message's files are not drawn. */
  attachmentUrl?: (attachmentId: string) => string;
  className?: string;
  /** The box at the foot of the panel; the page owns what sending does. */
  composer?: React.ReactNode;
  /** What the transport is doing, for the strip above the composer (FR-010, FR-011). */
  connection: Connection;
  /** The run is still going: its last message is streaming. */
  isRunning: boolean;
  /** A stop was asked for and the run is winding down. */
  isStopping?: boolean;
  items: readonly TranscriptItem[];
  /** Open the stream again after it was given up on. */
  onRetry: () => void;
  /** Send a failed or cancelled run's prompt again, as a new run. Absent: no retry offered. */
  onRetryRun?: (() => void) | undefined;
  /**
   * The catalogue's sentence for a refused console action, when there is one.
   *
   * A rendered string rather than the error itself: the screen decides what a failure says, in
   * one place, through `MESSAGES` (FR-021). This component never sees a slug.
   */
  refusal?: string | undefined;
  /** Spec 032 T048: the one thing to do about the refusal, when there is one. */
  refusalAction?: { readonly label: string; readonly onClick: () => void } | undefined;
  /** The run the strip reports on, once it has been read. */
  run: RunResponse | undefined;
  /** Whether the transcript is being streamed or read back from the store. */
  source: TranscriptSource;
  /** What the person sent on this run, placed where they sent it. */
  turns?: readonly UserTurn[];
}

/**
 * The run's conversation, and the box to add to it (spec 043, after t3code's timeline).
 *
 * Every entry is an event the run sent, or something the person sent: nothing is filled in. The
 * list follows the bottom while the run streams, until the reader scrolls up; "Jump to latest"
 * brings them back. Streamed text is not announced token by token — the list is not a live region;
 * the end of a reply is announced once.
 */
export function ChatPanel({
  attachmentUrl,
  className,
  composer,
  connection,
  isRunning,
  isStopping = false,
  items,
  onRetry,
  onRetryRun,
  refusal,
  refusalAction,
  run,
  source,
  turns = [],
}: ChatPanelProps): React.JSX.Element {
  const rows = useMemo(() => buildTimeline(items, turns), [items, turns]);
  const { isFollowing, jumpToLatest, onScroll, ref } = useFollowBottom<HTMLDivElement>(rows);
  const lastRow = rows.at(-1);
  const isLive = source === 'live';
  const finished = run !== undefined && isTerminal(run.status);

  // The run's own words for the moments no row covers: the workspace starting, and when it ended.
  const { endedAt, preparing } = useMemo(() => {
    let ended: string | undefined;
    let transition: string | undefined;

    for (const { event } of items) {
      if (event.type === 'sandbox.preparing') transition = event.data.transition;
      if (event.type === 'state' && isTerminal(event.data.to)) ended = event.at;
    }

    return { endedAt: ended, preparing: transition };
  }, [items]);
  const canRetry =
    onRetryRun !== undefined && (run?.status === 'failed' || run?.status === 'cancelled');

  // The failed `state` event; the strip offers its remedy.
  const failure = useMemo(() => {
    for (const { event } of [...items].reverse()) {
      if (event.type === 'state' && event.data.to === 'failed') return event.data;
    }

    return undefined;
  }, [items]);

  return (
    <div
      className={cn(
        'bg-subtle border-line-subtle flex min-h-0 flex-col lg:w-[424px] lg:shrink-0 lg:border-r',
        className,
      )}
    >
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/*
          Off-screen rows skip layout and paint; the DOM keeps every event (R8, FR-021). The last
          child is the footer and is left alone.
        */}
        <div
          ref={ref}
          onScroll={onScroll}
          aria-label="Conversation"
          // A log is polite by default; streamed text must not be read out a token at a time.
          aria-live="off"
          role="log"
          className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 pt-[18px] pb-3 [&>*:not(:last-child)]:[contain-intrinsic-size:auto_64px] [&>*:not(:last-child)]:[content-visibility:auto]"
        >
          {rows.map((row) => (
            <div key={row.id} className={cn(isLive && 'chat-enter')}>
              <Row
                attachmentUrl={attachmentUrl}
                isStreaming={isRunning && row === lastRow && row.kind === 'assistant'}
                isTail={isRunning && row === lastRow}
                row={row}
              />
            </div>
          ))}
          <div className="flex flex-col items-start gap-2 empty:hidden">
            {isRunning ? (
              <LiveActivityRow
                isStopping={isStopping}
                preparing={preparing}
                rows={rows}
                run={run}
              />
            ) : null}
            {run === undefined ? null : finished ? (
              <TurnOutcome endedAt={endedAt} model={modelLabel(run.model)} run={run} />
            ) : (
              <p className="text-caption text-faint">{modelLabel(run.model)}</p>
            )}
            {canRetry ? (
              <button
                type="button"
                onClick={onRetryRun}
                className={cn(
                  'border-line bg-raised text-label-xs text-foreground hover:bg-subtle',
                  'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 font-medium',
                  'transition-[background-color,transform] active:scale-95',
                )}
              >
                <RotateCcwIcon className="size-3" aria-hidden="true" />
                Retry
              </button>
            ) : null}
          </div>
        </div>

        {isFollowing ? null : (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
            <button
              type="button"
              onClick={jumpToLatest}
              className={cn(
                'bg-raised border-line text-label-xs text-foreground shadow-popover pointer-events-auto',
                'animate-in fade-in-0 slide-in-from-bottom-1 inline-flex items-center gap-1.5',
                'rounded-full border px-3 py-1.5 font-medium transition-transform active:scale-95',
              )}
            >
              <ArrowDownIcon className="size-3.5" aria-hidden="true" />
              Jump to latest
            </button>
          </div>
        )}
      </div>

      {/* Announced once, when the reply is done — never the text as it streams. */}
      <p role="status" className="sr-only">
        {finished && isLive ? 'The reply is complete.' : ''}
      </p>

      {refusal === undefined ? null : (
        <p
          role="alert"
          className="bg-danger-soft text-body-sm text-danger mx-4 mb-3 rounded-xl px-3.5 py-[13px]"
        >
          {refusal}
          {refusalAction === undefined ? null : (
            <button
              type="button"
              className="text-label-xs mt-2 block font-medium underline underline-offset-2"
              onClick={refusalAction.onClick}
            >
              {refusalAction.label}
            </button>
          )}
        </p>
      )}

      <RunStateCard
        className="mx-4 mb-3"
        isWorking={isRunning}
        connection={connection}
        failure={failure}
        onRetry={onRetry}
        run={run}
        source={source}
      />

      {composer}
    </div>
  );
}

function Row({
  attachmentUrl,
  isStreaming,
  isTail,
  row,
}: {
  readonly attachmentUrl: ((attachmentId: string) => string) | undefined;
  readonly isStreaming: boolean;
  /** The last row of a live run: a work group there opens to show what is happening. */
  readonly isTail: boolean;
  readonly row: TimelineRow;
}): React.JSX.Element | null {
  switch (row.kind) {
    case 'assistant': {
      return <ChatMarkdown isStreaming={isStreaming} text={row.text} />;
    }

    case 'notice': {
      return <Notice event={row.event} />;
    }

    case 'user': {
      return (
        <div className="flex flex-col items-end gap-1.5">
          {attachmentUrl === undefined ? null : (
            <MessageAttachments attachments={row.attachments} contentUrl={attachmentUrl} />
          )}
          <p className="bg-raised border-line-subtle text-body-sm text-foreground max-w-[85%] rounded-2xl rounded-br-md border px-[13px] py-2.5 whitespace-pre-wrap">
            {row.text}
          </p>
        </div>
      );
    }

    case 'work': {
      return <WorkGroup defaultExpanded={isTail} entries={row.entries} isLive={isTail} />;
    }
  }
}

/** One of the run's other notices, drawn. */
function Notice({ event }: { readonly event: RunEvent }): React.JSX.Element | null {
  switch (event.type) {
    case 'checkpoint': {
      return (
        <div className="bg-raised border-line-subtle flex items-center gap-[9px] rounded-[10px] border px-[11px] py-2.5">
          <BookmarkIcon className="text-success size-3.5 shrink-0" aria-hidden="true" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="text-label-sm text-foreground font-medium">
              {event.data.label ?? 'Checkpoint'}
            </p>
            <p className="text-caption text-faint truncate">
              Checkpoint saved ·{' '}
              <span className="font-mono" title={event.data.checkpointId}>
                {event.data.checkpointId.slice(0, 7)}
              </span>
            </p>
          </div>
        </div>
      );
    }

    case 'preview.ready': {
      return (
        <div className="border-line-subtle flex items-center gap-2 rounded-[9px] border px-[11px] py-2">
          <MonitorIcon className="text-subdued size-[13px] shrink-0" aria-hidden="true" />
          <span className="text-label-xs text-subdued min-w-0 flex-1 truncate font-medium">
            Preview ready
          </span>
        </div>
      );
    }

    case 'sandbox.preparing': {
      return (
        <p className="text-caption text-faint flex items-center gap-1.5">
          <BoxIcon className="size-3.5 shrink-0" aria-hidden="true" />
          {PREPARING_COPY[event.data.transition]}
        </p>
      );
    }

    case 'state': {
      // The reason is the run's own words, so it is shown when there is one and nothing is
      // invented when there is not.
      const reason = stateReason(event.data);

      return reason === undefined ? null : <p className="text-caption text-faint">{reason}</p>;
    }

    default: {
      // Tokens, tool calls and file changes have rows of their own; the rest has none.
      return null;
    }
  }
}

/** The workspace's transitions, as a person reads them. */
const PREPARING_COPY = {
  creating: 'Creating the workspace',
  hibernating: 'The workspace was going to sleep — waiting for it',
  releasing: 'Releasing the workspace',
  resuming: 'Waking the workspace',
} as const satisfies Record<
  Extract<RunEvent, { type: 'sandbox.preparing' }>['data']['transition'],
  string
>;

/** A subscription run with no model chosen records its provider's name: the CLI's own default. */
function modelLabel(model: string): string {
  return (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(model) ? 'Default model' : model;
}
