import {
  type BeginLinkResponse,
  type CompleteLinkPending,
  type CompleteLinkRequest,
  type LinkedAccount,
  type LinkedAccountList,
  type LlmProvider,
  beginLinkResponseSchema,
  completeLinkPendingSchema,
  linkedAccountListSchema,
  linkedAccountSchema,
} from '@repo/contracts';
import { z } from 'zod';

import { apiRequest } from '@/lib/api/client';

/** Contracts § 1 (spec 032): per person, so no `:orgId`; nothing of the grant ever comes back. */
function path(rest = ''): string {
  return `/me/linked-accounts${rest}`;
}

/** `complete` answers 200 with the account, or 202 while a device flow still waits. */
const completeLinkResponseSchema = z.union([linkedAccountSchema, completeLinkPendingSchema]);

export function listLinkedAccounts(signal?: AbortSignal): Promise<LinkedAccountList> {
  return apiRequest('GET', path(), { schema: linkedAccountListSchema, signal });
}

/** Needs a fresh step-up; a `step-up-required` refusal is the caller's to answer. */
export function beginLink(provider: LlmProvider): Promise<BeginLinkResponse> {
  return apiRequest('POST', path(`/${provider}/begin`), { schema: beginLinkResponseSchema });
}

export function completeLink(
  provider: LlmProvider,
  body: CompleteLinkRequest,
): Promise<CompleteLinkPending | LinkedAccount> {
  return apiRequest('POST', path(`/${provider}/complete`), {
    body,
    schema: completeLinkResponseSchema,
  });
}

export function verifyLinkedAccount(provider: LlmProvider): Promise<LinkedAccount> {
  return apiRequest('POST', path(`/${provider}/verify`), { schema: linkedAccountSchema });
}

export function unlinkAccount(provider: LlmProvider): Promise<void> {
  return apiRequest('DELETE', path(`/${provider}`));
}

export function isPending(
  result: CompleteLinkPending | LinkedAccount,
): result is CompleteLinkPending {
  return 'pending' in result;
}
