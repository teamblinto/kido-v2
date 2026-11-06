import type { RunMessage, RunMessagesResponse } from '@repo/contracts';
import type { InfiniteData } from '@tanstack/react-query';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import { listRunMessages } from '../api';

const PAGE_SIZE = 100;

const NONE: readonly RunMessage[] = [];

/**
 * The project's whole conversation, oldest first. Every page is followed: the chat renders it all,
 * and a partial read would look like messages had gone missing. Under `['runs', org, project]`, so
 * whatever marks the runs stale marks this too.
 */
export function useRunMessages(
  orgId: string | undefined,
  projectId: string | undefined,
): readonly RunMessage[] {
  const query = useInfiniteQuery<
    RunMessagesResponse,
    Error,
    InfiniteData<RunMessagesResponse>,
    readonly unknown[],
    string | undefined
  >({
    enabled: orgId !== undefined && projectId !== undefined && projectId.length > 0,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    initialPageParam: undefined,
    queryFn: ({ pageParam, signal }) =>
      listRunMessages(
        orgId ?? '',
        projectId ?? '',
        { cursor: pageParam, limit: PAGE_SIZE },
        signal,
      ),
    queryKey: ['runs', orgId, projectId, 'messages'],
  });
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = query;

  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  return useMemo(
    () => query.data?.pages.flatMap((page) => page.messages).reverse() ?? NONE,
    [query.data],
  );
}
