import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import type { Environment } from '../../../config/environment';
import { Public } from '../decorators/public.decorator';
import { type DeviceBearingRequest, deviceFingerprintOf } from '../device-fingerprint';
import { OauthCallbackQueryDto, OauthProviderParamsDto } from '../dto/oauth.dto';
import {
  type CookieBearingRequest,
  type CookieWritingResponse,
  readSessionCookie,
  setSessionCookie,
} from '../session-cookie';
import { OauthService } from '../services/oauth.service';

/**
 * The part of the platform request these routes read, declared structurally for the reason
 * `ProblemDetailsFilter` gives: this package depends on `@nestjs/platform-express`, not on
 * `express`, so naming the Express typings here would import something it does not declare.
 */
interface OauthRequest extends CookieBearingRequest {
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
  readonly ip?: string;
}

/** The response members these routes use: a cookie on the way back in, and a redirect on both. */
interface RedirectingResponse extends CookieWritingResponse {
  redirect(status: number, url: string): unknown;
  setHeader(name: string, value: string): unknown;
}

/**
 * Sign in with GitHub or Google (T22, T23 — criterion 9).
 *
 * ## Why both routes are `GET`, and why that is safe
 *
 * They are browser navigations, not API calls. A "Sign in with GitHub" button is an `<a href>`: the
 * response is a cross-origin redirect, and `fetch` cannot follow one to a third party and then be
 * redirected back with credentials. That also means neither route can carry the double-submit CSRF
 * pair T17 requires — `CsrfMiddleware` exempts safe methods, so they pass through it untouched.
 *
 * The `state` is what replaces it, and it is strictly better here than a CSRF token would be: it is
 * minted server-side per flow, stored in Redis, single-use, and bound to the provider it was
 * started for. `OauthService` argues the mechanism at length. The thing worth noticing at this
 * layer is that the callback performs its whole effect — spending the state, exchanging the code,
 * possibly creating an account, establishing a session — on a `GET`, which is not idempotent and
 * would normally be wrong. It is correct here because the resource being fetched is a one-time
 * authorization grant: the second `GET` of the same URL is exactly the replay the single-use state
 * refuses, so the route is not merely safe to repeat, it is *designed* around being repeated.
 *
 * ## Why they stay mounted when the provider is switched off
 *
 * `environment.ts` makes `GITHUB_OAUTH_*` and `GOOGLE_OAUTH_*` optional and both-or-neither, so a
 * deployment can legitimately run with neither provider. The routes are registered regardless and
 * answer `501` with `oauth-provider-not-configured`. Conditionally registering them was the
 * alternative and is worse in the way that matters at three in the morning: a route that is absent
 * from the router answers `404`, and a `404` from a deployment that is missing a route is
 * indistinguishable from a `404` from a deployment whose router failed to build. One is a
 * configuration choice somebody made on purpose and the other is an outage, and an operator should
 * not have to read the environment to tell them apart. A stable, catalogued, self-describing
 * refusal says which it is, in the response.
 *
 * ## `@Res` without `passthrough`
 *
 * Both handlers own their response, because both end in a redirect and one of them writes a cookie
 * on the way. Errors are unaffected: every refusal below is thrown before the response is touched,
 * so `ProblemDetailsFilter` still renders it as an RFC 9457 document — which is what makes the
 * failures here assertable in the same way as every other route's.
 */
@ApiTags('auth')
@Controller({ path: 'auth/oauth', version: '1' })
export class OauthController {
  private readonly appUrl: string;
  private readonly cookieName: string;

  constructor(
    private readonly oauth: OauthService,
    config: ConfigService<Environment, true>,
  ) {
    this.appUrl = config.get('APP_URL', { infer: true });
    this.cookieName = config.get('SESSION_COOKIE_NAME', { infer: true });
  }

  /**
   * `GET /auth/oauth/:provider` — mint a flow and bounce the browser to the provider.
   *
   * `302`, which is what every OAuth client in the world sends here.
   *
   * `Cache-Control: no-store` is not decoration. The `Location` this writes carries the `state` in
   * its query string, and a shared cache that stored this response would hand one user's pending
   * flow to the next caller — the single-use state would then be spent by whoever arrived second.
   * A redirect whose whole value is that it is different every time must say so.
   */
  @Public()
  @Get(':provider')
  @ApiOperation({ summary: 'Begin signing in with an OAuth provider' })
  async start(
    @Param() params: OauthProviderParamsDto,
    @Res() response: RedirectingResponse,
  ): Promise<void> {
    const started = await this.oauth.begin(params.provider);

    response.setHeader('Cache-Control', 'no-store');
    response.redirect(302, started.authorizationUrl);
  }

  /**
   * `GET /auth/oauth/:provider/callback` — spend the state, complete the sign-in, and send the
   * browser back into the app holding a session.
   *
   * `303` rather than `302`, and the distinction is worth the two characters: this request had an
   * effect, and `303 See Other` is the status that says "the result is at this other URI, fetch it
   * with `GET`, and do not treat this response as a stand-in for the original request". `no-store`
   * for the same reason as above and one more — the URL this redirect *came from* holds a live
   * authorization code, and nothing about this exchange should survive in a cache.
   *
   * The session cookie is written here and the token appears nowhere else: not in the `Location`,
   * not in a fragment, not in a body. A redirect that carried a session identifier in its URL would
   * put it in the browser's history, in the referrer of the next request the app makes, and in
   * every access log between here and the user.
   *
   * The destination is `APP_URL` itself. There is deliberately no `returnTo`: an OAuth callback that
   * redirects to a location derived from anything the caller supplied is an open redirector, and an
   * open redirector attached to a sign-in is how a stolen code is exfiltrated. Restoring the page
   * the user started from is the SPA's job, using state it kept on its own origin.
   */
  @Public()
  @Get(':provider/callback')
  @ApiOperation({ summary: 'Complete an OAuth sign-in and establish a session' })
  async callback(
    @Param() params: OauthProviderParamsDto,
    @Query() query: OauthCallbackQueryDto,
    @Req() incoming: OauthRequest,
    @Res() response: RedirectingResponse,
  ): Promise<void> {
    const completed = await this.oauth.complete(params.provider, {
      code: query.code,
      currentToken: readSessionCookie(incoming, this.cookieName),
      device: deviceFingerprintOf(deviceOf(incoming)),
      error: query.error,
      state: query.state,
    });

    setSessionCookie(
      response,
      this.cookieName,
      completed.session.token,
      completed.session.ttlSeconds,
    );

    response.setHeader('Cache-Control', 'no-store');
    response.redirect(303, this.appUrl);
  }
}

/** `User-Agent` can legitimately arrive more than once; the first one is the request's own. */
function deviceOf(incoming: OauthRequest): DeviceBearingRequest {
  const userAgent = incoming.headers?.['user-agent'];

  return {
    ip: incoming.ip,
    userAgent: Array.isArray(userAgent) ? userAgent[0] : userAgent,
  };
}
