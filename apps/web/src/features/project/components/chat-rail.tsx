import { useQuery } from '@tanstack/react-query';
import { HistoryIcon, MessageSquareIcon } from 'lucide-react';
import { useParams } from 'react-router-dom';

import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { useOrgs } from '@/features/workspace/hooks/use-orgs';
import { cn } from '@/lib/utils';
import { getProject } from '@/features/workspace/api';
import { chatShortcutLabel } from '../hooks/use-project-workspace';
import { useRun } from '../hooks/use-run';
import { RunList } from './run-list';

interface ChatRailProps {
  className?: string;
  onOpen: () => void;
  /** Replies that arrived while the panel was shut. */
  unreadCount: number;
}

/** What the chat panel shrinks to once it is collapsed, so it can be brought back. */
export function ChatRail({ className, onOpen, unreadCount }: ChatRailProps): React.JSX.Element {
  // Read here rather than passed down: the run browser needs the same project and the same
  // selection the page already has, and `useRun` is the one place that decides what that is.
  const { projectId = '' } = useParams();
  const { activeOrg } = useOrgs();
  const { runId, selectRun } = useRun({ orgId: activeOrg?.id, projectId });
  // The page's own project read (same key, so the cache answers): the run line's cancel control
  // is for `project:agent.run` holders (spec 031).
  const project = useQuery({
    enabled: activeOrg !== undefined && projectId.length > 0,
    queryFn: ({ signal }) => getProject(activeOrg?.id ?? '', projectId, signal),
    queryKey: ['project', activeOrg?.id, projectId],
  });

  return (
    <div
      className={cn(
        'bg-subtle border-line-subtle flex w-16 shrink-0 flex-col items-center gap-2 border-r pt-3.5',
        className,
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="text-subdued hover:bg-secondary/60 hover:text-foreground flex flex-col items-center gap-1.5 rounded-lg px-2 py-2 transition-colors"
      >
        <MessageSquareIcon className="size-4" aria-hidden="true" />
        <span className="text-caption font-medium">Chat</span>
        <span className="sr-only">Show the chat panel</span>
      </button>

      {unreadCount > 0 ? (
        <span className="bg-brand text-primary-foreground text-label-xs rounded-full px-1.5 py-0.5 font-medium">
          {unreadCount}
        </span>
      ) : null}

      <Sheet>
        <SheetTrigger className="text-subdued hover:bg-secondary/60 hover:text-foreground flex flex-col items-center gap-1.5 rounded-lg px-2 py-2 transition-colors">
          <HistoryIcon className="size-4" aria-hidden="true" />
          <span className="text-caption font-medium">Runs</span>
          <span className="sr-only">Show this project's runs</span>
        </SheetTrigger>
        <SheetContent side="left" aria-describedby={undefined} className="w-[360px] gap-2 p-3">
          <SheetTitle className="px-3 pt-1">Runs</SheetTitle>
          <RunList
            className="min-h-0 overflow-y-auto"
            onSelect={selectRun}
            orgId={activeOrg?.id}
            permissions={project.data?.project.permissions}
            projectId={projectId}
            selectedRunId={runId}
          />
        </SheetContent>
      </Sheet>

      <span className="text-mono-sm text-faint font-mono">{chatShortcutLabel}</span>
    </div>
  );
}
