import type { CurrentUserResponse } from '@repo/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type PropsWithChildren, useCallback, useMemo } from 'react';

import { ApiProblem } from '@/lib/api/problem';
import { getCurrentUser } from '../api';
import { type CurrentUser, SessionContext, type SessionState } from './session-context';

/** The one cache entry the whole app agrees is "who is signed in". */
export const SESSION_QUERY_KEY = ['session'] as const;

/**
 * What the session query holds. `null` means *nobody* — a settled answer, not a missing one.
 *
 * Modelling signed-out as a value rather than as the query's error state is what makes the rest of
 * this file simple. An error state cannot be written into the cache, so "the cookie is gone" could
 * only ever be expressed by removing the query and hoping a refetch followed — and a removed query
 * leaves a mounted observer holding its last result, which is how a signed-out tab goes on
 * rendering the person who used to be signed in. `null` can be set, synchronously, by anything that
 * learns the truth.
 */
type Session = CurrentUserResponse | null;

/**
 * Resolves the session cookie into a user once, on boot, and holds the answer for everything else.
 *
 * `GET /auth/me` is the app's first request, and that ordering earns something beyond the user: it
 * is a safe method, so `CsrfMiddleware` mints the double-submit pair on its response. By the time
 * any form exists to submit, the token is already in the jar.
 */
export function SessionProvider({ children }: PropsWithChildren): React.JSX.Element {
  const queryClient = useQueryClient();

  const session = useQuery<Session>({
    queryFn: async ({ signal }) => {
      try {
        return await getCurrentUser(signal);
      } catch (error) {
        // The refusal *is* the answer. `me.ts` chose a 401 over "a 200 carrying an empty user" so
        // the two could never be confused, and this is the client's half of that: an expected
        // refusal becomes data, and anything else stays an error worth showing.
        if (ApiProblem.is(error, 'unauthorized')) {
          return null;
        }

        throw error;
      }
    },
    queryKey: SESSION_QUERY_KEY,
    retry: false,
    // Never served stale. Every other query in the app can tolerate a slightly old answer; "who is
    // signed in" cannot, because the wrong answer either shows a stranger's name or signs somebody
    // out of a page they are entitled to.
    staleTime: 0,
  });

  const setUser = useCallback(
    (user: CurrentUser) => {
      // Seeded rather than refetched. `POST /auth/login` and `POST /auth/mfa/challenge` both answer
      // with exactly the shape `GET /auth/me` does, which `me.ts` made an alias to guarantee — so
      // there is nothing left to ask, and asking would only widen the window in which the app knows
      // a session exists but not whose it is.
      const resolved: Session = { user };

      queryClient.setQueryData(SESSION_QUERY_KEY, resolved);
    },
    [queryClient],
  );

  const clearUser = useCallback(() => {
    queryClient.setQueryData(SESSION_QUERY_KEY, null satisfies Session);
  }, [queryClient]);

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
  }, [queryClient]);

  const value = useMemo<SessionState>(
    () => ({
      clearUser,
      // `isLoading` rather than `isPending`: a query refetching in the background is not the app
      // deciding who you are, and treating a background refetch as "resolving" would blank the
      // screen every time something asked again.
      isResolving: session.isLoading,
      refresh,
      setUser,
      user: session.data?.user,
    }),
    [clearUser, refresh, session.data, session.isLoading, setUser],
  );

  return <SessionContext value={value}>{children}</SessionContext>;
}
