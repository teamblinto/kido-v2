import type { RunEvent, RunResponse } from '@repo/contracts';
import { BookmarkIcon, MonitorIcon, SparklesIcon } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';

import { stateReason } from '@/features/settings/subscription-limit';
import { cn } from '@/lib/utils';
import type { SubscriptionRunRequest } from '../lib/pay-with';
import {
  type ApprovalResolution,
  type Connection,
  type TranscriptItem,
  type TranscriptSource,
  approvalResolutions,
} from '../lib/transcript';
import type { ToolKind, ToolStatus } from '../types';
import { ApprovalCard } from './approval-card';
import { ChatComposer } from './chat-composer';
import { RunStateCard } from './run-state-card';
import { ToolCallCard } from './tool-call-card';

interface ChatPanelProps {
  className?: string;
  /** What the transport is doing, for the strip above the composer (FR-010, FR-011). */
  connection: Connection;
  isRunning: boolean;
  /** Whether a stop has been asked for and the run has not yet stopped. */
  isStopping: boolean;
  items: readonly TranscriptItem[];
  /** The instruction that started this run, shown before anything the run has said. */
  instruction?: string;
  /** The model the run reports. A label, never a choice (FR-018, FR-020). */
  model?: string;
  onRetry: () => void;
  onStop: () => void;
  onSubmit: (prompt: string, target?: SubscriptionRunRequest) => void;
  /** Spec 040: where approvals are answered; absent until the organisation is known. */
  orgId?: string;
  placeholder: string;
  /** Spec 040: the project the composer's "Run on" choice is remembered for. */
  projectId?: string;
  /**
   * The catalogue's sentence for a refused console action, when there is one.
   *
   * A rendered string rather than the error itself: the screen decides what a failure says, in
   * one place, through `MESSAGES` (FR-021). This component never sees a slug.
   */
  refusal?: string;
  /** Spec 032 T048: the one thing to do about the refusal, when there is one. */
  refusalAction?: { readonly label: string; readonly onClick: () => void };
  /** Whether the transcript is being streamed or read back from the store. */
  source: TranscriptSource;
  /** The run the strip reports on, once it has been read. */
  run: RunResponse | undefined;
}

/**
 * The run's transcript, and the box to add to it.
 *
 * Every entry below is an event the run actually sent. Nothing is filled in, inferred or held
 * back: if the run reported nothing, the panel is empty, which is what FR-003 asks for and what
 * makes a blank screen readable as "nothing has happened yet" rather than as a failure to load.
 */
export function ChatPanel({
  className,
  connection,
  instruction,
  isRunning,
  isStopping,
  items,
  model,
  onRetry,
  onStop,
  onSubmit,
  orgId,
  placeholder,
  projectId,
  refusal,
  refusalAction,
  run,
  source,
}: ChatPanelProps): React.JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);

  // New entries arrive at the bottom, which is where attention needs to be.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [items.length]);

  // `tool.end` is matched to the `tool.start` sharing its `stepId`; unpaired means still running.
  const toolEnds = useMemo(() => {
    const ends = new Map<string, Extract<RunEvent, { type: 'tool.end' }>>();

    for (const { event } of items) {
      if (event.type === 'tool.end') {
        ends.set(event.data.stepId, event);
      }
    }

    return ends;
  }, [items]);
  const approvals = useMemo(() => approvalResolutions(items), [items]);
  // Spec 040: a local agent's failure names the one command that fixes it; the strip offers it.
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
      {/*
        Off-screen rows skip layout and paint; the DOM keeps every event, so follow-latest and
        scroll-lock are untouched (R8, FR-021). The last child is the scroll sentinel and is left
        alone — a reserved 64px there would push the bottom of the transcript.
      */}
      <div
        aria-label="Conversation"
        aria-live="polite"
        role="log"
        className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 pt-[18px] pb-3 [&>*:not(:last-child)]:[contain-intrinsic-size:auto_64px] [&>*:not(:last-child)]:[content-visibility:auto]"
      >
        {instruction === undefined ? null : (
          <div className="flex justify-end">
            <p className="bg-raised border-line-subtle text-body-sm text-foreground max-w-[320px] rounded-xl border px-[13px] py-2.5">
              {instruction}
            </p>
          </div>
        )}

        {items.map((item) => (
          <ChatEntry
            key={item.id}
            approvals={approvals}
            event={item.event}
            orgId={orgId}
            projectId={projectId}
            toolEnds={toolEnds}
          />
        ))}
        <div ref={endRef} />
      </div>

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
        connection={connection}
        failure={failure}
        onRetry={onRetry}
        run={run}
        source={source}
      />

      <ChatComposer
        // Remounted per project, so the remembered "Run on" choice is that project's.
        key={projectId}
        isRunning={isRunning}
        isStopping={isStopping}
        model={model}
        onStop={onStop}
        onSubmit={onSubmit}
        placeholder={placeholder}
        projectId={projectId}
      />
    </div>
  );
}

/** The tool's icon family, from its name. Unrecognised tools get the neutral one. */
function toolKind(tool: string): ToolKind {
  if (tool.includes('edit') || tool.includes('write') || tool.includes('file')) {
    return 'edit';
  }

  return tool.includes('install') || tool.includes('package') ? 'package' : 'exec';
}

interface ChatEntryProps {
  approvals: ReadonlyMap<string, ApprovalResolution>;
  event: RunEvent;
  orgId: string | undefined;
  projectId: string | undefined;
  toolEnds: ReadonlyMap<string, Extract<RunEvent, { type: 'tool.end' }>>;
}

/**
 * One event, drawn.
 *
 * `tool.end` renders nothing of its own: it is the other half of the `tool.start` above it, and
 * drawing both would show every tool call twice.
 */
function ChatEntry({
  approvals,
  event,
  orgId,
  projectId,
  toolEnds,
}: ChatEntryProps): React.JSX.Element | null {
  switch (event.type) {
    case 'checkpoint': {
      return (
        <div className="bg-raised border-line-subtle flex items-center gap-[9px] rounded-[10px] border px-[11px] py-2.5">
          <BookmarkIcon className="text-subdued size-3.5 shrink-0" aria-hidden="true" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="text-label-sm text-foreground font-medium">
              {event.data.label ?? 'Checkpoint'}
            </p>
            <p className="text-mono-sm text-faint truncate font-mono">{event.data.checkpointId}</p>
          </div>
        </div>
      );
    }

    case 'file.patch': {
      return <p className="text-caption text-faint font-mono">Changed {event.data.path}</p>;
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
      return <p className="text-caption text-faint">Preparing sandbox: {event.data.transition}</p>;
    }

    case 'approval.request': {
      return (
        <ApprovalCard
          event={event}
          orgId={orgId}
          projectId={projectId}
          resolution={approvals.get(event.data.requestId)}
        />
      );
    }

    case 'state': {
      // The reason is the run's own words, so it is shown when there is one and nothing is
      // invented when there is not.
      const reason = stateReason(event.data);
      return reason === undefined ? null : <p className="text-caption text-faint">{reason}</p>;
    }

    case 'thought': {
      return (
        <div
          className={cn(
            'border-line-subtle flex items-center gap-2 rounded-[9px] border px-[11px] py-2',
          )}
        >
          <SparklesIcon className="text-subdued size-[13px] shrink-0" aria-hidden="true" />
          <span className="text-label-xs text-subdued min-w-0 flex-1 font-medium">
            {event.data.text}
          </span>
        </div>
      );
    }

    case 'token': {
      return <p className="text-body-sm text-foreground">{event.data.text}</p>;
    }

    case 'tool.start': {
      const end = toolEnds.get(event.data.stepId);
      const status: ToolStatus = end === undefined ? 'running' : end.data.ok ? 'done' : 'failed';

      return (
        <ToolCallCard
          detail={end?.data.error ?? event.data.tool}
          status={status}
          title={event.data.tool}
          tool={toolKind(event.data.tool)}
        />
      );
    }

    // `tool.delta` is a tool's output as it streams; `tool.end`, `usage` and `tool.delta` have no
    // entry of their own — the first two belong to the card above, and usage is on the run record.
    // `approval.resolved` settles the card above it, as `tool.end` does a tool's.
    case 'approval.resolved':
    case 'tool.delta':
    case 'tool.end':
    case 'usage': {
      return null;
    }
  }
}
