import type { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { Module, RequestMethod } from '@nestjs/common';

import { CSRF_DEVICE_TOKEN_PATHS, CSRF_EXEMPT_PATHS, CsrfMiddleware } from './csrf.middleware';
import { INBOUND_PATHS } from './inbound-paths';

/**
 * The paths exempt from the CSRF check because they authenticate a request some other way, listed
 * one at a time.
 *
 * §03 exempts a path because a signature already proves who sent it. What matters is the shape — an
 * entry here is a decision somebody wrote down and a reviewer can see, which is what a prefix or a
 * pattern would not be (§14.7). A rule like "anything under `/internal`" exempts the handler that
 * forgets to verify its signature, and nothing about adding that handler looks wrong.
 *
 * The first entry: the sandbox callback (spec 017 R11). Its caller is a process holding an EdDSA
 * token, not a browser with a cookie; `SandboxCallbackGuard` verifies the signature and re-reads
 * the sandbox row on every call. The exact path, so a sibling mounted beneath it is not exempt.
 *
 * The second, and the second ever: GitHub's inbound webhook (spec 026 R9). Its caller is GitHub,
 * which has no session and no cookie to present; `GithubWebhookGuard` verifies `X-Hub-Signature-256`
 * over the raw request bytes before anything parses them. Exact again — `/api/v1/webhooks/github`
 * and nothing beneath it. A prefix here would exempt `/api/v1/webhooks/github/anything`, including
 * the handler somebody mounts there next year and forgets to put a guard on, and nothing about
 * adding that handler would look wrong. Spec 029 moves it into `INBOUND_PATHS`, the list the hooks
 * origin serves, so the two cannot drift.
 */
export const SIGNATURE_VERIFIED_WEBHOOK_PATHS: readonly string[] = Object.freeze([
  '/api/v1/internal/sandbox-callbacks',
  ...INBOUND_PATHS,
]);

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * Spec 040 § 5: the runner's unsafe routes. Its caller is the hosted runner in a person's agent
 * home (spec 041), holding a `bld_` device token in `Authorization` — never a cookie, so there is
 * no ambient credential for a forged cross-site request to ride. `DeviceTokenGuard` checks the
 * token on every call. A separate list from the webhook one because the events route names its
 * run: each entry is anchored and its one variable segment is a uuid, so nothing mounted beside or
 * beneath these is exempt.
 */
export const DEVICE_TOKEN_PATHS: readonly RegExp[] = Object.freeze([
  /^\/api\/v1\/local-agent\/status$/,
  // Spec 041: an agent home's runner reporting its sign-in URL and result.
  /^\/api\/v1\/local-agent\/auth$/,
  new RegExp(`^/api/v1/local-agent/runs/${UUID}/events$`),
]);

/**
 * Criterion 15's middleware, applied to everything.
 *
 * `forRoutes` takes a catch-all rather than a route list for the reason `SessionGuard` is an
 * `APP_GUARD`: protection a route opts into is protection some route will not opt into, and that
 * route looks exactly like its neighbours. The exemptions are then subtractions from "everything",
 * which is a list somebody has to add to deliberately.
 *
 * The path is a *named* wildcard because Express 5 — and the path-to-regexp behind it — no longer
 * accepts a bare `*`. A stale `'*'` here does not degrade to matching less; it throws at boot,
 * which is the failure worth having.
 */
@Module({
  providers: [
    CsrfMiddleware,
    { provide: CSRF_EXEMPT_PATHS, useValue: SIGNATURE_VERIFIED_WEBHOOK_PATHS },
    { provide: CSRF_DEVICE_TOKEN_PATHS, useValue: DEVICE_TOKEN_PATHS },
  ],
})
export class CsrfModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CsrfMiddleware).forRoutes({ method: RequestMethod.ALL, path: '*splat' });
  }
}
