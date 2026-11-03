import { type UsageRunListResponse, usageRunListResponseSchema } from '@repo/contracts';
import {
  type InfiniteData,
  type UseInfiniteQueryResult,
  useInfiniteQuery,
} from '@tanstack/react-query';

import { apiRequest } from '@/lib/api/client';

export const USAGE_PAGE_SIZE = 25;

function listUsageRuns(
  orgId: string,
  cursor: string | undefined,
  signal: AbortSignal,
): Promise<UsageRunListResponse> {
  const params = new URLSearchParams({ limit: String(USAGE_PAGE_SIZE) });

  if (cursor !== undefined) params.set('cursor', cursor);

  return apiRequest('GET', `/orgs/${encodeURIComponent(orgId)}/usage/runs?${params.toString()}`, {
    schema: usageRunListResponseSchema,
    signal,
  });
}

/** The caller's own runs in the organisation, newest first, a page at a time ("Load more"). */
export function useUsageRuns(
  orgId: string | undefined,
): UseInfiniteQueryResult<InfiniteData<UsageRunListResponse>, Error> {
  return useInfiniteQuery<
    UsageRunListResponse,
    Error,
    InfiniteData<UsageRunListResponse>,
    readonly unknown[],
    string | undefined
  >({
    enabled: orgId !== undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    initialPageParam: undefined,
    queryFn: ({ pageParam, signal }) => listUsageRuns(orgId ?? '', pageParam, signal),
    queryKey: ['usage-runs', orgId],
  });
}
