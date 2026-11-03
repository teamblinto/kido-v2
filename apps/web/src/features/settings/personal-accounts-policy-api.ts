import { type PersonalAccountsPolicy, personalAccountsPolicySchema } from '@repo/contracts';

import { apiRequest } from '@/lib/api/client';

/** Contracts/byos.md § 2 (spec 032 US7). */
function path(orgId: string): string {
  return `/orgs/${encodeURIComponent(orgId)}/settings/personal-accounts`;
}

export function getPersonalAccountsPolicy(
  orgId: string,
  signal?: AbortSignal,
): Promise<PersonalAccountsPolicy> {
  return apiRequest('GET', path(orgId), { schema: personalAccountsPolicySchema, signal });
}

export function putPersonalAccountsPolicy(
  orgId: string,
  allowed: boolean,
): Promise<PersonalAccountsPolicy> {
  return apiRequest('PUT', path(orgId), {
    body: { allowed },
    schema: personalAccountsPolicySchema,
  });
}
