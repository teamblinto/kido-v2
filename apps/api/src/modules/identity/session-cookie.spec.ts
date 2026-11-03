import { describe, expect, it, vi } from 'vitest';

import { validateEnvironment } from '../../config/environment';

import {
  clearSessionCookie,
  readSessionCookie,
  sessionCookieAttributes,
  setSessionCookie,
  SESSION_COOKIE_PREFIX,
} from './session-cookie';

const TTL_SECONDS = 1_209_600;
const COOKIE_NAME = '__Host-forge_session';
const TOKEN = 'RUv0m4Bx0d1Wl6vN3cQeSg9pYkT2sZaHc1oJqXrLtUw';

describe('session cookie attributes', () => {
  it('is Secure, HttpOnly, SameSite=Lax and Path=/', () => {
    expect(sessionCookieAttributes(TTL_SECONDS)).toMatchObject({
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      secure: true,
    });
  });

  /**
   * The absence is the assertion. A test that only checks the attributes that are present passes
   * unchanged on a cookie that has been scoped to `.forge.dev` — which is exactly the break §11
   * cares about, because a cookie with a `Domain` is sent to every sibling subdomain, including
   * ones a tenant controls. `in` rather than a truthiness check: `domain: undefined` is still a
   * key somebody added, and the next edit gives it a value.
   */
  it('carries no Domain attribute at all — not even an undefined one', () => {
    const attributes = sessionCookieAttributes(TTL_SECONDS);

    expect('domain' in attributes).toBe(false);
    expect(Object.keys(attributes)).not.toContain('domain');
  });

  /** Express takes `maxAge` in milliseconds; a seconds value here expires the cookie in a fortnight
   * of milliseconds, which is 20 minutes. */
  it('converts the TTL from seconds to the milliseconds Express expects', () => {
    expect(sessionCookieAttributes(TTL_SECONDS).maxAge).toBe(TTL_SECONDS * 1_000);
  });
});

describe('setSessionCookie', () => {
  it('writes the token under the given name with those attributes', () => {
    const response = { cookie: vi.fn() };

    setSessionCookie(response, COOKIE_NAME, TOKEN, TTL_SECONDS);

    expect(response.cookie).toHaveBeenCalledWith(
      COOKIE_NAME,
      TOKEN,
      sessionCookieAttributes(TTL_SECONDS),
    );
  });

  /**
   * The prefix is enforced at the boundary too, not only by the environment schema: a caller that
   * builds a name from a string has to fail here rather than ship a cookie the browser will accept
   * without any of the guarantees the prefix buys.
   */
  it('refuses a name that is not __Host--prefixed', () => {
    const response = { cookie: vi.fn() };

    expect(() => setSessionCookie(response, 'forge_session', TOKEN, TTL_SECONDS)).toThrow(
      SESSION_COOKIE_PREFIX,
    );
    expect(response.cookie).not.toHaveBeenCalled();
  });
});

describe('readSessionCookie', () => {
  it('returns the value cookie-parser put on the request', () => {
    expect(readSessionCookie({ cookies: { [COOKIE_NAME]: TOKEN } }, COOKIE_NAME)).toBe(TOKEN);
  });

  it('returns undefined when the request carries no cookie of that name', () => {
    expect(readSessionCookie({ cookies: { theme: 'dark' } }, COOKIE_NAME)).toBeUndefined();
  });

  /** A request that never went through `cookie-parser` has no `cookies` at all. */
  it('returns undefined when nothing parsed the cookie header', () => {
    expect(readSessionCookie({}, COOKIE_NAME)).toBeUndefined();
  });

  /** An empty cookie is not a token, and treating it as one turns a 401 into a Redis lookup. */
  it('treats an empty value as absent', () => {
    expect(readSessionCookie({ cookies: { [COOKIE_NAME]: '' } }, COOKIE_NAME)).toBeUndefined();
  });
});

describe('clearSessionCookie', () => {
  /**
   * A browser matches the cookie to delete on name, path and domain — not on the value. Clearing
   * it with anything less than the attributes it was written with leaves the original in place and
   * adds a second one beside it, and the user stays signed in with a page that says they are not.
   */
  it('clears it with the attributes it was written with', () => {
    const response = { clearCookie: vi.fn(), cookie: vi.fn() };

    clearSessionCookie(response, COOKIE_NAME);

    expect(response.clearCookie).toHaveBeenCalledWith(COOKIE_NAME, {
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      secure: true,
    });
  });

  it('refuses a name that is not __Host--prefixed, exactly as writing one does', () => {
    const response = { clearCookie: vi.fn(), cookie: vi.fn() };

    expect(() => clearSessionCookie(response, 'forge_session')).toThrow(
      new RegExp(SESSION_COOKIE_PREFIX),
    );
    expect(response.clearCookie).not.toHaveBeenCalled();
  });
});

/**
 * Spec 027 T069 (SC-007, first half): a deployed site's script can neither read nor set the
 * product's session cookie. Two things make that so, and both are asserted here: the cookie is
 * `__Host-` with no `Domain`, so it is host-only to the product origin and no other host can
 * shadow it; and the site domain may not equal, sit under or sit above the product host, so a
 * site is never same-site with the host that cookie belongs to. Whether browsers treat the site
 * domain as its own registrable domain (the PSL half) is not testable here and is recorded in T105.
 */
describe('a deployed site is cross-origin to the product session cookie (027 T069)', () => {
  const APP_URL = 'https://app.forge.example';

  function environment(overrides: Record<string, string> = {}) {
    return validateEnvironment({
      APP_URL,
      DATABASE_MIGRATION_URL: 'postgres://forge_migrator:dev@localhost:5432/forge',
      DATABASE_URL: 'postgres://forge_app:dev@localhost:5432/forge',
      DATABASE_URL_BYPASS_RLS: 'postgres://forge_bypass:dev@localhost:5432/forge',
      DEPLOY_ENV: 'local',
      GITHUB_WEBHOOK_SECRET: 'not-the-published-example',
      KEK_ENV_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
      NODE_ENV: 'test',
      REDIS_CACHE_URL: 'redis://localhost:6380',
      REDIS_QUEUE_URL: 'redis://localhost:6381',
      REDIS_SESSION_URL: 'redis://localhost:6379',
      REDIS_STREAM_URL: 'redis://localhost:6382',
      RUN_PROFILES: 'api',
      ...overrides,
    });
  }

  it('writes the configured session cookie as __Host- with no Domain', () => {
    const { SESSION_COOKIE_NAME, SITE_DOMAIN } = environment({
      SITE_DOMAIN: 'forge-sites.example',
    });
    const response = { cookie: vi.fn() };

    setSessionCookie(response, SESSION_COOKIE_NAME, TOKEN, TTL_SECONDS);

    expect(SITE_DOMAIN).toBe('forge-sites.example');
    const [name, , attributes] = response.cookie.mock.calls[0] as [string, string, object];
    expect(name.startsWith('__Host-')).toBe(true);
    expect('domain' in attributes).toBe(false);
    expect(attributes).toMatchObject({ path: '/', secure: true });
  });

  it('refuses a session cookie name without the __Host- prefix', () => {
    expect(() => environment({ SESSION_COOKIE_NAME: 'forge_session' })).toThrow(
      /SESSION_COOKIE_NAME/,
    );
  });

  it.each([
    ['equal to the product host', 'app.forge.example'],
    ['under the product host', 'sites.app.forge.example'],
    ['above the product host', 'forge.example'],
    ['differing only in case', 'App.Forge.Example'],
  ])('refuses a site domain %s', (_name, site) => {
    expect(() => environment({ SITE_DOMAIN: site })).toThrow(/APP_URL[^\n]*\n\s*→ at SITE_DOMAIN/);
  });

  it('accepts a sibling of the product host: cross-origin, and __Host- keeps the cookie host-only', () => {
    expect(environment({ SITE_DOMAIN: 'xapp.forge.example' }).SITE_DOMAIN).toBe(
      'xapp.forge.example',
    );
  });
});
