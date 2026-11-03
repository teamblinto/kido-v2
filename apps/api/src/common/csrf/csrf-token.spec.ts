import { describe, expect, it, vi } from 'vitest';

import {
  CSRF_COOKIE_FORBIDDEN_PREFIX,
  CSRF_HEADER,
  CSRF_TOKEN_MIN_LENGTH,
  csrfCookieAttributes,
  isAllowedOrigin,
  isExemptPath,
  isSafeMethod,
  issueCsrfToken,
  normaliseOrigin,
  readCsrfHeader,
  setCsrfCookie,
  tokensMatch,
} from './csrf-token';

const TTL_SECONDS = 1_209_600;
const COOKIE_NAME = 'forge_csrf';

describe('issueCsrfToken', () => {
  it('mints a value long enough to be worth comparing', () => {
    expect(issueCsrfToken().length).toBeGreaterThanOrEqual(CSRF_TOKEN_MIN_LENGTH);
  });

  it('mints a different value every time', () => {
    const minted = new Set(Array.from({ length: 64 }, () => issueCsrfToken()));

    expect(minted.size).toBe(64);
  });

  /** It travels in a `Set-Cookie` and back in a header, so anything needing quoting is a bug. */
  it('is base64url, so it needs no encoding in a cookie or a header', () => {
    expect(issueCsrfToken()).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('csrf cookie attributes', () => {
  /**
   * The asymmetry with the session cookie is the whole mechanism, not an oversight. The client has
   * to read this value to echo it back, so `HttpOnly` here would leave the double-submit with
   * nothing to submit. `session-cookie.ts` keeps the opposite promise, and keeps it alone.
   */
  it('is readable by script — deliberately not HttpOnly', () => {
    expect(csrfCookieAttributes(TTL_SECONDS).httpOnly).toBe(false);
  });

  it('is still Secure, SameSite=Lax and Path=/', () => {
    expect(csrfCookieAttributes(TTL_SECONDS)).toMatchObject({
      path: '/',
      sameSite: 'lax',
      secure: true,
    });
  });

  /**
   * The prefix is not claimed, but everything it would have enforced is written out anyway. A
   * `Domain` here would send the token to every sibling of `app.forge.dev` (§03), which hands the
   * subdomain half of the attack exactly the value the `Origin` check exists to make useless.
   */
  it('carries no Domain attribute at all — not even an undefined one', () => {
    const attributes = csrfCookieAttributes(TTL_SECONDS);

    expect('domain' in attributes).toBe(false);
    expect(Object.keys(attributes)).not.toContain('domain');
  });

  it('converts the TTL from seconds to the milliseconds Express expects', () => {
    expect(csrfCookieAttributes(TTL_SECONDS).maxAge).toBe(TTL_SECONDS * 1_000);
  });
});

describe('setCsrfCookie', () => {
  it('writes the token under the given name with those attributes', () => {
    const response = { cookie: vi.fn() };

    setCsrfCookie(response, COOKIE_NAME, 'a-token', TTL_SECONDS);

    expect(response.cookie).toHaveBeenCalledWith(
      COOKIE_NAME,
      'a-token',
      csrfCookieAttributes(TTL_SECONDS),
    );
  });

  /**
   * The inverse of `assertHostPrefixed`, and it exists for the same reason that one does: the
   * prefix is this codebase's mark of the one cookie nothing may read, and `environment.ts` already
   * refuses a `SESSION_COOKIE_NAME` without it. A `__Host-`-prefixed cookie handed out here would
   * put a script-readable value under that mark, and the next reader of either file would have to
   * check which of the two a `__Host-` name meant.
   */
  it('refuses to write a __Host--prefixed name', () => {
    const response = { cookie: vi.fn() };

    expect(() =>
      setCsrfCookie(response, `${CSRF_COOKIE_FORBIDDEN_PREFIX}forge_csrf`, 'a-token', TTL_SECONDS),
    ).toThrow(TypeError);
    expect(response.cookie).not.toHaveBeenCalled();
  });
});

describe('isSafeMethod', () => {
  it.each(['GET', 'HEAD', 'OPTIONS'])('exempts %s', (method) => {
    expect(isSafeMethod(method)).toBe(true);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('does not exempt %s', (method) => {
    expect(isSafeMethod(method)).toBe(false);
  });

  it('matches the method case-insensitively, as HTTP does not promise a case', () => {
    expect(isSafeMethod('get')).toBe(true);
  });

  /**
   * An allowlist, so a method nobody thought about is refused rather than assumed harmless. `TRACE`
   * is the example: RFC 9110 calls it safe, this API does not serve it, and a list built by
   * excluding the unsafe ones would have let it through on that technicality.
   */
  it.each(['TRACE', 'CONNECT', 'PROPFIND', ''])('refuses the unlisted method %s', (method) => {
    expect(isSafeMethod(method)).toBe(false);
  });
});

describe('isExemptPath', () => {
  const exempt = new Set(['/api/v1/webhooks/stripe']);

  it('exempts a path on the list', () => {
    expect(isExemptPath('/api/v1/webhooks/stripe', exempt)).toBe(true);
  });

  it('ignores the query string, which is not part of the route', () => {
    expect(isExemptPath('/api/v1/webhooks/stripe?attempt=2', exempt)).toBe(true);
  });

  it('treats a trailing slash as the same route Express would route it to', () => {
    expect(isExemptPath('/api/v1/webhooks/stripe/', exempt)).toBe(true);
  });

  /**
   * The requirement that makes this a list rather than a rule. A prefix or pattern match on
   * `/api/v1/webhooks` would exempt every route somebody later mounts underneath it, including one
   * that verifies no signature — and nothing about adding that route would look wrong in review.
   */
  it.each([
    '/api/v1/webhooks/stripe/replay',
    '/api/v1/webhooks/stripe/../../auth/logout',
    '/api/v1/webhooks',
    '/api/v1/webhooks/stripex',
    '/API/V1/WEBHOOKS/STRIPE',
    '/api/v1/webhooks%2Fstripe',
  ])('does not exempt %s', (path) => {
    expect(isExemptPath(path, exempt)).toBe(false);
  });

  it('exempts nothing when the list is empty', () => {
    expect(isExemptPath('/api/v1/webhooks/stripe', new Set())).toBe(false);
  });
});

describe('normaliseOrigin', () => {
  it('reduces a serialised origin to scheme, host and port', () => {
    expect(normaliseOrigin('https://app.forge.dev')).toBe('https://app.forge.dev');
    expect(normaliseOrigin('https://app.forge.dev/')).toBe('https://app.forge.dev');
    expect(normaliseOrigin('http://localhost:5173')).toBe('http://localhost:5173');
  });

  /**
   * `Origin: null` is what a sandboxed iframe, a `data:` document and some cross-origin redirects
   * send. It is a real header with a real value, and the value means "an origin I will not name" —
   * so it has to fail the allowlist rather than be mistaken for a missing header or for a host.
   */
  it.each(['null', '', '   ', 'not-a-url', 'app.forge.dev'])(
    'answers undefined for %s rather than inventing an origin',
    (value) => {
      expect(normaliseOrigin(value)).toBeUndefined();
    },
  );

  it('answers undefined for a header that was not sent', () => {
    expect(normaliseOrigin(undefined)).toBeUndefined();
  });

  /** A header sent twice is ambiguous, and picking one of them is picking for an attacker. */
  it('answers undefined for a header that arrived more than once', () => {
    expect(normaliseOrigin(['https://app.forge.dev', 'https://evil.example'])).toBeUndefined();
  });
});

describe('isAllowedOrigin', () => {
  const allowed = new Set(['https://app.forge.dev']);

  it('allows an origin on the list', () => {
    expect(isAllowedOrigin('https://app.forge.dev', allowed)).toBe(true);
  });

  it.each([
    'https://evil.example',
    'http://app.forge.dev',
    'https://app.forge.dev:8443',
    'https://app.forge.dev.evil.example',
    'https://forge.dev',
    'null',
  ])('refuses %s', (origin) => {
    expect(isAllowedOrigin(origin, allowed)).toBe(false);
  });

  /**
   * The case people forget, and the one that decides whether the whole check is worth having. A
   * request with no `Origin` is trivially produced — an HTML form post sends none in older
   * browsers, and any non-browser client simply omits it — so defaulting to allow would leave the
   * pair resting on the token alone, which is the subdomain-XSS case §03 pairs it against.
   */
  it('refuses a request that sent no Origin at all', () => {
    expect(isAllowedOrigin(undefined, allowed)).toBe(false);
  });

  it('allows nothing when the list is empty', () => {
    expect(isAllowedOrigin('https://app.forge.dev', new Set())).toBe(false);
  });
});

describe('readCsrfHeader', () => {
  it('reads the token the client echoed back', () => {
    expect(readCsrfHeader({ [CSRF_HEADER]: 'a-token' })).toBe('a-token');
  });

  it('answers undefined when the header is absent', () => {
    expect(readCsrfHeader({})).toBeUndefined();
  });

  /** Two values is a client we do not have, and choosing between them is choosing for an attacker. */
  it('answers undefined when the header arrived more than once', () => {
    expect(readCsrfHeader({ [CSRF_HEADER]: ['a-token', 'b-token'] })).toBeUndefined();
  });

  it('is read under the lowercase name Node normalises headers to', () => {
    expect(CSRF_HEADER).toBe(CSRF_HEADER.toLowerCase());
  });
});

describe('tokensMatch', () => {
  it('matches a cookie the client echoed back exactly', () => {
    const token = issueCsrfToken();

    expect(tokensMatch(token, token)).toBe(true);
  });

  it('refuses a stale token the client echoed from an earlier pair', () => {
    expect(tokensMatch(issueCsrfToken(), issueCsrfToken())).toBe(false);
  });

  it('refuses a missing cookie, a missing header, and both missing', () => {
    const token = issueCsrfToken();

    expect(tokensMatch(undefined, token)).toBe(false);
    expect(tokensMatch(token, undefined)).toBe(false);
    expect(tokensMatch(undefined, undefined)).toBe(false);
  });

  /**
   * Two empty strings are equal, and a comparison that only asked whether they were equal would
   * hand a 200 to a client that sent `X-CSRF-Token:` and a blank cookie — which is to say, to
   * anyone. The length floor is what makes "sent nothing twice" a rejection.
   */
  it('refuses two empty values, however equal they are', () => {
    expect(tokensMatch('', '')).toBe(false);
  });

  it('refuses a matched pair that is too short to be a token', () => {
    const short = 'a'.repeat(CSRF_TOKEN_MIN_LENGTH - 1);

    expect(tokensMatch(short, short)).toBe(false);
  });

  it('accepts a matched pair exactly at the floor', () => {
    const atFloor = 'a'.repeat(CSRF_TOKEN_MIN_LENGTH);

    expect(tokensMatch(atFloor, atFloor)).toBe(true);
  });

  /** Compared as bytes, so a token that differs only in its encoding is not the same token. */
  it('refuses values that differ only after the first bytes', () => {
    const token = issueCsrfToken();

    expect(tokensMatch(token, `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`)).toBe(
      false,
    );
  });
});
