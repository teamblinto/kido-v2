import type { SignedInResponse } from '@repo/contracts';
import { createContext, use } from 'react';

/** The account, as every screen sees it. One spelling, whichever way it was learned. */
export type CurrentUser = SignedInResponse['user'];

export interface SessionState {
  /** Forget the current user without asking the server — used once the cookie is known to be gone. */
  readonly clearUser: () => void;
  /**
   * Whether the first `GET /auth/me` has answered.
   *
   * A state of its own rather than "no user yet", and that distinction is the whole reason this
   * context exists. Treating not-yet-known as signed-out would bounce every already-signed-in user
   * through a flash of the sign-in screen on every reload — and, worse, would do it while a
   * perfectly good session cookie sat in the jar.
   */
  readonly isResolving: boolean;
  /** Re-ask the server who the cookie belongs to. */
  readonly refresh: () => Promise<void>;
  /** Seed the session from a response that already carried the user, skipping a round trip. */
  readonly setUser: (user: CurrentUser) => void;
  readonly user: CurrentUser | undefined;
}

export const SessionContext = createContext<SessionState | undefined>(undefined);

/**
 * The session, or a thrown error naming the provider that is missing.
 *
 * Throwing beats returning `undefined`: a component that read the session as "no user" because
 * somebody rendered it outside the provider would show a sign-in screen to a signed-in person and
 * look like an authentication bug rather than a wiring one.
 */
export function useSession(): SessionState {
  const session = use(SessionContext);

  if (session === undefined) {
    throw new Error('useSession must be used within a SessionProvider.');
  }

  return session;
}
