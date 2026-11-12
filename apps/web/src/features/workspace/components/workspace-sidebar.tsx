import {
  DownloadIcon,
  FolderIcon,
  HomeIcon,
  type LucideIcon,
  SearchIcon,
  SettingsIcon,
  UsersIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { routes } from '@/lib/routes';
import { cn } from '@/lib/utils';
import type { Account, Workspace } from '../types';
import { AccountMenu } from './account-menu';
import { WorkspacesDialog } from './workspaces-dialog';
import { WorkspaceSwitcher } from './workspace-switcher';

interface NavItem {
  icon: LucideIcon;
  label: string;
  /** Present when the item runs a command rather than navigating. */
  onSelect?: () => void;
  /** Where the item navigates; every item has this or `onSelect`. */
  to?: string;
}

interface NavGroup {
  items: readonly NavItem[];
  title?: string;
}

interface WorkspaceSidebarProps {
  account: Account;
  activeItem: string;
  activeWorkspaceId: string;
  onOpenCommandPalette: () => void;
  onOpenSessions: () => void;
  onOpenTwoFactor: () => void;
  onSelectWorkspace: (workspaceId: string) => void;
  workspaces: readonly Workspace[];
}

/** Workspace navigation rail. Rendered inline on desktop and inside a sheet on mobile. */
export function WorkspaceSidebar({
  account,
  activeItem,
  activeWorkspaceId,
  onOpenCommandPalette,
  onOpenSessions,
  onOpenTwoFactor,
  onSelectWorkspace,
  workspaces,
}: WorkspaceSidebarProps): React.JSX.Element {
  const [isWorkspacesOpen, setIsWorkspacesOpen] = useState(false);
  const navGroups: readonly NavGroup[] = [
    {
      items: [
        { icon: HomeIcon, label: 'Home', to: routes.home },
        { icon: SearchIcon, label: 'Search', onSelect: onOpenCommandPalette },
      ],
    },
    {
      items: [
        { icon: DownloadIcon, label: 'Import from GitHub', to: routes.projectNewImport },
        {
          icon: FolderIcon,
          label: 'Workspaces',
          onSelect: () => {
            setIsWorkspacesOpen(true);
          },
        },
      ],
      title: 'Projects',
    },
    {
      items: [
        { icon: UsersIcon, label: 'Members', to: routes.membersSettings },
        { icon: SettingsIcon, label: 'Settings', to: routes.settings },
      ],
      title: 'Organisation',
    },
  ];

  return (
    <div className="bg-subtle flex h-full flex-col px-3 py-3.5">
      <WorkspaceSwitcher
        activeWorkspaceId={activeWorkspaceId}
        onSelectWorkspace={onSelectWorkspace}
        workspaces={workspaces}
      />

      <nav aria-label="Workspace" className="mt-3.5 flex-1 overflow-y-auto">
        {navGroups.map((group, index) => (
          <div key={group.title ?? 'primary'} className={cn(index > 0 && 'mt-[18px]')}>
            {group.title ? (
              <h2 className="text-overline text-faint px-2 pb-1.5 font-medium uppercase">
                {group.title}
              </h2>
            ) : null}
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <li key={item.label}>
                  <NavLink item={item} isActive={item.label === activeItem} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="mt-4">
        <AccountMenu
          account={account}
          onOpenCommandPalette={onOpenCommandPalette}
          onOpenSessions={onOpenSessions}
          onOpenTwoFactor={onOpenTwoFactor}
        />
      </div>

      {/* The switcher's ids are organisation ids (see `toWorkspaceSummary`). */}
      <WorkspacesDialog
        open={isWorkspacesOpen}
        orgId={activeWorkspaceId}
        onOpenChange={setIsWorkspacesOpen}
      />
    </div>
  );
}

function NavLink({ isActive, item }: { isActive: boolean; item: NavItem }): React.JSX.Element {
  const className = cn(
    'text-label-sm flex w-full items-center gap-2.5 rounded-[7px] px-2 py-[7px] font-medium transition-colors',
    isActive
      ? 'bg-secondary text-foreground'
      : 'text-subdued hover:bg-secondary/60 hover:text-foreground',
  );
  const content = (
    <>
      <item.icon className="size-4 shrink-0" aria-hidden="true" />
      {item.label}
    </>
  );

  if (item.onSelect) {
    return (
      <button type="button" className={className} onClick={item.onSelect}>
        {content}
      </button>
    );
  }

  return (
    <Link
      to={item.to ?? routes.home}
      aria-current={isActive ? 'page' : undefined}
      className={className}
    >
      {content}
    </Link>
  );
}
