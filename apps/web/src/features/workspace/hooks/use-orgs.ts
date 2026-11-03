import type { OrgMembership } from '@repo/contracts';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';

import { useSession } from '@/features/auth/session/session-context';
import { listOrgs } from '../api';

export const ORGS_QUERY_KEY = ['orgs'] as const;

/**
 * Where the chosen organisation is remembered, keyed by account.
 *
 * Per user, deliberately. A shared browser where one account's last organisation became another
 * account's default would be a surprise about what the machine remembers, and on the first render
 * after a switch it would point every tenancy request at an organisation the new caller may not be
 * in — a burst of 403s explaining nothing.
 */
function storageKey(userId: string): string {
  return `forge.activeOrg.${userId}`;
}

/**
 * `localStorage` is external mutable state, so it is read through `useSyncExternalStore` rather
 * than copied into a `useState` by an effect.
 *
 * The effect version renders once with the wrong value and once with the right one, which for this
 * particular value means one render pointing every tenancy query at the wrong organisation. It also
 * misses writes made anywhere but this hook — including the `storage` event another tab fires,
 * which is subscribed to below so switching organisation in one tab is not silently contradicted by
 * the next thing that happens in another.
 */
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('storage', listener);

  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

function readStored(userId: string | undefined): string | null {
  if (userId === undefined) {
    return null;
  }

  try {
    return window.localStorage.getItem(storageKey(userId));
  } catch {
    // Private-browsing modes and blocked storage both throw here. Losing the preference is a much
    // smaller failure than the workspace refusing to render, so it is swallowed.
    return null;
  }
}

function writeStored(userId: string, orgId: string): void {
  try {
    window.localStorage.setItem(storageKey(userId), orgId);
  } catch {
    // As above.
  }

  for (const listener of listeners) {
    listener();
  }
}

export interface OrgsState {
  readonly activeOrg: OrgMembership | undefined;
  readonly error: unknown;
  /** True once the list has loaded and is genuinely empty — the create-an-organisation state. */
  readonly isEmpty: boolean;
  /**
   * Spec 031 (FR-035): the active organisation is one the caller reaches only through project
   * grants. It counts as an organisation — the create-an-org screen is for someone with neither a
   * membership nor a grant — but its home is the shared projects and nothing else.
   */
  readonly isGuest: boolean;
  readonly isLoading: boolean;
  readonly orgs: readonly OrgMembership[];
  readonly selectOrg: (orgId: string) => void;
}

/**
 * The caller's organisations, and which one the app is currently looking at.
 *
 * The active organisation is resolved from the stored preference on every render rather than copied
 * into state, so a stored id that is no longer in the list — the caller was removed, or the
 * organisation was deleted — falls back to the first one instead of leaving the app pointed at an
 * organisation every request will refuse.
 */
export function useOrgs(): OrgsState {
  const { user } = useSession();
  const userId = user?.id;

  const orgs = useQuery({
    // Enabled only once there is somebody to ask for. Firing it while the session is still
    // resolving would spend a guaranteed 401 on every cold load.
    enabled: userId !== undefined,
    queryFn: ({ signal }) => listOrgs(signal),
    queryKey: ORGS_QUERY_KEY,
  });

  const preferred = useSyncExternalStore(
    subscribe,
    () => readStored(userId),
    // The server has no `localStorage`. Returning null there means the first client render agrees
    // with the markup and picks the default, which is the same answer a fresh browser gives.
    () => null,
  );

  const available = orgs.data?.orgs ?? [];
  const activeOrg = available.find((org) => org.id === preferred) ?? available[0];

  const selectOrg = useCallback(
    (orgId: string) => {
      if (userId !== undefined) {
        writeStored(userId, orgId);
      }
    },
    [userId],
  );

  return {
    activeOrg,
    error: orgs.error,
    isEmpty: orgs.isSuccess && available.length === 0,
    isGuest: activeOrg?.access === 'guest',
    isLoading: userId === undefined || orgs.isLoading,
    orgs: available,
    selectOrg,
  };
}
