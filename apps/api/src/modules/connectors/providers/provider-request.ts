import type { z } from 'zod';

import { type Plaintext, revealPlaintext } from '../../../common/crypto/branded';
import { failureFromStatus, ProviderFailure, retryAfterHeader } from './provider';
import { providerFetch, type ProviderFetchOptions, type ProviderResponse } from './provider-fetch';

export interface ProviderRequest {
  readonly body?: unknown;
  readonly method?: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';
}

/**
 * One authenticated JSON call to a spec 030 provider (research R4): the bearer, the body as JSON,
 * the answer parsed by `schema`, and a non-2xx thrown as a {@link ProviderFailure} by R5's common
 * table — or by `classify`, when a provider's status alone does not say (Resend).
 */
export async function providerJson<T>(
  url: string,
  credential: Plaintext,
  schema: z.ZodType<T>,
  request: ProviderRequest = {},
  options: ProviderFetchOptions & {
    readonly classify?: (response: ProviderResponse & { kind: 'status' }) => ProviderFailure;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${revealPlaintext(credential).toString('utf8')}`,
  };
  if (request.body !== undefined) headers['content-type'] = 'application/json';

  const response = await providerFetch(
    url,
    {
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      headers,
      method: request.method ?? 'GET',
    },
    options,
  );

  switch (response.kind) {
    case 'unreachable':
    case 'unparseable':
      throw new ProviderFailure('unavailable');
    case 'status':
      throw (
        options.classify?.(response) ??
        failureFromStatus(response.status, retryAfterHeader(response.headers))
      );
    case 'ok': {
      const parsed = schema.safeParse(response.body);
      // A 2xx this version does not understand: nothing usable answered.
      if (!parsed.success) throw new ProviderFailure('unavailable');
      return parsed.data;
    }
  }
}

/** `base` without trailing slashes, joined to `path`. */
export function endpoint(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}
