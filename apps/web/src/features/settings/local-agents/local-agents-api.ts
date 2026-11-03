import {
  type LocalAgentDeviceList,
  type PairingPreview,
  approvePairingRequestSchema,
  localAgentDeviceListSchema,
  pairingPreviewSchema,
} from '@repo/contracts';
import { type UseQueryResult, useQuery } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api/client';

/** Spec 040 § 5: per person, so no `:orgId`. */
function path(rest = ''): string {
  return `/me/local-agents${rest}`;
}

export const LOCAL_AGENTS_QUERY_KEY = ['local-agents'] as const;

/** Presence moves on a 15 s heartbeat (spec 040 § 5), so the list follows it at the same pace. */
const REFRESH_MS = 15_000;

export function listLocalAgents(signal?: AbortSignal): Promise<LocalAgentDeviceList> {
  return apiRequest('GET', path(), { schema: localAgentDeviceListSchema, signal });
}

/**
 * The person's paired computers, refreshed while the tab is visible — React Query pauses an
 * interval in a background tab by default.
 */
export function useLocalAgents(enabled = true): UseQueryResult<LocalAgentDeviceList> {
  return useQuery({
    enabled,
    queryFn: ({ signal }) => listLocalAgents(signal),
    queryKey: LOCAL_AGENTS_QUERY_KEY,
    refetchInterval: REFRESH_MS,
  });
}

/** Needs a fresh step-up; a `step-up-required` refusal is the caller's to answer. */
export function revokeLocalAgent(deviceId: string): Promise<void> {
  return apiRequest('DELETE', path(`/${encodeURIComponent(deviceId)}`));
}

export function getPairingPreview(userCode: string, signal?: AbortSignal): Promise<PairingPreview> {
  return apiRequest('GET', path(`/pairings/${encodeURIComponent(userCode)}`), {
    schema: pairingPreviewSchema,
    signal,
  });
}

/** Needs a fresh step-up, like revoking. */
export function approvePairing(userCode: string): Promise<void> {
  return apiRequest('POST', path('/pairings/approve'), {
    body: approvePairingRequestSchema.parse({ userCode }),
  });
}

export function denyPairing(userCode: string): Promise<void> {
  return apiRequest('POST', path('/pairings/deny'), {
    body: approvePairingRequestSchema.parse({ userCode }),
  });
}
