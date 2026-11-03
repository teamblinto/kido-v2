import { randomBytes } from 'node:crypto';

import { secretsMatch } from '../crypto/constant-time';

/**
 * The double-submit half of §03's CSRF pair: the token, the cookie it travels in, and the four
 * allowlists that decide whether a request has to present one.
 *
 * The pattern is deliberately unsigned and stateless. The server mints a random value, writes it to
 * a cookie the client can read, and asks for the same value back in a header; a cross-site attacker
 * can make the browser send the cookie but cannot read it to set the header, because reading it
 * needs a same-origin document. There is nothing to store and nothing to rotate, which is why this
 * module holds no state and takes no dependency on Redis.
 *
 * On its own that is not enough, and §03 does not ask for it on its own. A token in a cookie is
 * writable by any script on a sibling of `app.forge.dev`, so an XSS on a subdomain can set both
 * halves of the pair and the double submit agrees with itself. The `Origin` check is what closes
 * that, and the token is what closes the case where `Origin` is absent from a request that a
 * `SameSite=Lax` cookie still rides on. Neither check substitutes for the other, which is why
 * `csrf.middleware.ts` requires both and refuses to treat either as sufficient.
 */

/** 32 bytes, the same budget the session token gets: far past guessing, small enough for a header. */
const CSRF_TOKEN_BYTES = 32;

/**
 * The shortest value {@link tokensMatch} will call a token — the base64url length of
 * {@link CSRF_TOKEN_BYTES}.
 *
 * It exists because equality alone is not a check. Two absent values are equal, two empty strings
 * are equal, and a comparison that stopped at "are these the same" would answer 200 to a client
 * that sent a blank cookie and a blank header, which is every client an attacker controls. The
 * floor is what makes presenting nothing twice a rejection rather than a match.
 */
export const CSRF_TOKEN_MIN_LENGTH = Math.ceil((CSRF_TOKEN_BYTES * 4) / 3);

/**
 * Where the client echoes the token back. A header rather than a body field, so the check is the
 * same for JSON, for a form and for a request with no body at all — and so it cannot be set by an
 * HTML form, which can post cross-site but cannot add headers.
 *
 * Lowercase because that is how Node normalises inbound header names, and reading `headers` under
 * any other spelling silently finds nothing.
 */
export const CSRF_HEADER = 'x-csrf-token';

/**
 * The prefix this cookie must **not** carry, checked at the boundary the way `session-cookie.ts`
 * checks for its presence.
 *
 * `__Host-` is this codebase's mark of the session cookie: the one value the browser is told to
 * keep host-only and that nothing on the page may read. `environment.ts` refuses a
 * `SESSION_COOKIE_NAME` without it and `setSessionCookie` refuses to write one without it, so a
 * second `__Host-` cookie — script-readable, by design — would make the prefix stop answering the
 * question it is there to answer. The attributes below still promise everything the prefix would
 * have enforced; what is not claimed is the mark.
 */
export const CSRF_COOKIE_FORBIDDEN_PREFIX = '__Host-';

/**
 * The methods exempt from the check, as a list rather than as "everything except the unsafe ones".
 *
 * Stated positively on purpose. A rule that exempts what is not `POST | PUT | PATCH | DELETE` reads
 * identically but fails open on every method nobody enumerated — `TRACE`, a WebDAV verb, whatever a
 * proxy invents next. Adding a method to this set is a decision somebody makes; forgetting one is
 * a 403, which is the direction to fail in.
 */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The attributes the CSRF cookie is allowed to have — the deliberate mirror of
 * `SessionCookieAttributes`, differing in exactly one field.
 *
 * `httpOnly: false` is the literal type rather than `boolean` because it is the point of the
 * cookie, not a setting: the client has to read this value to echo it, and an `HttpOnly` one leaves
 * the double submit with nothing to submit. Typing it shut means "fixing" the asymmetry is a
 * compile error rather than a plausible-looking edit that silently 403s every unsafe request.
 *
 * `domain?: never` for the reason the session cookie gives, and it matters more here rather than
 * less: a `Domain` would put the token in reach of every sibling of `app.forge.dev` (§03), handing
 * the subdomain attacker both halves of the pair.
 */
export interface CsrfCookieAttributes {
  readonly domain?: never;
  readonly httpOnly: false;
  /** Milliseconds — Express's unit, not the TTL's. */
  readonly maxAge: number;
  readonly path: '/';
  readonly sameSite: 'lax';
  readonly secure: true;
}

/** The part of the platform response this module writes to, declared structurally as ADR-style. */
export interface CsrfCookieWritingResponse {
  cookie(name: string, value: string, attributes: CsrfCookieAttributes): unknown;
}

/** Inbound headers as Node hands them over: lowercased keys, and a list when one arrived twice. */
export type InboundHeaders = Readonly<Record<string, string | string[] | undefined>>;

export function csrfCookieAttributes(ttlSeconds: number): CsrfCookieAttributes {
  return {
    // The one difference from the session cookie, and the mechanism rather than an oversight.
    httpOnly: false,
    maxAge: ttlSeconds * 1_000,
    path: '/',
    // `Lax` for the same reason the session cookie is: `Strict` would drop the token on the
    // top-level navigation that brings a user into the app, and the first unsafe request after
    // following a link from anywhere would 403 until something re-issued the pair.
    sameSite: 'lax',
    // Not negotiable and not configurable, exactly as `session-cookie.ts` argues: a token that can
    // travel in clear text is a token an on-path attacker can read and echo.
    secure: true,
  };
}

/** base64url so the value needs no quoting in a `Set-Cookie` and no encoding in a header. */
export function issueCsrfToken(): string {
  return randomBytes(CSRF_TOKEN_BYTES).toString('base64url');
}

export function setCsrfCookie(
  response: CsrfCookieWritingResponse,
  name: string,
  token: string,
  ttlSeconds: number,
): void {
  if (name.startsWith(CSRF_COOKIE_FORBIDDEN_PREFIX)) {
    throw new TypeError(
      `the CSRF cookie is read by the client and must not carry the ${CSRF_COOKIE_FORBIDDEN_PREFIX} prefix, got ${JSON.stringify(name)}`,
    );
  }

  response.cookie(name, token, csrfCookieAttributes(ttlSeconds));
}

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

/**
 * Whether a path is on the webhook exemption list.
 *
 * Exact string membership, and that is the requirement rather than an implementation detail. A
 * prefix test on `/api/v1/webhooks` exempts every route anybody later mounts underneath it,
 * including the one that forgets to verify a signature — and that route looks exactly like its
 * neighbours in review. A path that is spelled differently from its entry simply is not on the
 * list, so an encoded or traversed variant fails closed rather than needing its own rule.
 *
 * The query string is dropped because it is not part of the route, and a trailing slash with it
 * because Express routes `/x/` and `/x` to the same handler — an exemption that disagreed with the
 * router about which path this is would be an exemption for a route, or a gap in one.
 */
export function isExemptPath(path: string, exempt: ReadonlySet<string>): boolean {
  return exempt.has(routePath(path));
}

/**
 * Spec 040: whether a path is one of the companion's device-token routes. Anchored patterns whose
 * only variable segment is a uuid, over the same normalised path `isExemptPath` compares.
 */
export function isDeviceTokenPath(path: string, patterns: readonly RegExp[]): boolean {
  const normalised = routePath(path);

  return patterns.some((pattern) => pattern.test(normalised));
}

function routePath(path: string): string {
  const [withoutQuery = ''] = path.split('?');

  return withoutQuery.length > 1 && withoutQuery.endsWith('/')
    ? withoutQuery.slice(0, -1)
    : withoutQuery;
}

/**
 * Reduce a header or a configured entry to the `scheme://host[:port]` an origin actually is, or
 * `undefined` for anything that is not one.
 *
 * `undefined` covers three cases the caller must treat alike: no header, a header that is not a
 * URL, and the literal `null` that a sandboxed iframe or a cross-origin redirect sends. That last
 * one is a real value meaning "an origin I will not name", and it must fail the allowlist rather
 * than be parsed into a host.
 */
export function normaliseOrigin(value: string | string[] | undefined): string | undefined {
  // A header that arrived twice is a request no client of ours makes, and choosing one of the two
  // values is choosing on the attacker's behalf.
  if (typeof value !== 'string') {
    return undefined;
  }

  try {
    const { origin } = new URL(value.trim());

    // `new URL('null')` throws, but a non-special scheme can still serialise its origin as the
    // string `null`, so the answer is checked rather than the input.
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

/**
 * Whether the request's `Origin` is one the API answers unsafe requests for.
 *
 * A missing header is refused, and that is the case worth stating outright: it is the one people
 * forget, and it is trivially produced — a non-browser client simply omits it. Defaulting to allow
 * would leave the pair resting on the token alone, which is precisely the leg a subdomain XSS
 * defeats. Both sides go through {@link normaliseOrigin}, so a configured `https://app.forge.dev/`
 * and a header `https://app.forge.dev` are the same origin rather than a silent mismatch.
 */
export function isAllowedOrigin(
  value: string | string[] | undefined,
  allowed: ReadonlySet<string>,
): boolean {
  const origin = normaliseOrigin(value);

  return origin !== undefined && allowed.has(origin);
}

/** Build the allowlist from configured origins, dropping any entry that is not one. */
export function allowedOriginSet(origins: readonly string[]): ReadonlySet<string> {
  return new Set(
    origins
      .map((origin) => normaliseOrigin(origin))
      .filter((origin): origin is string => origin !== undefined),
  );
}

export function readCsrfHeader(headers: InboundHeaders): string | undefined {
  const value = headers[CSRF_HEADER];

  return typeof value === 'string' ? value : undefined;
}

/**
 * The double submit itself: the cookie the browser sent against the header the page put there.
 *
 * Constant-time through `secretsMatch`, for the reason that module gives — a `===` that returns at
 * the first differing byte turns a search of the whole value into a search of one byte at a time.
 * The length floor is checked first and is not a timing concern: it is a property of what was sent,
 * not of what it was compared against.
 */
export function tokensMatch(cookie: string | undefined, header: string | undefined): boolean {
  if (
    cookie === undefined ||
    header === undefined ||
    cookie.length < CSRF_TOKEN_MIN_LENGTH ||
    header.length < CSRF_TOKEN_MIN_LENGTH
  ) {
    return false;
  }

  return secretsMatch(cookie, header);
}
