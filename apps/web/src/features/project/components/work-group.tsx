import {
  CheckIcon,
  ChevronRightIcon,
  FileTextIcon,
  PackageIcon,
  TerminalIcon,
  XIcon,
} from 'lucide-react';
import { useId, useState } from 'react';

import { cn } from '@/lib/utils';
import { type WorkEntry, workSummary } from '../lib/timeline';
import type { ToolKind, ToolStatus } from '../types';

const toolIcons = {
  edit: FileTextIcon,
  exec: TerminalIcon,
  package: PackageIcon,
} as const satisfies Record<ToolKind, unknown>;

/** One tool call or file change, on one line: what kind, what, and how it ended. */
function WorkLine({ entry }: { readonly entry: WorkEntry }): React.JSX.Element {
  if (entry.kind === 'patch') {
    return (
      <div className="flex min-w-0 items-center gap-2 px-[11px] py-1.5">
        <FileTextIcon className="text-faint size-3.5 shrink-0" aria-hidden="true" />
        <p className="text-caption text-subdued min-w-0 flex-1 truncate font-mono">
          Changed {entry.path}
        </p>
      </div>
    );
  }

  const Icon = toolIcons[entry.tool];

  return (
    <div className="flex min-w-0 items-center gap-2 px-[11px] py-1.5">
      <Icon className="text-subdued size-3.5 shrink-0" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col">
        <p
          className={cn(
            'text-mono-sm text-foreground truncate font-mono',
            entry.status === 'running' && 'chat-shimmer',
          )}
        >
          {entry.title}
        </p>
        {entry.detail === undefined ? null : (
          <p className="text-caption text-danger truncate">{entry.detail}</p>
        )}
      </div>
      <StatusGlyph status={entry.status} />
    </div>
  );
}

function StatusGlyph({ status }: { readonly status: ToolStatus }): React.JSX.Element {
  if (status === 'running') {
    return (
      <span
        role="status"
        aria-label="Running"
        className="bg-brand animate-breathe size-2 shrink-0 rounded-full"
      />
    );
  }

  if (status === 'failed') {
    return (
      <>
        <XIcon className="text-danger size-3.5 shrink-0" aria-hidden="true" />
        <span className="sr-only">Failed</span>
      </>
    );
  }

  return (
    <>
      <CheckIcon className="text-success size-3.5 shrink-0" aria-hidden="true" />
      <span className="sr-only">Done</span>
    </>
  );
}

/**
 * Consecutive tool calls and file changes (spec 043, after t3code's work groups): one line when
 * there is one, otherwise a summary — "Edited 2 files · ran 3 commands" — that expands to the
 * list, height-capped. A failure is marked on the summary so it is never hidden by collapsing.
 */
export function WorkGroup({
  defaultExpanded = false,
  entries,
}: {
  readonly defaultExpanded?: boolean;
  readonly entries: readonly WorkEntry[];
}): React.JSX.Element {
  const id = useId();
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const tools = entries.filter((entry) => entry.kind === 'tool');
  const failed = tools.filter((entry) => entry.status === 'failed').length;
  const isRunning = tools.some((entry) => entry.status === 'running');
  const [only] = entries;

  if (entries.length === 1 && only !== undefined) {
    return (
      <div
        className={cn(
          'bg-raised rounded-[10px] border',
          isRunning ? 'border-brand-border' : 'border-line-subtle',
        )}
      >
        <WorkLine entry={only} />
      </div>
    );
  }

  return (
    <div
      className={cn(
        'bg-raised overflow-hidden rounded-[10px] border',
        isRunning ? 'border-brand-border' : 'border-line-subtle',
      )}
    >
      <button
        type="button"
        aria-expanded={isExpanded}
        aria-controls={isExpanded ? id : undefined}
        onClick={() => {
          setIsExpanded((value) => !value);
        }}
        className="hover:bg-subtle flex w-full items-center gap-2 px-[11px] py-2 text-left transition-colors"
      >
        <ChevronRightIcon
          className={cn(
            'text-faint size-3.5 shrink-0 transition-transform duration-150',
            isExpanded && 'rotate-90',
          )}
          aria-hidden="true"
        />
        <span
          className={cn(
            'text-label-xs text-subdued min-w-0 flex-1 truncate font-medium',
            isRunning && 'chat-shimmer',
          )}
        >
          {workSummary(entries)}
        </span>
        {failed > 0 ? (
          <span className="text-caption text-danger flex shrink-0 items-center gap-1">
            <XIcon className="size-3.5" aria-hidden="true" />
            {failed} failed
          </span>
        ) : null}
        {isRunning ? <StatusGlyph status="running" /> : null}
      </button>
      {isExpanded ? (
        <ul
          id={id}
          className="border-line-subtle animate-in fade-in-0 slide-in-from-top-1 max-h-60 overflow-y-auto border-t py-1"
        >
          {entries.map((entry) => (
            <li key={entry.id}>
              <WorkLine entry={entry} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
