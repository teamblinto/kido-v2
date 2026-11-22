import {
  BotIcon,
  BrainIcon,
  CheckIcon,
  ChevronRightIcon,
  EyeIcon,
  FileDiffIcon,
  FolderTreeIcon,
  GlobeIcon,
  ListTodoIcon,
  MonitorIcon,
  PackageIcon,
  SearchIcon,
  SquarePenIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import { type WorkEntry, workDiffStat, workSummary } from '../lib/timeline';
import {
  type ToolKind,
  type ToolLine,
  type ToolStatus,
  agentPrompt,
  commandText,
  describeTool,
  diffStat,
} from '../lib/tool-activity';
import { parseUnifiedDiff } from '../lib/unified-diff';

const toolIcons = {
  agent: BotIcon,
  command: TerminalIcon,
  edit: SquarePenIcon,
  list: FolderTreeIcon,
  other: WrenchIcon,
  package: PackageIcon,
  preview: MonitorIcon,
  read: EyeIcon,
  search: SearchIcon,
  task: ListTodoIcon,
  web: GlobeIcon,
} as const satisfies Record<ToolKind, unknown>;

/** How much of a long output an expanded line shows before it says the rest was cut. */
const OUTPUT_LIMIT = 12_000;

function OutputBlock({
  text,
  tone = 'default',
}: {
  readonly text: string;
  readonly tone?: 'danger' | 'default';
}): React.JSX.Element {
  const shown = text.length > OUTPUT_LIMIT ? text.slice(-OUTPUT_LIMIT) : text;
  // Pinned to the bottom while it grows, until the reader scrolls up (t3code's `followLive`): a
  // command's output reads like a terminal while it runs.
  const ref = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const element = ref.current;

    if (element !== null && pinned.current) element.scrollTop = element.scrollHeight;
  }, [shown]);

  return (
    <pre
      ref={ref}
      onScroll={(event) => {
        const element = event.currentTarget;

        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8;
      }}
      className={cn(
        'bg-subtle border-line-subtle text-mono-sm max-h-64 overflow-auto rounded-md border px-2.5 py-2',
        'font-mono break-words whitespace-pre-wrap select-text',
        tone === 'danger' ? 'text-danger' : 'text-subdued',
      )}
    >
      {text.length > OUTPUT_LIMIT ? (
        <span className="text-faint block pb-1">Earlier output not shown</span>
      ) : null}
      {shown}
    </pre>
  );
}

/** A unified diff, coloured line by line — what an edit actually changed. */
function PatchView({ diff, path }: { readonly diff: string; readonly path: string }) {
  const hunks = parseUnifiedDiff(diff);
  const stat = diffStat(diff);

  return (
    <div className="border-line-subtle overflow-hidden rounded-md border">
      <div className="bg-subtle border-line-subtle flex items-center gap-2 border-b px-2.5 py-1.5">
        <span className="text-mono-sm text-foreground min-w-0 flex-1 truncate font-mono">
          {path}
        </span>
        <DiffStat added={stat.added} removed={stat.removed} />
      </div>
      {hunks.length === 0 ? (
        <p className="text-caption text-faint px-2.5 py-2">No line changes to show.</p>
      ) : (
        <div className="text-mono-sm max-h-72 overflow-auto font-mono">
          {hunks.map((hunk) => (
            <div key={hunk.header}>
              <p className="bg-info-soft text-info px-2.5 py-0.5">{hunk.header}</p>
              {hunk.lines.map((line, index) => (
                <p
                  key={index}
                  className={cn(
                    'px-2.5 whitespace-pre-wrap',
                    line.kind === 'add' && 'bg-success-soft text-success',
                    line.kind === 'remove' && 'bg-danger-soft text-danger',
                    line.kind === 'context' && 'text-subdued',
                  )}
                >
                  <span aria-hidden="true" className="inline-block w-3 select-none">
                    {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
                  </span>
                  {line.content}
                </p>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DiffStat({ added, removed }: { readonly added: number; readonly removed: number }) {
  if (added === 0 && removed === 0) return null;

  return (
    <span className="text-mono-sm shrink-0 font-mono tabular-nums">
      <span className="text-success">+{added}</span> <span className="text-danger">−{removed}</span>
    </span>
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

/** The verb and its target, the target in mono — "Ran pnpm `pnpm install`". */
function LineText({
  isLive,
  line,
}: {
  readonly isLive: boolean;
  readonly line: Pick<ToolLine, 'target' | 'verb'>;
}) {
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
      <span
        className={cn(
          'text-label-xs shrink-0 font-medium',
          isLive ? 'chat-shine text-foreground' : 'text-foreground',
        )}
      >
        {line.verb}
      </span>
      {line.target === undefined ? null : (
        <span className="text-mono-sm text-subdued min-w-0 truncate font-mono">{line.target}</span>
      )}
    </span>
  );
}

/** What an entry shows when it is opened; `undefined` when there is nothing more to show. */
function details(entry: WorkEntry, isLive: boolean): React.ReactNode | undefined {
  if (entry.kind === 'reasoning') {
    return entry.text.trim().length === 0 ? undefined : (
      <p className="text-body-sm text-subdued whitespace-pre-wrap select-text">{entry.text}</p>
    );
  }

  if (entry.kind === 'patch') return <PatchView diff={entry.diff} path={entry.path} />;

  const parts: React.ReactNode[] = [];

  if (entry.tool === 'command') {
    const line = describeTool(entry.title, entry.input, entry.status);

    if (line.target !== undefined) {
      parts.push(
        <pre
          key="command"
          className="bg-subtle border-line-subtle text-mono-sm text-foreground overflow-x-auto rounded-md border px-2.5 py-2 font-mono whitespace-pre-wrap select-text"
        >
          <span className="text-faint select-none">$ </span>
          {commandText(line.target)}
        </pre>,
      );
    }
  }

  if (entry.tool === 'agent') {
    const prompt = agentPrompt(entry.input);

    if (prompt !== undefined) {
      parts.push(
        <p key="prompt" className="text-body-sm text-subdued whitespace-pre-wrap select-text">
          {prompt}
        </p>,
      );
    }
  }

  for (const patch of entry.patches) {
    parts.push(
      <PatchView
        key={`patch-${patch.path}-${String(parts.length)}`}
        diff={patch.diff}
        path={patch.path}
      />,
    );
  }

  // An edit's output is the broker's acknowledgement; the diff above says what it did.
  const showsOutput =
    entry.output.trim().length > 0 && !(entry.tool === 'edit' && entry.patches.length > 0);

  if (showsOutput) {
    parts.push(<OutputBlock key="output" text={entry.output} />);
  } else if (entry.status === 'running' && isLive && entry.tool === 'command') {
    parts.push(
      <p key="waiting" className="text-caption text-faint">
        Waiting for output…
      </p>,
    );
  }

  if (entry.exitCode !== undefined && entry.exitCode !== 0) {
    parts.push(
      <p key="exit" className="text-mono-sm text-danger font-mono">
        exit {entry.exitCode}
      </p>,
    );
  }

  return parts.length === 0 ? undefined : <div className="flex flex-col gap-1.5">{parts}</div>;
}

/**
 * One entry in the work log: an icon for its kind, the verb in the tense its status calls for,
 * what it acted on, and how it ended. Opens to what it did — a command's output and exit status,
 * an edit's diff, a subagent's brief, the full thought — when there is anything to open.
 */
export function WorkEntryRow({
  entry,
  isLive = false,
}: {
  readonly entry: WorkEntry;
  /** The newest entry of a run still going: its label shimmers while it runs. */
  readonly isLive?: boolean;
}): React.JSX.Element {
  const id = useId();
  const [isOpen, setIsOpen] = useState(false);
  const body = details(entry, isLive);
  const status: ToolStatus = entry.kind === 'tool' ? entry.status : 'done';

  let Icon: typeof BrainIcon;
  let line: Pick<ToolLine, 'target' | 'verb'>;
  let stat: { added: number; removed: number } | undefined;

  if (entry.kind === 'reasoning') {
    Icon = BrainIcon;
    // Collapsed, a thought reads as its first line (t3code shows the thought text inline).
    const preview = entry.text.trim().split('\n')[0];
    line = { verb: isLive ? 'Thinking' : 'Thought', ...(preview ? { target: preview } : {}) };
  } else if (entry.kind === 'patch') {
    Icon = FileDiffIcon;
    line = { target: entry.path, verb: 'Changed' };
    stat = diffStat(entry.diff);
  } else {
    Icon = toolIcons[entry.tool];
    line = describeTool(entry.title, entry.input, entry.status);
    stat = entry.patches.length > 0 ? workDiffStat([entry]) : undefined;
  }

  const isRunning = isLive && (entry.kind === 'reasoning' || status === 'running');
  const header = (
    <>
      <Icon
        className={cn(
          'size-3.5 shrink-0',
          status === 'failed' ? 'text-danger' : isRunning ? 'text-foreground' : 'text-faint',
        )}
        aria-hidden="true"
      />
      <LineText isLive={isRunning} line={line} />
      {stat === undefined ? null : <DiffStat added={stat.added} removed={stat.removed} />}
      {entry.kind === 'reasoning' ? null : <StatusGlyph status={status} />}
      {body === undefined ? null : (
        <ChevronRightIcon
          className={cn(
            'text-faint size-3 shrink-0 transition-transform duration-200',
            isOpen && 'rotate-90',
          )}
          aria-hidden="true"
        />
      )}
    </>
  );

  return (
    <div className="min-w-0">
      {body === undefined ? (
        <div className="flex min-h-7 min-w-0 items-center gap-2 px-[11px] py-1">{header}</div>
      ) : (
        <button
          type="button"
          aria-expanded={isOpen}
          aria-controls={isOpen ? id : undefined}
          onClick={() => {
            setIsOpen((value) => !value);
          }}
          className="hover:bg-subtle flex min-h-7 w-full min-w-0 items-center gap-2 px-[11px] py-1 text-left transition-colors"
        >
          {header}
        </button>
      )}
      {entry.kind === 'tool' && entry.detail !== undefined ? (
        // Why it failed, always in view: collapsing a line never hides a failure.
        <p
          className="text-caption text-danger line-clamp-2 px-[11px] pb-1.5 pl-[33px] break-words"
          title={entry.detail}
        >
          {entry.detail}
        </p>
      ) : null}
      {isOpen && body !== undefined ? (
        <div
          id={id}
          className="animate-in fade-in-0 slide-in-from-top-1 px-[11px] pt-0.5 pb-2 pl-[33px]"
        >
          {body}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Consecutive tool calls, file changes and thinking (spec 043, after t3code's work groups): one
 * line when there is one, otherwise a summary — "Read 2 files · edited 1 file · ran 3 commands" —
 * that expands to the list. While the group is the run's live tail its header names what is
 * running right now, so the work in progress is never hidden behind a summary. A failure is
 * marked on the summary so collapsing never hides it.
 */
export function WorkGroup({
  defaultExpanded = false,
  entries,
  isLive = false,
}: {
  readonly defaultExpanded?: boolean;
  readonly entries: readonly WorkEntry[];
  /** The group is the last row of a run still going. */
  readonly isLive?: boolean;
}): React.JSX.Element {
  const id = useId();
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const tools = entries.filter((entry) => entry.kind === 'tool');
  const failed = tools.filter((entry) => entry.status === 'failed').length;
  const running = [...tools].reverse().find((entry) => entry.status === 'running');
  const isRunning = running !== undefined || (isLive && entries.at(-1)?.kind === 'reasoning');
  const stat = workDiffStat(entries);
  const last = entries.at(-1);
  const [only] = entries;

  if (entries.length === 1 && only !== undefined) {
    return (
      <div
        className={cn(
          'bg-raised overflow-hidden rounded-[10px] border transition-colors duration-300',
          isRunning ? 'border-brand-border' : 'border-line-subtle',
        )}
      >
        <WorkEntryRow entry={only} isLive={isLive} />
      </div>
    );
  }

  // The live header: the call running now, else the thought in progress, else the summary.
  const current =
    running === undefined
      ? isLive && last?.kind === 'reasoning'
        ? { verb: 'Thinking' }
        : undefined
      : describeTool(running.title, running.input, 'running');

  return (
    <div
      className={cn(
        'bg-raised overflow-hidden rounded-[10px] border transition-colors duration-300',
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
        className="hover:bg-subtle flex w-full min-w-0 items-center gap-2 px-[11px] py-2 text-left transition-colors"
      >
        <ChevronRightIcon
          className={cn(
            'text-faint size-3.5 shrink-0 transition-transform duration-200',
            isExpanded && 'rotate-90',
          )}
          aria-hidden="true"
        />
        {current === undefined ? (
          <span className="text-label-xs text-subdued min-w-0 flex-1 truncate font-medium">
            {workSummary(entries)}
          </span>
        ) : (
          <LineText isLive line={current} />
        )}
        <DiffStat added={stat.added} removed={stat.removed} />
        {failed > 0 ? (
          <span className="text-caption text-danger flex shrink-0 items-center gap-1">
            <XIcon className="size-3.5" aria-hidden="true" />
            {failed} failed
          </span>
        ) : null}
        {isRunning ? (
          <StatusGlyph status="running" />
        ) : (
          <span className="text-caption text-faint shrink-0 tabular-nums">{entries.length}</span>
        )}
      </button>
      {isExpanded ? (
        <ul
          id={id}
          className="border-line-subtle animate-in fade-in-0 slide-in-from-top-1 max-h-[min(24rem,50dvh)] overflow-y-auto border-t py-1"
        >
          {entries.map((entry) => (
            <li key={entry.id}>
              <WorkEntryRow entry={entry} isLive={isLive && entry === last} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
