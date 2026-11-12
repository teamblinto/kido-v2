import {
  CheckIcon,
  ChevronDownIcon,
  PlusIcon,
  SettingsIcon,
  UsersIcon,
  ZapIcon,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSection,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { routes } from '@/lib/routes';
import { cn } from '@/lib/utils';
import type { Workspace } from '../types';

interface WorkspaceSwitcherProps {
  activeWorkspaceId: string;
  onSelectWorkspace: (workspaceId: string) => void;
  workspaces: readonly Workspace[];
}

/** The workspace identity at the top of the sidebar, plus the switcher it opens. */
export function WorkspaceSwitcher({
  activeWorkspaceId,
  onSelectWorkspace,
  workspaces,
}: WorkspaceSwitcherProps): React.JSX.Element | null {
  const navigate = useNavigate();
  const active = workspaces.find((workspace) => workspace.id === activeWorkspaceId);

  if (!active) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'bg-raised border-line-subtle hover:bg-canvas flex w-full items-center gap-[9px]',
          'rounded-[9px] border p-2 text-left transition-colors',
        )}
      >
        <WorkspaceGlyph className="size-6 rounded-[7px]" iconClassName="size-3.5" />
        <span className="min-w-0 flex-1">
          <span className="text-label-sm text-foreground block truncate font-medium">
            {active.name}
          </span>
          <span className="text-caption text-faint block truncate">
            {active.plan} · {active.seats}
          </span>
        </span>
        <ChevronDownIcon className="text-faint size-[15px] shrink-0" aria-hidden="true" />
        <span className="sr-only">Switch workspace</span>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-[292px]">
        <div className="flex flex-col gap-3 p-[13px]">
          <div className="flex items-center gap-2.5">
            <WorkspaceGlyph className="size-[30px] rounded-lg" iconClassName="size-4" />
            <div className="min-w-0 flex-1">
              <p className="text-label-sm text-foreground truncate font-medium">{active.name}</p>
              <p className="text-caption text-faint truncate">
                {active.plan} plan · {active.seats}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="text-label-xs h-[30px] flex-1"
              onClick={() => {
                void navigate(routes.settings);
              }}
            >
              <SettingsIcon className="size-3.5" aria-hidden="true" />
              Settings
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-label-xs h-[30px] flex-1"
              onClick={() => {
                void navigate(routes.membersSettings);
              }}
            >
              <UsersIcon className="size-3.5" aria-hidden="true" />
              Invite
            </Button>
          </div>
        </div>

        <DropdownMenuSeparator />

        <DropdownMenuSection>
          <DropdownMenuLabel>All workspaces</DropdownMenuLabel>
          {workspaces.map((workspace) => {
            const isActive = workspace.id === activeWorkspaceId;

            return (
              <DropdownMenuItem
                key={workspace.id}
                className={cn(isActive && 'bg-muted')}
                onSelect={() => {
                  onSelectWorkspace(workspace.id);
                }}
              >
                <ZapIcon aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                {isActive ? (
                  <CheckIcon className="text-brand size-3.5" aria-label="Current workspace" />
                ) : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuSection>

        <DropdownMenuSeparator />

        <DropdownMenuSection>
          <DropdownMenuItem
            onSelect={() => {
              void navigate(routes.newOrg);
            }}
          >
            <PlusIcon aria-hidden="true" />
            Create new workspace
          </DropdownMenuItem>
        </DropdownMenuSection>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WorkspaceGlyph({
  className,
  iconClassName,
}: {
  className?: string;
  iconClassName?: string;
}): React.JSX.Element {
  return (
    <span
      className={cn('bg-brand flex shrink-0 items-center justify-center', className)}
      aria-hidden="true"
    >
      <ZapIcon className={cn('text-white', iconClassName)} />
    </span>
  );
}
