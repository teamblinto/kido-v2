import { AlertTriangleIcon, CheckIcon, CloudUploadIcon, Loader2Icon } from 'lucide-react';

import { GitHubIcon } from '@/components/icons/brand-icons';
import { cn } from '@/lib/utils';
import type { GitSync, GitSyncStatus } from '../hooks/use-git-sync';
import { repoUrl } from '../lib/github-sync';

const CHIP: Partial<
  Record<
    GitSyncStatus,
    { readonly icon: typeof CheckIcon; readonly label: string; readonly tone: string }
  >
> = {
  ahead: { icon: CloudUploadIcon, label: 'Not pushed yet', tone: 'text-subdued' },
  'needs-attention': { icon: AlertTriangleIcon, label: 'Needs attention', tone: 'text-warning' },
  synced: { icon: CheckIcon, label: 'Synced', tone: 'text-success' },
  syncing: { icon: Loader2Icon, label: 'Syncing…', tone: 'text-subdued' },
};

const iconClass = cn(
  'text-subdued hover:bg-muted hover:text-foreground flex size-[30px] items-center',
  'justify-center rounded-md transition-colors',
);

/**
 * The bar's view of GitHub: the icon goes to the real repository, or to the panel while there is
 * none, and the chip beside it says how the sync stands and opens the panel. The chip sits in a
 * status region that is always there, so a change is announced rather than only repainted.
 */
export function GitHubSyncChip({
  git,
  onOpen,
}: {
  readonly git: Pick<GitSync, 'link' | 'status'>;
  readonly onOpen: () => void;
}): React.JSX.Element {
  const { link, status } = git;
  const chip = status === undefined ? undefined : CHIP[status];

  return (
    <div className="flex items-center gap-1 max-lg:hidden">
      {link === null || link === undefined ? (
        <button type="button" onClick={onOpen} className={iconClass}>
          <GitHubIcon className="size-4" />
          <span className="sr-only">Set up GitHub for this project</span>
        </button>
      ) : (
        <a
          href={repoUrl(link.repository.fullName)}
          target="_blank"
          rel="noreferrer"
          className={iconClass}
        >
          <GitHubIcon className="size-4" />
          <span className="sr-only">Open the repository on GitHub</span>
        </a>
      )}

      <span role="status">
        {chip === undefined ? null : (
          <button
            type="button"
            onClick={onOpen}
            className={cn(
              'text-label-xs hover:bg-muted flex items-center gap-1 rounded-md px-1.5 py-1',
              'font-medium whitespace-nowrap transition-colors',
              chip.tone,
            )}
          >
            <chip.icon
              className={cn('size-3.5', status === 'syncing' && 'animate-spin')}
              aria-hidden="true"
            />
            <span className="sr-only">GitHub: </span>
            <span>{chip.label}</span>
          </button>
        )}
      </span>
    </div>
  );
}
