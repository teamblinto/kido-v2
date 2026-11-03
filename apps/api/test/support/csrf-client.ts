import { randomBytes } from 'node:crypto';
import type request from 'supertest';

/**
 * What a browser on the app's own origin does with the pair T17 installed, as one call the e2e
 * suites wrap their unsafe requests in.
 *
 * Every unsafe request now has to present a double-submit token *and* an allowed `Origin`
 * (criterion 15), and supertest is not a browser: it keeps no cookie jar and sends no `Origin`. So
 * each suite has to supply both, exactly as the client it stands in for would. That is a client
 * gaining a capability, not a check being relaxed — `csrf.e2e-spec.ts` is where the refusals are
 * asserted, and nothing here can make a request that fails one of them succeed.
 *
 * The token is minted here rather than fetched from a prior response because the server keeps no
 * record of it: the double submit asks only whether the cookie and the header agree, which is why
 * the `Origin` check is required alongside it and why this helper sets that too.
 */

/** The single origin `CORS_ORIGINS` defaults to, and so the only one unsafe requests may claim. */
export const APP_ORIGIN = 'http://localhost:5173';

/** `CSRF_COOKIE_NAME`'s default. Deliberately not `__Host-` prefixed — see `csrf-token.ts`. */
export const CSRF_COOKIE_NAME = 'forge_csrf';

export const CSRF_HEADER_NAME = 'X-CSRF-Token';

/** Long enough to clear the floor `tokensMatch` holds a token to. */
export function csrfToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Add the CSRF pair and the `Origin` to an unsafe request, keeping any cookies the caller already
 * holds.
 *
 * The cookies are passed in rather than merged into an existing header because supertest's `.set`
 * replaces: a suite that had already set `Cookie` for its session and then set it again for the
 * CSRF token would silently send only the second, and every assertion about the session would fail
 * for a reason that had nothing to do with what it was testing.
 */
export function unsafe(test: request.Test, cookies: readonly string[] = []): request.Test {
  const token = csrfToken();

  return test
    .set('Cookie', [...cookies, `${CSRF_COOKIE_NAME}=${token}`])
    .set(CSRF_HEADER_NAME, token)
    .set('Origin', APP_ORIGIN);
}
