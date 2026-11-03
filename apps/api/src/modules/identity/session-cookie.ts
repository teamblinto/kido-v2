/**
 * The one place the browser-facing half of a session is described: the name, the attributes, and
 * the two directions the cookie travels.
 *
 * §11 makes every one of these attributes load-bearing, and `__Host-` is what turns the list from
 * a convention into something the browser enforces. A `__Host-`-prefixed cookie is rejected by the
 * browser outright unless it is `Secure`, has `Path=/`, and carries **no `Domain`** — so the cookie
 * is host-only to `app.forge.dev` and cannot be sent to any sibling subdomain, including one a
 * tenant serves (§03). `SameSite=Lax` keeps it off cross-site subrequests while leaving top-level
 * navigation into the app working; the CSRF pair in T17 covers what `Lax` alone does not.
 *
 * None of it is configurable. `environment.ts` already refuses a `SESSION_COOKIE_NAME` without the
 * prefix and deliberately publishes no `COOKIE_SECURE` switch, because a configurable `Secure` is a
 * configurable way to break the prefix — and a cookie that is quietly not `__Host-` in one
 * environment is a cookie whose guarantees nobody can rely on in any of them. Browsers treat
 * `http://localhost` as a trustworthy origin, so `Secure` costs nothing in development.
 */

/** The prefix the browser attaches the "no Domain, Secure, Path=/" rules to. */
export const SESSION_COOKIE_PREFIX = '__Host-';

/**
 * Exactly the attributes the session cookie is allowed to have.
 *
 * `domain?: never` is the structural half of the promise `session-cookie.spec.ts` asserts: setting
 * one is a compile error rather than something a reviewer has to notice was added. Everything else
 * is a literal type for the same reason — `sameSite: 'strict'` and `path: '/api'` are both changes
 * that would pass a `string`-typed field and break sign-in or the prefix respectively.
 */
export interface SessionCookieAttributes {
  /** Never set. The `__Host-` prefix makes the browser enforce this; the type stops us relying on it. */
  readonly domain?: never;
  readonly httpOnly: true;
  /** Milliseconds — Express's unit, not the TTL's. */
  readonly maxAge: number;
  readonly path: '/';
  readonly sameSite: 'lax';
  readonly secure: true;
}

/**
 * The part of the platform response this module touches, declared structurally for the reason
 * `ProblemDetailsFilter` gives: `@repo/api` depends on `@nestjs/platform-express`, not on `express`,
 * and a module that names the Express typings directly would be importing something the package
 * does not declare.
 */
export interface CookieWritingResponse {
  cookie(name: string, value: string, attributes: SessionCookieAttributes): unknown;
}

/**
 * Declared apart from {@link CookieWritingResponse} rather than added to it: signing in writes and
 * signing out clears, and a handler that can only do one of the two should not be typed as able to
 * do both. The platform response satisfies each on its own.
 */
export interface CookieClearingResponse {
  clearCookie(name: string, attributes: ClearedCookieAttributes): unknown;
}

/**
 * The attributes a deletion has to repeat.
 *
 * A browser identifies the cookie to remove by name, path and domain — the value and the lifetime
 * are not part of the match — so clearing with anything less leaves the original in place and adds
 * a second, empty cookie beside it. The user stays signed in behind a page that says they are not,
 * which is the worst of the available outcomes. `Max-Age` is Express's business here: it writes the
 * expiry that performs the deletion.
 */
export type ClearedCookieAttributes = Omit<SessionCookieAttributes, 'maxAge'>;

/** What `cookie-parser` leaves on the request. Absent when nothing parsed the header. */
export interface CookieBearingRequest {
  readonly cookies?: Readonly<Record<string, string | undefined>>;
}

/**
 * @param ttlSeconds the session's lifetime, in the seconds `SESSION_TTL_SECONDS` is expressed in.
 */
export function sessionCookieAttributes(ttlSeconds: number): SessionCookieAttributes {
  return {
    httpOnly: true,
    // Express writes `maxAge` in milliseconds and derives `Expires` from it. Handing it seconds
    // would turn a fortnight into twenty minutes, and the cookie would look correct in every
    // assertion that does not check the number.
    maxAge: ttlSeconds * 1_000,
    path: '/',
    sameSite: 'lax',
    secure: true,
  };
}

/**
 * Write the session cookie. The token goes here and nowhere else — never into a response body,
 * where it would land in a client's logs, a browser history entry or an error report (§11).
 */
export function setSessionCookie(
  response: CookieWritingResponse,
  name: string,
  token: string,
  ttlSeconds: number,
): void {
  assertHostPrefixed(name);

  response.cookie(name, token, sessionCookieAttributes(ttlSeconds));
}

function assertHostPrefixed(name: string): void {
  if (!name.startsWith(SESSION_COOKIE_PREFIX)) {
    throw new TypeError(
      `the session cookie name must start with ${SESSION_COOKIE_PREFIX}, got ${JSON.stringify(name)}`,
    );
  }
}

/**
 * Remove the session cookie: the browser-facing half of `POST /auth/logout`.
 *
 * The name is checked exactly as it is on the way in, because a mismatched prefix here fails in the
 * one direction nobody notices — the request succeeds, the response looks right, and the cookie the
 * user wanted gone is still in the jar.
 */
export function clearSessionCookie(response: CookieClearingResponse, name: string): void {
  assertHostPrefixed(name);

  // Taken apart from the same builder the cookie was written with rather than restated, so the two
  // cannot drift: an attribute added there and forgotten here is a cookie that will not clear.
  const { httpOnly, path, sameSite, secure } = sessionCookieAttributes(0);

  response.clearCookie(name, { httpOnly, path, sameSite, secure });
}

/**
 * Read the token back. An empty string is treated as absent: it is not a token, and letting it
 * through buys a Redis round trip whose only possible answer is the 401 we already know.
 */
export function readSessionCookie(request: CookieBearingRequest, name: string): string | undefined {
  const value = request.cookies?.[name];

  return value === undefined || value.length === 0 ? undefined : value;
}
