import type { RunListResponse, RunResponse } from '@repo/contracts';
import type { InfiniteData } from '@tanstack/react-query';
import { useInfiniteQuery } from '@tanstack/react-query';

import { listRuns } from '../api';

/** One page at a time, oldest end extended on demand. 50 is asked for explicitly: the shared
 * cursor page schema defaults to 25, which is not the page this screen wants. */
const PAGE_SIZE = 50;

interface UseRunListOptions {
  readonly orgId: string | undefined;
  readonly projectId: string | undefined;
}

export interface RunList {
  /** Every page so far, flattened, newest first — the order the contract promises. */
  readonly runs: readonly RunResponse[];
  readonly isLoading: boolean;
  readonly isError: boolean;
  /** There is an older page to ask for (FR-019's "load older"). */
  readonly hasMore: boolean;
  readonly isLoadingMore: boolean;
  loadMore: () => void;
}

/**
 * The project's runs, for the run browser.
 *
 * Its own cache key — `['runs', org, project, 'list']` — deliberately distinct from spec 012's
 * `['runs', org, project]`, which holds a single-run `{ limit: 1 }` answer for `use-run.ts`.
 * Sharing the key would have one hook's page overwrite the other's.
 */
export function useRunList({ orgId, projectId }: UseRunListOptions): RunList {
  const enabled = orgId !== undefined && projectId !== undefined && projectId.length > 0;

  const query = useInfiniteQuery<
    RunListResponse,
    Error,
    InfiniteData<RunListResponse>,
    readonly unknown[],
    string | undefined
  >({
    enabled,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    initialPageParam: undefined,
    queryFn: ({ pageParam, signal }) =>
      listRuns(orgId ?? '', projectId ?? '', { cursor: pageParam, limit: PAGE_SIZE }, signal),
    queryKey: ['runs', orgId, projectId, 'list'],
  });

  return {
    hasMore: query.hasNextPage,
    isError: query.isError,
    isLoading: enabled && query.isPending,
    isLoadingMore: query.isFetchingNextPage,
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) {
        void query.fetchNextPage();
      }
    },
    runs: query.data?.pages.flatMap((page) => page.runs) ?? [],
  };
}
