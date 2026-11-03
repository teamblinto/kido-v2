import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../config/environment';
import { PROBLEM_TYPES } from '../errors/problem-types';
import {
  CSRF_HEADER,
  csrfCookieAttributes,
  issueCsrfToken,
  type CsrfCookieAttributes,
} from './csrf-token';
import { CsrfMiddleware, CsrfRejectedError } from './csrf.middleware';
import { SIGNATURE_VERIFIED_WEBHOOK_PATHS } from './csrf.module';

const COOKIE_NAME = 'forge_csrf';
const ORIGIN = 'https://app.forge.dev';
const TTL_SECONDS = 1_209_600;
const WEBHOOK = '/api/v1/webhooks/stripe';

/** The middleware reads three keys, so a three-key configuration is the whole of what it needs. */
function config(): ConfigService<Environment, true> {
  return new ConfigService({
    CORS_ORIGINS: `${ORIGIN},https://admin.forge.dev`,
    CSRF_COOKIE_NAME: COOKIE_NAME,
    SESSION_TTL_SECONDS: TTL_SECONDS,
  }) as unknown as ConfigService<Environment, true>;
}

interface WrittenCookie {
  readonly attributes: CsrfCookieAttributes;
  readonly name: string;
  readonly value: string;
}

interface Attempt {
  readonly cookie?: string;
  readonly headers?: Record<string, string | string[] | undefined>;
  readonly method?: string;
  readonly path?: string;
}

interface Outcome {
  readonly cookies: WrittenCookie[];
  readonly nexts: number;
  readonly thrown: unknown;
}

function attempt(request: Attempt, exempt: readonly string[] = [WEBHOOK]): Outcome {
  const middleware = new CsrfMiddleware(exempt, config());
  const cookies: WrittenCookie[] = [];
  let nexts = 0;
  let thrown: unknown;

  try {
    middleware.use(
      {
        cookies: request.cookie === undefined ? {} : { [COOKIE_NAME]: request.cookie },
        headers: request.headers ?? {},
        method: request.method ?? 'POST',
        originalUrl: request.path ?? '/api/v1/auth/logout',
      },
      {
        cookie: (name: string, value: string, attributes: CsrfCookieAttributes) => {
          cookies.push({ attributes, name, value });
        },
      },
      () => {
        nexts += 1;
      },
    );
  } catch (error) {
    thrown = error;
  }

  return { cookies, nexts, thrown };
}

/** A request a browser on the app's own origin, holding a pair, would send. */
function valid(overrides: Attempt = {}): Attempt {
  const token = issueCsrfToken();

  return {
    cookie: token,
    headers: { [CSRF_HEADER]: token, origin: ORIGIN },
    method: 'POST',
    ...overrides,
  };
}

describe('CsrfMiddleware', () => {
  describe('a request that presents both halves', () => {
    it('is let through', () => {
      const { nexts, thrown } = attempt(valid());

      expect(thrown).toBeUndefined();
      expect(nexts).toBe(1);
    });

    it('is let through on every unsafe method', () => {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        expect(attempt(valid({ method })).nexts).toBe(1);
      }
    });

    it('does not re-issue the cookie the client already holds', () => {
      expect(attempt(valid()).cookies).toHaveLength(0);
    });
  });

  /**
   * Both, not either. These two cases are the whole reason the check is a pair: a valid token with
   * a foreign `Origin` is the subdomain-XSS path, where script on a sibling of `app.forge.dev` set
   * both halves of a double submit that then agreed with itself; a good `Origin` with no token is
   * the stripped-header path. An implementation that accepted either would pass one of these tests
   * and fail the other, which is why neither is written as a variation of the other.
   */
  describe('a request that presents only one half', () => {
    it('is refused when the token is good but the Origin is foreign', () => {
      const token = issueCsrfToken();
      const { nexts, thrown } = attempt({
        cookie: token,
        headers: { [CSRF_HEADER]: token, origin: 'https://evil.example' },
      });

      expect(thrown).toBeInstanceOf(CsrfRejectedError);
      expect(nexts).toBe(0);
    });

    it('is refused when the Origin is allowed but no token was echoed', () => {
      const { nexts, thrown } = attempt({
        cookie: issueCsrfToken(),
        headers: { origin: ORIGIN },
      });

      expect(thrown).toBeInstanceOf(CsrfRejectedError);
      expect(nexts).toBe(0);
    });
  });

  describe('the Origin check', () => {
    /**
     * The case people forget. A request with no `Origin` at all must not be the request that gets
     * in — it is the cheapest one to produce, since omitting a header takes no origin at all.
     */
    it('refuses a request that sent no Origin', () => {
      const token = issueCsrfToken();
      const { nexts, thrown } = attempt({ cookie: token, headers: { [CSRF_HEADER]: token } });

      expect(thrown).toBeInstanceOf(CsrfRejectedError);
      expect(nexts).toBe(0);
    });

    it('refuses the literal null origin a sandboxed document sends', () => {
      const token = issueCsrfToken();
      const { thrown } = attempt({
        cookie: token,
        headers: { [CSRF_HEADER]: token, origin: 'null' },
      });

      expect(thrown).toBeInstanceOf(CsrfRejectedError);
    });

    it('accepts any origin the deployment configured, not only the first', () => {
      const token = issueCsrfToken();
      const { nexts } = attempt({
        cookie: token,
        headers: { [CSRF_HEADER]: token, origin: 'https://admin.forge.dev' },
      });

      expect(nexts).toBe(1);
    });
  });

  describe('the double-submit token', () => {
    it('refuses a header that echoes a token from an earlier pair', () => {
      const { nexts, thrown } = attempt({
        cookie: issueCsrfToken(),
        headers: { [CSRF_HEADER]: issueCsrfToken(), origin: ORIGIN },
      });

      expect(thrown).toBeInstanceOf(CsrfRejectedError);
      expect(nexts).toBe(0);
    });

    it('refuses a request holding no CSRF cookie at all', () => {
      const { thrown } = attempt({
        headers: { [CSRF_HEADER]: issueCsrfToken(), origin: ORIGIN },
      });

      expect(thrown).toBeInstanceOf(CsrfRejectedError);
    });

    it('refuses a blank cookie echoed by a blank header', () => {
      const { thrown } = attempt({ cookie: '', headers: { [CSRF_HEADER]: '', origin: ORIGIN } });

      expect(thrown).toBeInstanceOf(CsrfRejectedError);
    });

    /**
     * The rejection is also the repair. A client that has never held a pair — a fresh tab whose
     * first API call is a sign-in — would otherwise be stuck: refused for having no token, and
     * given no token by the refusal. Issuing on the way out makes the retry the client already
     * does the one that succeeds.
     */
    it('issues a pair on the very response that refuses the request', () => {
      const { cookies, thrown } = attempt({ headers: { origin: ORIGIN } });

      expect(thrown).toBeInstanceOf(CsrfRejectedError);
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toMatchObject({
        attributes: csrfCookieAttributes(TTL_SECONDS),
        name: COOKIE_NAME,
      });
    });
  });

  describe('the safe-method exemption', () => {
    it.each(['GET', 'HEAD', 'OPTIONS'])('lets %s through with neither half', (method) => {
      const { nexts, thrown } = attempt({ method });

      expect(thrown).toBeUndefined();
      expect(nexts).toBe(1);
    });

    it('gives a caller with no cookie one, so the next unsafe request can pass', () => {
      const { cookies } = attempt({ method: 'GET' });

      expect(cookies).toHaveLength(1);
      expect(cookies[0]?.value.length).toBeGreaterThan(0);
      expect(cookies[0]?.attributes.httpOnly).toBe(false);
    });

    it('leaves a caller that already holds one alone', () => {
      expect(attempt({ cookie: issueCsrfToken(), method: 'GET' }).cookies).toHaveLength(0);
    });

    it('refuses a method that is on no list, rather than assuming it is harmless', () => {
      expect(attempt({ method: 'TRACE' }).thrown).toBeInstanceOf(CsrfRejectedError);
    });
  });

  describe('the webhook exemption', () => {
    it('lets an unsafe request through on a path that is on the list', () => {
      const { nexts, thrown } = attempt({ method: 'POST', path: WEBHOOK });

      expect(thrown).toBeUndefined();
      expect(nexts).toBe(1);
    });

    /** A machine caller has no cookie jar; handing it one is churn on every delivery. */
    it('writes no cookie on an exempt path', () => {
      expect(attempt({ method: 'POST', path: WEBHOOK }).cookies).toHaveLength(0);
    });

    it('exempts the exact path only, never what is mounted beneath it', () => {
      expect(attempt({ method: 'POST', path: `${WEBHOOK}/replay` }).thrown).toBeInstanceOf(
        CsrfRejectedError,
      );
    });

    it('exempts nothing when the list is empty', () => {
      expect(attempt({ method: 'POST', path: WEBHOOK }, []).thrown).toBeInstanceOf(
        CsrfRejectedError,
      );
    });

    it('reads the path before its query string', () => {
      expect(attempt({ method: 'POST', path: `${WEBHOOK}?attempt=2` }).nexts).toBe(1);
    });
  });

  /** Spec 017 R11 / §14.7: the production list's one entry is an exact path, never a prefix. */
  describe('the sandbox callback exemption', () => {
    const CALLBACK = '/api/v1/internal/sandbox-callbacks';

    it('lets the callback through on the production list', () => {
      const { nexts, thrown } = attempt(
        { method: 'POST', path: CALLBACK },
        SIGNATURE_VERIFIED_WEBHOOK_PATHS,
      );

      expect(thrown).toBeUndefined();
      expect(nexts).toBe(1);
    });

    it.each([`${CALLBACK}/replay`, '/api/v1/internal', '/api/v1/internal/sandbox-callbacks-x'])(
      'exempts nothing mounted beside or beneath it (%s)',
      (path) => {
        expect(
          attempt({ method: 'POST', path }, SIGNATURE_VERIFIED_WEBHOOK_PATHS).thrown,
        ).toBeInstanceOf(CsrfRejectedError);
      },
    );
  });

  describe('the rejection', () => {
    it('carries the catalogued slug, and so a 403', () => {
      const error = attempt({}).thrown as CsrfRejectedError;

      expect(error.type).toBe('csrf-check-failed');
      expect(error.status).toBe(PROBLEM_TYPES['csrf-check-failed'].status);
      expect(error.status).toBe(403);
    });

    /**
     * One message for both halves. "Your token was stale" and "your origin is not ours" differ only
     * in information the caller has no use for and an attacker does — it tells them which of the
     * two checks to spend their effort on.
     */
    it('says the same thing whichever half failed', () => {
      const token = issueCsrfToken();
      const staleToken = attempt({
        cookie: token,
        headers: { [CSRF_HEADER]: issueCsrfToken(), origin: ORIGIN },
      }).thrown as CsrfRejectedError;
      const foreignOrigin = attempt({
        cookie: token,
        headers: { [CSRF_HEADER]: token, origin: 'https://evil.example' },
      }).thrown as CsrfRejectedError;

      expect(staleToken.detail).toBe(foreignOrigin.detail);
    });

    it('names neither the token nor the origin it saw', () => {
      const token = issueCsrfToken();
      const error = attempt({
        cookie: token,
        headers: { [CSRF_HEADER]: token, origin: 'https://evil.example' },
      }).thrown as CsrfRejectedError;

      expect(error.detail).not.toContain(token);
      expect(error.detail).not.toContain('evil.example');
    });
  });

  /** Nothing here reaches for the network, a clock or a store: it is a function of the request. */
  it('resolves without awaiting anything', () => {
    const next = vi.fn();
    const middleware = new CsrfMiddleware([], config());

    expect(
      middleware.use(
        { cookies: {}, headers: {}, method: 'GET', originalUrl: '/api/v1' },
        { cookie: vi.fn() },
        next,
      ),
    ).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });
});
