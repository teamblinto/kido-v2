import type { Logger } from '@nestjs/common';
import type { OauthProvider } from '@repo/contracts';

import { OauthExchangeError } from './oauth.service';

/**
 * A ceiling on every call an OAuth adapter makes to a provider.
 *
 * `fetch` has no default timeout, so without this a provider that accepts the connection and never
 * answers holds a request handler, a socket and the caller's browser open indefinitely. Ten seconds
 * is far past either provider's p99 and far short of anything a user would wait through.
 */
export const PROVIDER_TIMEOUT_MS = 10_000;

/** Who is calling, for the log line and for the provider name the refusal carries. */
export interface ProviderCall {
  readonly logger: Logger;
  readonly provider: OauthProvider;
}

/**
 * The one place the OAuth adapters touch the network: built-in `fetch` (T22's standing rule — no
 * HTTP client), with a timeout and a single translation of every transport failure into the
 * catalogued `oauth-exchange-failed`.
 *
 * Shared by both adapters rather than written twice, because it is a *policy* rather than a
 * convenience: how long we wait on a third party, what we log when they fail, and how much of their
 * answer is allowed to reach us. Two copies of that is two places for the timeout to be raised in
 * and one for it to be forgotten in.
 *
 * A non-2xx is logged by status and never by body, and the body is never quoted on any arm. A
 * provider's error document is text we did not write, arriving on a path an unauthenticated caller
 * can drive; on the success arm the same document holds an access token or an `id_token`. One log
 * line cannot be written that is safe on both, so neither is written.
 *
 * Google's JWKS fetches are deliberately *not* routed through here — `jose` owns them, with its own
 * timeout and its own cache, and reimplementing that around it would be reimplementing the cache.
 */
export async function fetchProviderJson(
  url: string,
  init: RequestInit,
  call: ProviderCall,
): Promise<unknown> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });

    if (!response.ok) {
      call.logger.warn(`${call.provider} answered ${url} with ${String(response.status)}`);

      throw new OauthExchangeError(call.provider);
    }

    return await response.json();
  } catch (cause) {
    if (cause instanceof OauthExchangeError) {
      throw cause;
    }

    // A DNS failure, a refused connection, the timeout above, or a body that is not JSON. The cause
    // is not attached to the thrown error: it would travel into the problem document's `detail` on
    // any future change that started rendering causes, and a caller does not need our resolver's
    // opinion of a provider's hostname.
    call.logger.warn(`${call.provider} call to ${url} failed before it produced a document`);

    throw new OauthExchangeError(call.provider);
  }
}
