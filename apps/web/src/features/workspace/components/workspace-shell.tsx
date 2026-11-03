import { MenuIcon, SearchIcon } from 'lucide-react';
import { useState } from 'react';

import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Wordmark } from '@/components/wordmark';
import type { Account, Workspace } from '../types';
import { WorkspaceSidebar } from './workspace-sidebar';

interface WorkspaceShellProps {
  account: Account;
  activeItem: string;
  activeWorkspaceId: string;
  children: React.ReactNode;
  onOpenCommandPalette: () => void;
  onOpenSessions: () => void;
  onOpenTwoFactor: () => void;
  onSelectWorkspace: (workspaceId: string) => void;
  workspaces: readonly Workspace[];
}

/**
 * The persistent frame every workspace screen sits in: a navigation rail that
 * becomes a sheet below `lg`, and the scrolling content beside it.
 */
export function WorkspaceShell({
  account,
  activeItem,
  activeWorkspaceId,
  children,
  onOpenCommandPalette,
  onOpenSessions,
  onOpenTwoFactor,
  onSelectWorkspace,
  workspaces,
}: WorkspaceShellProps): React.JSX.Element {
  const [isNavOpen, setIsNavOpen] = useState(false);

  const sidebar = (
    <WorkspaceSidebar
      account={account}
      activeItem={activeItem}
      activeWorkspaceId={activeWorkspaceId}
      workspaces={workspaces}
      onSelectWorkspace={(workspaceId) => {
        setIsNavOpen(false);
        onSelectWorkspace(workspaceId);
      }}
      onOpenCommandPalette={() => {
        setIsNavOpen(false);
        onOpenCommandPalette();
      }}
      onOpenSessions={() => {
        setIsNavOpen(false);
        onOpenSessions();
      }}
      onOpenTwoFactor={() => {
        setIsNavOpen(false);
        onOpenTwoFactor();
      }}
    />
  );

  return (
    <div className="flex min-h-dvh">
      <div className="border-line-subtle hidden w-[252px] shrink-0 border-r lg:block">
        {sidebar}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-line-subtle bg-canvas flex items-center gap-3 border-b px-4 py-3 lg:hidden">
          <Sheet open={isNavOpen} onOpenChange={setIsNavOpen}>
            <SheetTrigger className="text-subdued hover:text-foreground rounded-md p-1 transition-colors">
              <MenuIcon className="size-5" aria-hidden="true" />
              <span className="sr-only">Open workspace navigation</span>
            </SheetTrigger>
            <SheetContent side="left" aria-describedby={undefined}>
              <SheetTitle className="sr-only">Workspace navigation</SheetTitle>
              {sidebar}
            </SheetContent>
          </Sheet>
          <Wordmark />
          <button
            type="button"
            onClick={onOpenCommandPalette}
            className="text-subdued hover:text-foreground ml-auto rounded-md p-1 transition-colors"
          >
            <SearchIcon className="size-5" aria-hidden="true" />
            <span className="sr-only">Open command palette</span>
          </button>
        </header>

        <main className="flex min-w-0 flex-1 flex-col">{children}</main>
      </div>
    </div>
  );
}
