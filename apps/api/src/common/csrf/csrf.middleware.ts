import type { NestMiddleware } from '@nestjs/common';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { type Environment, parseCorsOrigins } from '../../config/environment';
import { DomainError } from '../errors/domain-error';
import {
  type CsrfCookieWritingResponse,
  type InboundHeaders,
  allowedOriginSet,
  isAllowedOrigin,
  isDeviceTokenPath,
  isExemptPath,
  isSafeMethod,
  issueCsrfToken,
  readCsrfHeader,
  setCsrfCookie,
  tokensMatch,
} from './csrf-token';

/**
 * The DI token the exemption list arrives under.
 *
 * A provided value rather than a constant this module reads directly, so that "which paths are
 * exempt" is a question answered in one place — `CsrfModule` — and so the e2e suite can mount a
 * route on the list and prove the exemption is honoured through the real HTTP pipeline rather than
 * asserting it against a description of itself.
 */
export const CSRF_EXEMPT_PATHS = Symbol('forge.csrf.exemptPaths');

/** Spec 040: the companion's device-token routes, anchored patterns (`DEVICE_TOKEN_PATHS`). */
export const CSRF_DEVICE_TOKEN_PATHS = Symbol('forge.csrf.deviceTokenPaths');

/**
 * One message for both halves of the check, and no mention of what was presented.
 *
 * Telling a caller *which* leg it failed tells an attacker which one to spend their effort on, and
 * the client's remedy is the same either way: re-read the cookie, echo it, and send the request
 * from the app's own origin. `SessionGuard` collapses its two failures for the same reason.
 */
const REJECTION =
  'This request requires a valid CSRF token and an allowed Origin. Read the CSRF cookie, send it back in the X-CSRF-Token header, and retry from the application origin.';

/** Criterion 15's refusal, carrying the catalogued slug rather than a bare status. */
export class CsrfRejectedError extends DomainError {
  constructor() {
    super('csrf-check-failed', REJECTION);
  }
}

/**
 * The part of the platform request this middleware reads, declared structurally for the reason
 * `ProblemDetailsFilter` gives: `@repo/api` depends on `@nestjs/platform-express`, not on
 * `express`, and naming the Express typings here would import something the package does not
 * declare.
 *
 * `cookies` is populated by the `cookie-parser` that `bootstrap.ts` installs; middleware configured
 * through a module runs after everything `configureApplication` registered with `app.use`, which is
 * what makes that ordering hold without either file asserting it about the other.
 */
export interface CsrfBearingRequest {
  readonly cookies?: Readonly<Record<string, string | undefined>>;
  readonly headers?: InboundHeaders;
  readonly method: string;
  /** Express's pre-routing path, so a mounted router cannot shorten what the allowlist sees. */
  readonly originalUrl?: string;
  readonly url?: string;
}

/**
 * §03's "unsafe methods require both an `Origin` check and a double-submit CSRF token", as the one
 * piece of middleware every unsafe request passes through.
 *
 * Middleware rather than a guard, and deliberately: a guard runs per route and applies to the
 * routes that remembered to ask for it, whereas this has to be true of every unsafe request
 * including the ones nobody has written yet. It also runs before `SessionGuard`, so a forged
 * cross-site request is refused without a Redis lookup and without the answer depending on whether
 * the victim happened to be signed in.
 *
 * Both checks are required and neither is a fallback for the other. A token alone is defeated by
 * script on a sibling of `app.forge.dev`, which can write the cookie *and* set the header, so the
 * double submit agrees with itself. An `Origin` alone is defeated by a request that simply does not
 * send one. The two failure modes have nothing in common, which is why the conjunction is written
 * out rather than expressed as a single "is this request trustworthy" predicate.
 */
@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly cookieName: string;
  private readonly exemptPaths: ReadonlySet<string>;
  private readonly ttlSeconds: number;

  constructor(
    @Inject(CSRF_EXEMPT_PATHS) exemptPaths: readonly string[],
    config: ConfigService<Environment, true>,
    @Optional()
    @Inject(CSRF_DEVICE_TOKEN_PATHS)
    private readonly deviceTokenPaths: readonly RegExp[] = [],
  ) {
    // The same list CORS is configured from, on purpose. Two lists of "origins this API answers
    // for" would be two lists to update, and the CSRF one is the one nobody would remember —
    // failing shut on a legitimate origin, or open on a retired one, long after the change.
    this.allowedOrigins = allowedOriginSet(
      parseCorsOrigins(config.get('CORS_ORIGINS', { infer: true })),
    );
    this.cookieName = config.get('CSRF_COOKIE_NAME', { infer: true });
    this.exemptPaths = new Set(exemptPaths);
    // The pair outlives nothing and is useful for exactly as long as a session might be, so it is
    // given the session's lifetime. A shorter one would 403 a tab left open overnight; a longer one
    // would leave a value in the jar that no session can be paired with.
    this.ttlSeconds = config.get('SESSION_TTL_SECONDS', { infer: true });
  }

  use(
    request: CsrfBearingRequest,
    response: CsrfCookieWritingResponse,
    next: (error?: unknown) => void,
  ): void {
    // First, and before any cookie is written: a signature-verified webhook is a machine caller
    // with no cookie jar to keep, and §03's exemption is for the whole request rather than for its
    // token half.
    const path = request.originalUrl ?? request.url ?? '/';

    if (isExemptPath(path, this.exemptPaths) || isDeviceTokenPath(path, this.deviceTokenPaths)) {
      next();

      return;
    }

    const headers = request.headers ?? {};
    const cookie = readCsrfCookie(request, this.cookieName);

    // Issued whenever the caller has none, including on the response that is about to refuse them.
    // A client whose first API call is a sign-in has never held a pair, and a refusal that handed
    // back no token would leave it refused forever — the repair has to travel with the rejection,
    // or the only way to obtain a token is to already have one.
    if (cookie === undefined) {
      setCsrfCookie(response, this.cookieName, issueCsrfToken(), this.ttlSeconds);
    }

    if (isSafeMethod(request.method)) {
      next();

      return;
    }

    // Evaluated before the branch rather than inside it, so neither check can be skipped by the
    // other having already failed: this is a conjunction, and it should read as one.
    const originAllowed = isAllowedOrigin(headers.origin, this.allowedOrigins);
    const tokenMatched = tokensMatch(cookie, readCsrfHeader(headers));

    if (!originAllowed || !tokenMatched) {
      throw new CsrfRejectedError();
    }

    next();
  }
}

/** An empty cookie is not a token; treating it as one is how "sent nothing" becomes "sent a pair". */
function readCsrfCookie(request: CsrfBearingRequest, name: string): string | undefined {
  const value = request.cookies?.[name];

  return value === undefined || value.length === 0 ? undefined : value;
}
