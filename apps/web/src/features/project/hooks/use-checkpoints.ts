import type { Checkpoint, CheckpointDiffResponse, CheckpointListResponse } from '@repo/contracts';
import {
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useRef } from 'react';

import { getCheckpointDiff, listCheckpoints, revertCheckpoint } from '../api';

interface ProjectRef {
  readonly orgId: string | undefined;
  readonly projectId: string | undefined;
}

/** Both reads are project-scoped; neither is worth asking before the project is known. */
function ready({ orgId, projectId }: ProjectRef): boolean {
  return orgId !== undefined && orgId.length > 0 && projectId !== undefined && projectId.length > 0;
}

/**
 * The project's history, newest first, a page at a time.
 *
 * `nextCursor` is the whole of the paging: the response carries it or carries `null`, and `null`
 * is the end. Nothing here counts pages or remembers offsets, because a cursor list has no stable
 * offsets to remember — checkpoints land while the pane is open.
 */
export function useCheckpoints(
  project: ProjectRef,
): UseInfiniteQueryResult<{ readonly checkpoints: readonly Checkpoint[] }, Error> {
  const { orgId, projectId } = project;

  return useInfiniteQuery<
    CheckpointListResponse,
    Error,
    { readonly checkpoints: readonly Checkpoint[] },
    readonly unknown[],
    string | undefined
  >({
    enabled: ready(project),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    initialPageParam: undefined,
    queryFn: ({ pageParam, signal }) =>
      listCheckpoints(orgId ?? '', projectId ?? '', { cursor: pageParam }, signal),
    queryKey: ['checkpoints', orgId, projectId],
    // Flattened here rather than in every consumer: the pages are an artefact of how the list
    // arrives, not something the history pane has an opinion about.
    select: (data) => ({ checkpoints: data.pages.flatMap((page) => page.items) }),
  });
}

/**
 * One checkpoint's diff. Never invalidated — a checkpoint's diff against its parent cannot change
 * once both exist — so it is cached for the session and only fetched the first time a row opens.
 */
export function useCheckpointDiff(
  project: ProjectRef,
  checkpointId: string | undefined,
): UseQueryResult<CheckpointDiffResponse, Error> {
  const { orgId, projectId } = project;

  return useQuery({
    enabled: ready(project) && checkpointId !== undefined,
    gcTime: Infinity,
    queryFn: ({ signal }) =>
      getCheckpointDiff(orgId ?? '', projectId ?? '', checkpointId ?? '', signal),
    queryKey: ['checkpoint-diff', orgId, projectId, checkpointId],
    staleTime: Infinity,
  });
}

/**
 * Restore the workspace to a checkpoint.
 *
 * The idempotency key is minted here, once per target, and held until that target's revert
 * succeeds. That is what makes a retry a retry: pressing "try again" after a refusal or a dropped
 * connection reverts to the same checkpoint and so reuses the key, and the server answers with
 * the first attempt's checkpoint rather than stacking a second one. Deciding to revert again
 * afterwards is a different action, and the cleared key makes it one.
 *
 * The invalidation is deliberately wide. A revert rewrites the working tree, so the file list,
 * whatever file is open and the preview are all answers from before it — `['checkpoints']` alone
 * would leave the rest of the screen describing a tree that no longer exists.
 */
export function useRevert(
  project: ProjectRef,
): UseMutationResult<Checkpoint, Error, string, unknown> {
  const { orgId, projectId } = project;
  const queryClient = useQueryClient();
  const keys = useRef(new Map<string, string>());

  return useMutation({
    mutationFn: (checkpointId: string) => {
      let key = keys.current.get(checkpointId);

      if (key === undefined) {
        key = crypto.randomUUID();
        keys.current.set(checkpointId, key);
      }

      return revertCheckpoint(orgId ?? '', projectId ?? '', checkpointId, key);
    },
    onSuccess: async (_checkpoint, checkpointId) => {
      keys.current.delete(checkpointId);

      await Promise.all(
        [['checkpoints'], ['files'], ['file'], ['preview']].map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      );
    },
  });
}
