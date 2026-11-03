import {
  presenceResponseSchema,
  type PresenceLocation,
  type PresenceResponse,
} from '@repo/contracts';
import { useEffect, useState } from 'react';

import { apiRequest } from '@/lib/api/client';

/** How often a visible page says where it is (contracts/presence.md § 4). */
export const PRESENCE_POLL_MS = 4000;

function presencePath(orgId: string, projectId: string): string {
  return `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/presence`;
}

interface UsePresenceOptions {
  readonly location: PresenceLocation;
  readonly orgId: string | undefined;
  readonly projectId: string;
}

/**
 * Who else has this project open (spec 031, US3). `PUT`s the caller's location every
 * {@link PRESENCE_POLL_MS} and at once on a change, only while the tab is visible — a hidden tab
 * drops off after the server's 30 s TTL, as a sleeping device would. `DELETE` with `keepalive` on
 * `pagehide`, best effort. Failures are swallowed: presence is an ornament, never an error.
 */
export function usePresence({
  location,
  orgId,
  projectId,
}: UsePresenceOptions): PresenceResponse | undefined {
  const [presence, setPresence] = useState<PresenceResponse | undefined>(undefined);
  // Compared by value: a fresh object with the same location is not a move.
  const key = JSON.stringify(location);

  useEffect(() => {
    if (orgId === undefined || projectId.length === 0) {
      return undefined;
    }

    const path = presencePath(orgId, projectId);
    const current = JSON.parse(key) as PresenceLocation;
    let timer: ReturnType<typeof setInterval> | undefined;
    let active = true;

    const send = (): void => {
      apiRequest('PUT', path, {
        body: { location: current },
        schema: presenceResponseSchema,
      }).then(
        (answer) => {
          if (active) {
            setPresence(answer);
          }
        },
        () => undefined,
      );
    };

    const stop = (): void => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };

    const start = (): void => {
      stop();
      send();
      timer = setInterval(send, PRESENCE_POLL_MS);
    };

    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        start();
      } else {
        stop();
      }
    };

    const onPageHide = (): void => {
      apiRequest('DELETE', path, { keepalive: true }).catch(() => undefined);
    };

    if (document.visibilityState === 'visible') {
      start();
    }

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);

    return () => {
      active = false;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
    // `key` restarts the loop on a location change, which sends at once (FR-027).
  }, [orgId, projectId, key]);

  return presence;
}
