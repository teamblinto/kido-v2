import { isSameOriginRelativePath } from '@repo/contracts';
import { Loader2 } from 'lucide-react';
import type { PropsWithChildren } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { routes } from '@/lib/routes';
import { useSession } from './session-context';

/**
 * What the app shows while `GET /auth/me` is in flight.
 *
 * Deliberately not the sign-in screen and deliberately not the application shell: on a reload the
 * answer is unknown for one round trip, and rendering either guess means half of all users see a
 * screen flash into a different one.
 */
function ResolvingSession(): React.JSX.Element {
  return (
    <div
      className="flex min-h-dvh items-center justify-center"
      // Announced rather than silent, because a screen reader has no way to perceive a spinner and
      // would otherwise meet an empty page.
      role="status"
      aria-live="polite"
    >
      <Loader2 className="text-subdued size-6 animate-spin" aria-hidden="true" />
      <span className="sr-only">Loading your account</span>
    </div>
  );
}

/**
 * Gate for everything behind the sign-in wall.
 *
 * The location is carried in `state.from` so the redirect back after signing in lands on the page
 * that was asked for. `replace` keeps the guarded URL out of history — without it, the back button
 * from the sign-in screen returns to a route that will only bounce here again.
 */
export function RequireAuth({ children }: PropsWithChildren): React.JSX.Element {
  const { isResolving, user } = useSession();
  const location = useLocation();

  if (isResolving) {
    return <ResolvingSession />;
  }

  if (user === undefined) {
    return <Navigate to={routes.signIn} state={{ from: location }} replace />;
  }

  return <>{children}</>;
}

/**
 * Gate for the sign-in and sign-up screens.
 *
 * An authenticated caller is sent on rather than shown a form that would sign them in as themselves
 * again — and, on the sign-in page specifically, rotate a perfectly good session.
 *
 * "On" is the return path, not home: this is also what moves a caller who has *just* signed in. The
 * session lands as an urgent update while the router's navigation is still a transition, so this
 * gate re-renders on the sign-in URL first; were it to aim anywhere else, its redirect would win.
 */
export function RequireAnon({ children }: PropsWithChildren): React.JSX.Element {
  const { isResolving, user } = useSession();
  const location = useLocation();

  if (isResolving) {
    return <ResolvingSession />;
  }

  if (user !== undefined) {
    // §11 makes an unverified account usable but unable to create sandboxes, so this is a detour
    // rather than a wall: the session is real and it stays.
    const destination = user.emailVerified
      ? destinationAfterSignIn(returnStateOf(location))
      : routes.unverifiedEmail;

    return <Navigate to={destination} replace />;
  }

  return <>{children}</>;
}

/**
 * Where to send somebody after they sign in.
 *
 * Only ever a path this router owns. `state.from` is a `Location` the router itself put there, but
 * it arrives through history state, which a page can write — so anything that is not a same-origin
 * path collapses to the home route rather than becoming an open redirect on the one screen that
 * would carry a fresh session through it.
 */
export function destinationAfterSignIn(state: unknown): string {
  if (typeof state === 'object' && state !== null && 'from' in state) {
    const { from } = state;

    if (typeof from === 'object' && from !== null && 'pathname' in from) {
      const { pathname } = from;

      if (typeof pathname === 'string' && pathname.startsWith('/') && !pathname.startsWith('//')) {
        // The query travels too: `/preview-authorize?label=…&return=…` is nothing without it.
        const search = 'search' in from && typeof from.search === 'string' ? from.search : '';

        return `${pathname}${search}`;
      }
    }
  }

  return routes.home;
}

/**
 * Spec 031 (R7): a return address arrives either as router state (a guard redirected here) or as
 * `?next=` on a mailed link (the account-exists mail's sign-in button). State wins; the query is
 * held to the same same-origin-relative rule, and travels on to sign-up the same way.
 */
export function returnStateOf(location: { search: string; state: unknown }): unknown {
  const queryNext = safeNext(new URLSearchParams(location.search).get('next'));

  return destinationAfterSignIn(location.state) === routes.home && queryNext !== undefined
    ? { from: fromOf(queryNext) }
    : location.state;
}

/**
 * Spec 031 (research R7): a return address that may be followed — a same-origin relative path, the
 * same rule the API applies before putting one in a mail (`isSameOriginRelativePath`). Anything else,
 * including `//host`, a scheme or a non-string, is `undefined`, and the caller goes home instead.
 */
export function safeNext(value: unknown): string | undefined {
  return typeof value === 'string' && isSameOriginRelativePath(value) ? value : undefined;
}

/** The `next` a sign-up should carry: where sign-in would have returned to, if anywhere. */
export function nextFromState(state: unknown): string | undefined {
  const destination = destinationAfterSignIn(state);

  return destination === routes.home ? undefined : safeNext(destination);
}

/** A relative path as the `state.from` {@link destinationAfterSignIn} reads. */
export function fromOf(next: string): { pathname: string; search: string } {
  const url = new URL(next, 'http://relative.invalid');

  return { pathname: url.pathname, search: url.search };
}
