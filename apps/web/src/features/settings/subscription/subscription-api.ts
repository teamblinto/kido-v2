import {
  type SubscriptionList,
  type SubscriptionStatus,
  subscriptionCodeRequestSchema,
  subscriptionListSchema,
  subscriptionSignInUrlSchema,
  subscriptionStatusSchema,
} from '@repo/contracts';
import { type UseQueryResult, useQuery } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api/client';

/** Spec 041: per person, so no `:orgId`. */
const PATH = '/me/subscriptions';

export const SUBSCRIPTIONS_QUERY_KEY = ['subscriptions'] as const;

const TRANSITIONAL: ReadonlySet<SubscriptionStatus['state']> = new Set([
  'awaiting-sign-in',
  'provisioning',
  'starting',
  'verifying',
]);

export function isTransitional(state: SubscriptionStatus['state']): boolean {
  return TRANSITIONAL.has(state);
}

/**
 * Quick while something is moving, slow otherwise. React Query pauses the interval in a hidden
 * tab (`refetchIntervalInBackground` is off by default).
 */
export function useSubscriptions(): UseQueryResult<SubscriptionList> {
  return useQuery({
    queryFn: ({ signal }) => apiRequest('GET', PATH, { schema: subscriptionListSchema, signal }),
    queryKey: SUBSCRIPTIONS_QUERY_KEY,
    refetchInterval: (query) => {
      const state = query.state.data?.claude.state;

      return state !== undefined && isTransitional(state) ? 2_000 : 30_000;
    },
  });
}

/** `202`: provisions or starts the private workspace and begins sign-in. */
export function connectSubscription(): Promise<SubscriptionStatus> {
  return apiRequest('POST', `${PATH}/claude/connect`, { schema: subscriptionStatusSchema });
}

/** `202`, no body. The code only ever travels in this body. */
export function submitSubscriptionCode(code: string): Promise<void> {
  return apiRequest('POST', `${PATH}/claude/code`, {
    body: subscriptionCodeRequestSchema.parse({ code }),
  });
}

export function cancelSubscriptionSignIn(): Promise<void> {
  return apiRequest('POST', `${PATH}/claude/cancel`);
}

export function disconnectSubscription(): Promise<void> {
  return apiRequest('DELETE', `${PATH}/claude`);
}

/** Only Anthropic's own sign-in pages are ever linked to; the server checks the same rule. */
export function isClaudeSignInUrl(url: string): boolean {
  return subscriptionSignInUrlSchema.safeParse(url).success;
}
