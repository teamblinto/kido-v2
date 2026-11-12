import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';

import { SESSION_QUERY_KEY } from '@/features/auth/session/session-provider';
import { ApiProblem } from '@/lib/api/problem';

/** Retries past this many attempts stop being resilience and start being a queue of stale work. */
const MAX_RETRIES = 2;

/**
 * Whether a failed request is worth trying again.
 *
 * A 4xx is a statement about the request, and the same request earns the same answer: retrying a
 * `422` cannot make a body valid, and retrying a `401` cannot make a dead cookie live. Either only
 * delays the message the user needs. A 5xx, or a service that could not be reached at all, is a
 * statement about the moment, and those are worth another go.
 */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_RETRIES) {
    return false;
  }

  return !(error instanceof ApiProblem) || error.status >= 500;
}

/**
 * The application's query client, with the session reaction below wired into both caches.
 *
 * Exported so a test can render a screen against the behaviour the application actually gives it.
 * A screen whose refusal is supposed to end in a redirect cannot prove that against a bare client:
 * it would be asserting the harness, not the app.
 */
export function createQueryClient(): QueryClient {
  // The handlers are constructed with the caches, which are constructed with the client, so the
  // client cannot be named directly inside them. A holder assigned immediately afterwards keeps
  // that honest rather than relying on a temporal dead zone nobody would expect to be safe.
  const holder: { current: QueryClient | undefined } = { current: undefined };

  /**
   * The app's single reaction to a session that is no longer good.
   *
   * Any request may be the one that discovers it — criterion 6 lets another device revoke this
   * session, and §11 ends one when a member is removed — so the reaction cannot live on a screen.
   * Dropping the session entry is the whole of it: `RequireAuth` is subscribed to that entry, and
   * the redirect follows on the next render.
   *
   * The session query is excluded, and that exclusion is load-bearing. `GET /auth/me` answers a
   * signed-out visitor with exactly this failure — it is the expected answer, not an incident — and
   * a handler that removed the very query it was reacting to would have it refetched, refused and
   * removed again, forever.
   */
  const dropSessionOnUnauthorized = (error: unknown, source: readonly unknown[]): void => {
    if (ApiProblem.is(error, 'unauthorized') && source[0] !== SESSION_QUERY_KEY[0]) {
      // Written straight into the cache as `null`, which the session query models as "nobody".
      // `unauthorized` means exactly one thing in this API — `SessionGuard` refused the cookie —
      // and authorization failures have their own slug (`permission-denied`), so there is nothing
      // left to confirm and no reason to spend a round trip confirming it.
      //
      // Removing or resetting the query instead would leave the mounted observer holding its last
      // result until a refetch landed, which is a window in which the app renders a person who is
      // no longer signed in.
      holder.current?.setQueryData(SESSION_QUERY_KEY, null);
    }
  };

  holder.current = new QueryClient({
    defaultOptions: {
      // Never retried: a bind, publish or migration the server applied before the 5xx would be
      // applied twice.
      mutations: { retry: false },
      queries: {
        refetchOnWindowFocus: false,
        retry: shouldRetry,
        staleTime: 30_000,
      },
    },
    // On the caches rather than in each hook, so a screen added later inherits the behaviour
    // instead of having to remember it.
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        dropSessionOnUnauthorized(error, mutation.options.mutationKey ?? []);
      },
    }),
    queryCache: new QueryCache({
      onError: (error, query) => {
        dropSessionOnUnauthorized(error, query.queryKey);
      },
    }),
  });

  return holder.current;
}
