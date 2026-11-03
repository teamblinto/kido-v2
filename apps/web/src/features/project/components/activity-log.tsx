import { ChevronDownIcon, ChevronUpIcon, TerminalIcon } from 'lucide-react';
import { useId, useState } from 'react';

import { Kbd } from '@/components/ui/kbd';
import { cn } from '@/lib/utils';
import { logShortcutLabel } from '../hooks/use-project-workspace';
import type { ActivityLine } from '../lib/stage';

type LogFilter = 'everything' | 'problems';

interface ActivityLogProps {
  /** What the run's tools wrote, read from `tool.delta` and a failed `tool.end` (FR-029). */
  entries: readonly ActivityLine[];
  isOpen: boolean;
  onToggle: () => void;
}

/**
 * The build output, kept out of the way. Shut it is a single line of the latest
 * activity; open it is the whole run, filterable down to just the problems.
 */
export function ActivityLog({ entries, isOpen, onToggle }: ActivityLogProps): React.JSX.Element {
  const panelId = useId();
  const [filter, setFilter] = useState<LogFilter>('everything');

  const visible = filter === 'problems' ? entries.filter((entry) => entry.isProblem) : entries;

  // The collapsed line is the latest thing the run wrote, not a sentence about it. Silence while
  // nothing has been written is the truthful state, so it says exactly that.
  const summary = entries.at(-1)?.message ?? 'Nothing yet';

  if (!isOpen) {
    return (
      <div className="bg-raised border-line-subtle flex shrink-0 items-center gap-2.5 border-t px-3.5 py-2.5">
        <TerminalIcon className="text-subdued size-[15px] shrink-0" aria-hidden="true" />
        <p className="text-label-sm text-foreground shrink-0 font-medium">Activity log</p>
        <p className="text-mono-sm text-faint min-w-0 flex-1 truncate font-mono">{summary}</p>
        <Kbd className="shrink-0 max-sm:hidden">{logShortcutLabel}</Kbd>
        <button
          type="button"
          aria-expanded={false}
          aria-controls={panelId}
          onClick={onToggle}
          className="text-subdued hover:text-foreground shrink-0 rounded-sm transition-colors"
        >
          <ChevronUpIcon className="size-[15px]" aria-hidden="true" />
          <span className="sr-only">Open the activity log</span>
        </button>
      </div>
    );
  }

  return (
    <section
      id={panelId}
      aria-label="Activity log"
      className="bg-raised border-line-subtle flex h-[356px] max-h-[55vh] shrink-0 flex-col border-t"
    >
      <header className="border-line-subtle flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3">
        <p className="text-label-sm text-foreground font-medium">Activity log</p>
        <p className="text-caption text-faint max-md:hidden">Everything BAIOS did while building</p>

        <span className="flex-1" />

        <div className="flex shrink-0 gap-1.5">
          <FilterChip
            isActive={filter === 'everything'}
            label="Everything"
            onClick={() => {
              setFilter('everything');
            }}
          />
          <FilterChip
            isActive={filter === 'problems'}
            label="Problems only"
            onClick={() => {
              setFilter('problems');
            }}
          />
        </div>

        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(
              entries.map((entry) => `${entry.time}  ${entry.message}`).join('\n'),
            );
          }}
          className={cn(
            'border-line text-label-sm text-foreground hover:bg-subtle shrink-0 rounded-md',
            'border px-3 py-1 font-medium transition-colors',
          )}
        >
          Copy
        </button>

        <Kbd className="shrink-0 max-sm:hidden">{logShortcutLabel}</Kbd>

        <button
          type="button"
          aria-expanded
          aria-controls={panelId}
          onClick={onToggle}
          className="text-subdued hover:text-foreground shrink-0 rounded-sm transition-colors"
        >
          <ChevronDownIcon className="size-[15px]" aria-hidden="true" />
          <span className="sr-only">Close the activity log</span>
        </button>
      </header>

      <ol className="min-h-0 flex-1 overflow-y-auto py-2">
        {visible.map((entry) => (
          <li key={entry.id} className="flex gap-4 px-4 py-0.5">
            <span className="text-mono-sm text-faint w-[74px] shrink-0 font-mono">
              {entry.time}
            </span>
            <span
              className={cn(
                'text-mono-sm font-mono',
                entry.isProblem ? 'text-warning' : 'text-subdued',
              )}
            >
              {entry.message}
            </span>
          </li>
        ))}
        {visible.length === 0 ? (
          <li className="text-body-sm text-faint px-4 py-2">
            {filter === 'problems'
              ? 'No problems to show.'
              : 'Nothing yet — what this run\u2019s tools write appears here.'}
          </li>
        ) : null}
      </ol>
    </section>
  );
}

function FilterChip({
  isActive,
  label,
  onClick,
}: {
  isActive: boolean;
  label: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={isActive}
      onClick={onClick}
      className={cn(
        'text-caption rounded-md px-3 py-1.5 font-medium transition-colors',
        isActive ? 'bg-muted text-foreground' : 'text-subdued hover:bg-muted',
      )}
    >
      {label}
    </button>
  );
}
