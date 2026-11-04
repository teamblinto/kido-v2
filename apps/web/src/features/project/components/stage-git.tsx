import { useQuery } from '@tanstack/react-query';

import { getProject } from '@/features/workspace/api';
import { cn } from '@/lib/utils';
import { GitHubPanel } from '../github-panel';
import { useGitSync } from '../hooks/use-git-sync';
import type { GitView } from '../types';
import { GitChanges } from './git-changes';
import { GitHistory } from './git-history';
import { RevertDialog } from './revert-dialog';
import { SegmentedControl, type SegmentedItem } from './segmented-control';

const views: readonly SegmentedItem<GitView>[] = [
  { id: 'changes', label: 'Changes' },
  { id: 'history', label: 'History' },
];

interface StageGitProps {
  className?: string;
  /** The stream's live answer, so the controls free up the moment a run ends. */
  isRunActive: boolean;
  onChangeView: (view: GitView) => void;
  orgId: string | undefined;
  /** The files this run has changed, newest first (FR-029). */
  paths: readonly string[];
  projectId: string;
  view: GitView;
}

/**
 * Everything about the project's history. The design draws the unsaved changes
 * and the past as separate frames; they share a toolbar, so a switch between
 * them lives there rather than duplicating the bar in each.
 */
export function StageGit({
  className,
  isRunActive,
  onChangeView,
  orgId,
  paths,
  projectId,
  view,
}: StageGitProps): React.JSX.Element {
  // Shares the key the project screen already uses, so this is not a second request.
  const project = useQuery({
    enabled: orgId !== undefined && projectId !== '',
    queryFn: ({ signal }) => getProject(orgId ?? '', projectId, signal),
    queryKey: ['project', orgId, projectId],
  });
  const { link } = useGitSync(orgId, projectId);

  const permissions: readonly string[] = project.data?.project.permissions ?? [];
  const mayWrite = permissions.includes('project:files.write');

  return (
    <div className={cn('flex min-h-0 min-w-0 flex-col', className)}>
      <div className="bg-raised border-line-subtle flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5">
        <span className="flex-1" />

        <SegmentedControl
          ariaLabel="Git view"
          items={views}
          onChange={onChangeView}
          value={view}
          className="shrink-0"
        />
      </div>

      {view === 'changes' ? (
        <GitChanges paths={paths} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {orgId !== undefined && projectId !== '' ? (
            <GitHubPanel
              canWrite={mayWrite}
              isRunActive={isRunActive}
              orgId={orgId}
              projectId={projectId}
              projectName={project.data?.project.name}
            />
          ) : null}
          <GitHistory
            link={link}
            orgId={orgId}
            projectId={projectId}
            renderRevert={
              mayWrite
                ? (checkpoint, isHead) =>
                    isHead ? null : (
                      <RevertDialog
                        checkpoint={checkpoint}
                        isRunActive={isRunActive}
                        orgId={orgId}
                        projectId={projectId}
                      />
                    )
                : undefined
            }
          />
        </div>
      )}
    </div>
  );
}
