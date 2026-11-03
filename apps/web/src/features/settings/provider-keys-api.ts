import {
  type LlmProvider,
  type ProviderKey,
  type ProviderKeyList,
  providerKeyListSchema,
  providerKeySchema,
} from '@repo/contracts';

import { apiRequest } from '@/lib/api/client';

/** Contracts § 1 (spec 020): the key travels up once, in `PUT`; only its derivatives come back. */
function path(orgId: string, rest = ''): string {
  return `/orgs/${encodeURIComponent(orgId)}/provider-keys${rest}`;
}

export function listProviderKeys(orgId: string, signal?: AbortSignal): Promise<ProviderKeyList> {
  return apiRequest('GET', path(orgId), { schema: providerKeyListSchema, signal });
}

export function putProviderKey(
  orgId: string,
  provider: LlmProvider,
  apiKey: string,
): Promise<ProviderKey> {
  return apiRequest('PUT', path(orgId, `/${provider}`), {
    body: { apiKey },
    schema: providerKeySchema,
  });
}

export function removeProviderKey(orgId: string, provider: LlmProvider): Promise<void> {
  return apiRequest('DELETE', path(orgId, `/${provider}`));
}

export function verifyProviderKey(orgId: string, provider: LlmProvider): Promise<ProviderKey> {
  return apiRequest('POST', path(orgId, `/${provider}/verify`), { schema: providerKeySchema });
}
