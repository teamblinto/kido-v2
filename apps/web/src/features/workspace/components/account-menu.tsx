import {
  BookOpenIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EyeIcon,
  LinkIcon,
  LogOutIcon,
  MonitorIcon,
  SearchIcon,
  ShieldCheckIcon,
} from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSection,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { signOut } from '@/features/auth/api';
import { useSession } from '@/features/auth/session/session-context';
import { SESSION_QUERY_KEY } from '@/features/auth/session/session-provider';
import { routes } from '@/lib/routes';
import { cn } from '@/lib/utils';
import { commandShortcutLabel } from '../hooks/use-command-shortcut';
import type { Account } from '../types';

interface AccountMenuProps {
  account: Account;
  onOpenCommandPalette: () => void;
  /** Opens the signed-in-devices dialog (criterion 6). */
  onOpenSessions: () => void;
  /** Opens the two-factor authentication dialog (spec 003). */
  onOpenTwoFactor: () => void;
}

/** The signed-in identity pinned to the bottom of the sidebar. */
export function AccountMenu({
  account,
  onOpenCommandPalette,
  onOpenSessions,
  onOpenTwoFactor,
}: AccountMenuProps): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { clearUser } = useSession();
  const initial = account.name.slice(0, 1).toUpperCase();

  const logout = useMutation({
    mutationFn: signOut,
    // Settled rather than success. The route is `@Public()` and always answers 204 — signing out
    // is idempotent — but a network failure must still end the session locally. Leaving somebody
    // on a signed-in page after they pressed Sign out is the one outcome this must never produce.
    onSettled: async () => {
      // Every other entry was read under a session that no longer exists, so it goes. The session
      // entry is set rather than removed: `clearUser` writes the settled "nobody" value, which the
      // guards read immediately.
      //
      // `queryClient.clear()` was wrong here and cost a real bug. It drops the session query out
      // from under the mounted observer, which keeps its last result — so the app went on knowing
      // the signed-out user, and `RequireAnon` bounced the redirect straight back to the dashboard.
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== SESSION_QUERY_KEY[0],
      });
      clearUser();
      await navigate(routes.signIn, { replace: true });
    },
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'hover:bg-secondary/60 flex w-full items-center gap-[9px] rounded-lg px-2 py-[7px]',
          'text-left transition-colors',
        )}
      >
        <Avatar className="size-[26px]">
          <AvatarFallback>{initial}</AvatarFallback>
        </Avatar>
        <span className="min-w-0 flex-1">
          <span className="text-label-xs text-foreground block truncate font-medium">
            {account.name}
          </span>
          <span className="text-caption text-faint block truncate">{account.email}</span>
        </span>
        <ChevronDownIcon className="text-faint size-3.5 shrink-0" aria-hidden="true" />
        <span className="sr-only">Open account menu</span>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="top" className="w-[280px]">
        <div className="flex items-center gap-2.5 p-[13px]">
          <Avatar className="size-8">
            <AvatarFallback>{initial}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="text-label-sm text-foreground truncate font-medium">{account.name}</p>
            <p className="text-caption text-faint truncate">{account.email}</p>
          </div>
        </div>

        <DropdownMenuSeparator />

        <DropdownMenuSection>
          <DropdownMenuItem
            onSelect={() => {
              onOpenSessions();
            }}
          >
            <MonitorIcon aria-hidden="true" />
            Signed-in devices
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              onOpenTwoFactor();
            }}
          >
            <ShieldCheckIcon aria-hidden="true" />
            Two-factor authentication
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              void navigate(routes.accountSettings);
            }}
          >
            <LinkIcon aria-hidden="true" />
            Connected accounts
          </DropdownMenuItem>
          <DropdownMenuItem>
            <EyeIcon aria-hidden="true" />
            <span className="flex-1">Appearance</span>
            <ChevronRightIcon className="size-[13px]" aria-hidden="true" />
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onOpenCommandPalette}>
            <SearchIcon aria-hidden="true" />
            <span className="flex-1">Command palette</span>
            <DropdownMenuShortcut>{commandShortcutLabel}</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuSection>

        <DropdownMenuSeparator />

        <DropdownMenuSection>
          <DropdownMenuItem>
            <BookOpenIcon aria-hidden="true" />
            Documentation
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={logout.isPending}
            onSelect={() => {
              logout.mutate();
            }}
          >
            <LogOutIcon aria-hidden="true" />
            {logout.isPending ? 'Signing out…' : 'Sign out'}
          </DropdownMenuItem>
        </DropdownMenuSection>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
