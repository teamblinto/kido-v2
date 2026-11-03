import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type { Environment } from '../../../config/environment';
import type { CallbackAttempt, OauthService } from '../services/oauth.service';
import { OauthController } from './oauth.controller';

const APP_URL = 'https://app.forge.test';
const COOKIE_NAME = '__Host-forge_session';
const TOKEN = 'a-session-token-that-belongs-in-a-cookie';

interface Recorded {
  cookies: { attributes: Record<string, unknown>; name: string; value: string }[];
  headers: Record<string, string>;
  redirect: { status: number; url: string } | null;
}

function createResponse(): { recorded: Recorded; response: never } {
  const recorded: Recorded = { cookies: [], headers: {}, redirect: null };
  const response = {
    cookie(name: string, value: string, attributes: Record<string, unknown>) {
      recorded.cookies.push({ attributes, name, value });
    },
    redirect(status: number, url: string) {
      recorded.redirect = { status, url };
    },
    setHeader(name: string, value: string) {
      recorded.headers[name.toLowerCase()] = value;
    },
  };

  return { recorded, response: response as never };
}

function build(oauth: Partial<OauthService>): OauthController {
  const config = {
    get: (key: keyof Environment) =>
      ({ APP_URL, SESSION_COOKIE_NAME: COOKIE_NAME })[key as 'APP_URL' | 'SESSION_COOKIE_NAME'],
  } as unknown as ConfigService<Environment, true>;

  return new OauthController(oauth as OauthService, config);
}

const COMPLETED = {
  session: { token: TOKEN as never, ttlSeconds: 900 },
  userId: '3f1b1f8e-6b1a-4c1e-9d2a-2a5b8f0c1d3e',
};

describe('OauthController', () => {
  describe('GET /auth/oauth/:provider', () => {
    it('redirects to wherever the service says the flow begins', async () => {
      const controller = build({
        begin: () => Promise.resolve({ authorizationUrl: 'https://provider.test/authorize?x=1' }),
      });
      const { recorded, response } = createResponse();

      await controller.start({ provider: 'github' }, response);

      expect(recorded.redirect).toEqual({
        status: 302,
        url: 'https://provider.test/authorize?x=1',
      });
    });

    /**
     * The `Location` this writes carries a live single-use `state`. A shared cache that stored the
     * response would hand one caller's pending flow to the next, who would spend it.
     */
    it('forbids caching the redirect that carries the state', async () => {
      const controller = build({
        begin: () => Promise.resolve({ authorizationUrl: 'https://provider.test/authorize' }),
      });
      const { recorded, response } = createResponse();

      await controller.start({ provider: 'github' }, response);

      expect(recorded.headers['cache-control']).toBe('no-store');
    });

    it('passes the provider from the path through unchanged', async () => {
      const asked: string[] = [];
      const controller = build({
        begin: (provider: 'github' | 'google') => {
          asked.push(provider);

          return Promise.resolve({ authorizationUrl: 'https://provider.test/authorize' });
        },
      });
      const { response } = createResponse();

      await controller.start({ provider: 'google' }, response);

      expect(asked).toEqual(['google']);
    });
  });

  describe('GET /auth/oauth/:provider/callback', () => {
    const callbackController = (seen: CallbackAttempt[]) =>
      build({
        complete: (_provider, attempt: CallbackAttempt) => {
          seen.push(attempt);

          return Promise.resolve(COMPLETED);
        },
      });

    it('writes the session cookie and sends the browser back to the app', async () => {
      const controller = callbackController([]);
      const { recorded, response } = createResponse();

      await controller.callback(
        { provider: 'github' },
        { code: 'the-code', state: 'the-state' },
        { headers: {}, ip: '203.0.113.4' },
        response,
      );

      expect(recorded.cookies).toHaveLength(1);
      expect(recorded.cookies[0]).toMatchObject({ name: COOKIE_NAME, value: TOKEN });
      // 303, not 302: this request had an effect, and `See Other` is what says "fetch the result
      // with GET and do not treat this as a stand-in for the original request".
      expect(recorded.redirect).toEqual({ status: 303, url: APP_URL });
    });

    /**
     * Criterion 3's property on this route: the token is in the cookie and in nothing else. A
     * redirect carrying a session identifier in its URL would put it in the browser's history, in
     * the `Referer` of the next request the app makes, and in every access log in between.
     */
    it('never puts the session token in the redirect', async () => {
      const controller = callbackController([]);
      const { recorded, response } = createResponse();

      await controller.callback(
        { provider: 'github' },
        { code: 'the-code', state: 'the-state' },
        { headers: {} },
        response,
      );

      expect(recorded.redirect?.url).not.toContain(TOKEN);
    });

    /**
     * There is deliberately no `returnTo`. An OAuth callback that redirects to a location derived
     * from anything the caller supplied is an open redirector, and one attached to a sign-in is how
     * a stolen code is exfiltrated — so the destination is `APP_URL` whatever the query says.
     */
    it('ignores any destination the caller tries to supply', async () => {
      const controller = callbackController([]);
      const { recorded, response } = createResponse();

      await controller.callback(
        { provider: 'github' },
        // No cast: the callback query is a loose schema, so these extra members are exactly what a
        // caller can really send — which is what makes the assertion below worth making.
        {
          code: 'the-code',
          redirect_uri: 'https://evil.test',
          returnTo: 'https://evil.test',
          state: 'the-state',
        },
        { headers: {} },
        response,
      );

      expect(recorded.redirect?.url).toBe(APP_URL);
    });

    it('hands the service the code, the state and the provider’s error member', async () => {
      const seen: CallbackAttempt[] = [];
      const { response } = createResponse();

      await callbackController(seen).callback(
        { provider: 'github' },
        { code: 'the-code', error: 'access_denied', state: 'the-state' },
        { headers: {} },
        response,
      );

      expect(seen[0]).toMatchObject({
        code: 'the-code',
        error: 'access_denied',
        state: 'the-state',
      });
    });

    /** Session fixation: whatever the browser arrived holding is handed over to be revoked. */
    it('passes the session the browser arrived with', async () => {
      const seen: CallbackAttempt[] = [];
      const { response } = createResponse();

      await callbackController(seen).callback(
        { provider: 'github' },
        { code: 'the-code', state: 'the-state' },
        { cookies: { [COOKIE_NAME]: 'a-planted-session' }, headers: {} },
        response,
      );

      expect(seen[0]?.currentToken).toBe('a-planted-session');
    });

    it('records the device so the session appears in the device list', async () => {
      const seen: CallbackAttempt[] = [];
      const { response } = createResponse();

      await callbackController(seen).callback(
        { provider: 'github' },
        { code: 'the-code', state: 'the-state' },
        { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh)' }, ip: '203.0.113.4' },
        response,
      );

      expect(seen[0]?.device).toMatchObject({
        ip: '203.0.113.4',
        userAgent: 'Mozilla/5.0 (Macintosh)',
      });
    });

    it('forbids caching the response that completed the exchange', async () => {
      const controller = callbackController([]);
      const { recorded, response } = createResponse();

      await controller.callback(
        { provider: 'github' },
        { code: 'the-code', state: 'the-state' },
        { headers: {} },
        response,
      );

      expect(recorded.headers['cache-control']).toBe('no-store');
    });

    /**
     * A refusal is thrown before the response is touched, which is what lets `ProblemDetailsFilter`
     * render it as an RFC 9457 document even though this handler owns its response. A half-written
     * response here would be a redirect *and* a problem body.
     */
    it('writes nothing at all when the service refuses', async () => {
      const controller = build({
        complete: () => Promise.reject(new Error('refused')),
      });
      const { recorded, response } = createResponse();

      await expect(
        controller.callback(
          { provider: 'github' },
          { code: 'the-code', state: 'replayed' },
          { headers: {} },
          response,
        ),
      ).rejects.toThrow('refused');

      expect(recorded.cookies).toEqual([]);
      expect(recorded.redirect).toBeNull();
    });
  });
});
