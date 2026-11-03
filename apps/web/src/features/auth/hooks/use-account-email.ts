import { useLocation } from 'react-router-dom';

import { useSession } from '../session/session-context';

/**
 * The address to name on a screen in the middle of a flow.
 *
 * Three sources, in this order, and the order is the point:
 *
 * 1. **Router state.** Signup and password reset both hand the address forward, and neither has a
 *    session to read it from — signup deliberately does not sign the new account in (ADR 007), and
 *    a reset is requested by somebody who cannot sign in at all.
 * 2. **The session.** After a sign-in the authoritative answer is the server's, and it beats
 *    anything a previous screen guessed. Only reached when no state was carried, so it never
 *    overwrites the address a flow is actually about.
 * 3. **The fallback.** A description rather than an address, for a page reached directly.
 */
export function useAccountEmail(fallback = 'your email address'): string {
  const state: unknown = useLocation().state;
  const { user } = useSession();

  if (typeof state === 'object' && state !== null && 'email' in state) {
    const { email } = state;

    if (typeof email === 'string' && email.length > 0) {
      return email;
    }
  }

  return user?.email ?? fallback;
}
