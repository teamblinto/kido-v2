import type { Logger } from '@nestjs/common';

import { providerFetch } from './providers/provider-fetch';

/**
 * How a GitHub failure is re-stated to the rest of the module (R11, FR-012): a category derived
 * from the status alone, never from the body. `not-configured` is the one arm that never reached
 * the network — the App env is absent.
 */
export type GithubErrorCategory =
  | 'conflict'
  | 'not-configured'
  | 'not-found'
  | 'rate-limited'
  | 'unauthorized'
  | 'unavailable'
  | 'validation';

export class GithubApiError extends Error {
  constructor(
    readonly category: GithubErrorCategory,
    readonly status?: number,
  ) {
    super(`GitHub: ${category}`);
    this.name = 'GithubApiError';
  }
}

/**
 * The ceiling on every call to GitHub — `provider-fetch.ts`'s policy (spec 017 T22): built-in
 * `fetch`, no default timeout there, ten seconds here.
 */
export const GITHUB_TIMEOUT_MS = 10_000;

export function categoryOf(status: number): GithubErrorCategory {
  switch (status) {
    case 401:
    case 403:
      return 'unauthorized';
    case 404:
      return 'not-found';
    case 409:
      return 'conflict';
    case 422:
      return 'validation';
    case 429:
      return 'rate-limited';
    default:
      return 'unavailable';
  }
}

export interface GithubCall {
  readonly logger: Logger;
  readonly timeoutMs?: number;
}

/**
 * The one place the connector touches GitHub. A non-2xx is logged by status and never by body;
 * the body is not read on that arm at all — it is a document we did not write, and the success
 * arm's twin carries an installation token. Transport failures (DNS, refused, the timeout, a body
 * that is not JSON) are `unavailable`, cause not attached: it would travel into a problem
 * document's `detail` on the first change that rendered causes.
 *
 * Returns `undefined` for a 204.
 */
export async function githubFetch(
  url: string,
  init: RequestInit,
  call: GithubCall,
): Promise<unknown> {
  const response = await providerFetch(url, init, {
    timeoutMs: call.timeoutMs ?? GITHUB_TIMEOUT_MS,
  });

  switch (response.kind) {
    case 'unreachable':
      call.logger.warn(`GitHub call ${init.method ?? 'GET'} ${url} failed before it answered`);

      throw new GithubApiError('unavailable');
    case 'status':
      call.logger.warn(
        `GitHub answered ${init.method ?? 'GET'} ${url} with ${String(response.status)}`,
      );

      throw new GithubApiError(categoryOf(response.status), response.status);
    case 'unparseable':
      call.logger.warn(
        `GitHub answered ${init.method ?? 'GET'} ${url} with a body that is not JSON`,
      );

      throw new GithubApiError('unavailable', response.status);
    case 'ok':
      return response.body;
  }
}
