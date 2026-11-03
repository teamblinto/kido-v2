import { joinUrl } from '@repo/utils';
import type { z } from 'zod';

import { env } from '../env';
import { ApiProblem, ApiUnreachableError, readProblem } from './problem';

/** Everything this client calls lives under the API's versioned prefix. */
const API_PREFIX = '/api/v1';

/** `CsrfMiddleware`'s `SAFE_METHODS`, mirrored: these are the methods it does not check. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The header `CsrfMiddleware` reads the double-submit token back from. */
const CSRF_HEADER = 'X-CSRF-Token';

/** The header `TurnstileGuard` reads, on the two routes that carry a challenge. */
export const TURNSTILE_HEADER = 'cf-turnstile-response';

export type HttpMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';

interface RequestOptions<TResult> {
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** Let the request outlive the page — a leave sent on `pagehide` (spec 031, presence). */
  readonly keepalive?: boolean;
  /**
   * The contract schema for the response, or `undefined` for a `204`.
   *
   * Required rather than optional-by-default so that adding a call without one is a deliberate act.
   * The schemas are strict objects, so a server that grew a field fails here — in a test — rather
   * than shipping one nothing reads, and a server that lost one fails at the boundary rather than
   * three components later as an `undefined` nobody can trace back.
   */
  readonly schema?: z.ZodType<TResult>;
  readonly signal?: AbortSignal;
}

/**
 * Read a cookie the browser is willing to show script.
 *
 * Only ever used for the CSRF token, which is the one cookie in this system deliberately not
 * `HttpOnly` — `csrf-token.ts` types that attribute as the literal `false` to say so. The session
 * cookie is unreadable here by design and is never looked for.
 */
function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') {
    return undefined;
  }

  const prefix = `${name}=`;

  for (const entry of document.cookie.split(';')) {
    const trimmed = entry.trim();

    if (trimmed.startsWith(prefix)) {
      const value = decodeURIComponent(trimmed.slice(prefix.length));

      // An empty cookie is not a token. `CsrfMiddleware` makes the same distinction, and treating
      // one as a value is how "sent nothing" becomes "sent a pair that disagrees".
      return value.length === 0 ? undefined : value;
    }
  }

  return undefined;
}

function buildHeaders(method: HttpMethod, options: RequestOptions<unknown>): Headers {
  const headers = new Headers({ Accept: 'application/json' });

  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers.set(name, value);
  }

  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }

  if (!SAFE_METHODS.has(method)) {
    const token = readCookie(env.VITE_CSRF_COOKIE_NAME);

    if (token !== undefined) {
      headers.set(CSRF_HEADER, token);
    }
  }

  return headers;
}

async function send(
  method: HttpMethod,
  path: string,
  options: RequestOptions<unknown>,
): Promise<Response> {
  try {
    return await fetch(joinUrl(env.VITE_API_URL, `${API_PREFIX}${path}`), {
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      // The session travels as `__Host-forge_session` and the app never sees it. Same-origin in
      // development through the Vite proxy and in production through the edge, so this matters only
      // to a deployment that points `VITE_API_URL` at another origin — and costs nothing when it
      // does not.
      credentials: 'include',
      headers: buildHeaders(method, options),
      ...(options.keepalive === true ? { keepalive: true } : {}),
      method,
      signal: options.signal,
    });
  } catch (cause) {
    // An abort is the caller's own doing — React Query cancelling a superseded query — and must
    // not be dressed up as the service being unreachable.
    //
    // Asked of the signal rather than of the error. What `fetch` rejects with is a `DOMException`
    // in a browser, an `AbortError` from undici under Node, and neither reliably satisfies
    // `instanceof DOMException` when the class comes from another realm — which is exactly the
    // case under jsdom. The signal is the same object the caller passed in, so it answers the
    // question without depending on whose `DOMException` this is.
    if (options.signal?.aborted === true) {
      throw cause;
    }

    throw new ApiUnreachableError(cause);
  }
}

/**
 * Call the API, and either return a validated body or throw an {@link ApiProblem}.
 *
 * ## The one retry
 *
 * `CsrfMiddleware` issues a token on the very response that refuses a caller who had none: *"the
 * repair has to travel with the rejection, or the only way to obtain a token is to already have
 * one."* Taking it up is the client's half of that bargain, so a `csrf-check-failed` is retried
 * once after re-reading the cookie.
 *
 * It fires rarely, because the first call the app makes is the safe `GET /auth/me`, which mints
 * the pair before any form exists to submit. It is kept for the case that remains: a tab left open
 * past the cookie's lifetime, whose next click would otherwise fail with a message naming a token
 * the user has never heard of and cannot obtain.
 *
 * Bounded to one attempt and to that one slug, deliberately. A general retry would resend a
 * mutation that had already been applied, and `Idempotency-Key` is not on these routes.
 */
export async function apiRequest<TResult>(
  method: HttpMethod,
  path: string,
  options: RequestOptions<TResult> & { readonly schema: z.ZodType<TResult> },
): Promise<TResult>;
export async function apiRequest(
  method: HttpMethod,
  path: string,
  options?: RequestOptions<never> & { readonly schema?: undefined },
): Promise<void>;
export async function apiRequest<TResult>(
  method: HttpMethod,
  path: string,
  options: RequestOptions<TResult> = {},
): Promise<TResult | undefined> {
  let response = await send(method, path, options);

  if (response.status === 403) {
    const problem = await readProblem(response);
    const failure = new ApiProblem(response.status, problem);

    if (failure.slug !== 'csrf-check-failed') {
      throw failure;
    }

    response = await send(method, path, options);
  }

  if (!response.ok) {
    throw new ApiProblem(response.status, await readProblem(response));
  }

  if (options.schema === undefined) {
    return undefined;
  }

  return options.schema.parse(await response.json());
}
