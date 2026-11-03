import type {
  PreviewResponse,
  PreviewStage,
  PreviewVisibility,
  RotatePreviewResponse,
} from '@repo/contracts';
import {
  type UseMutationResult,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { framePreviewAddress, getPreview, rotatePreview, setPreviewVisibility } from '../api';

interface ProjectRef {
  readonly orgId: string | undefined;
  readonly projectId: string | undefined;
}

function ready({ orgId, projectId }: ProjectRef): boolean {
  return orgId !== undefined && orgId.length > 0 && projectId !== undefined && projectId.length > 0;
}

function previewKey({ orgId, projectId }: ProjectRef): readonly unknown[] {
  return ['preview', orgId, projectId];
}

/**
 * Stages that change only when something else happens (a first run, a wake, a dev server the
 * supervisor restarts): asked slowly rather than never, so the pane leaves them without a reload.
 */
const WAITING: ReadonlySet<PreviewStage> = new Set(['asleep', 'failed', 'no-sandbox']);

export const PREVIEW_POLL_MS = 1_500;

export const PREVIEW_IDLE_POLL_MS = 5_000;

/**
 * Where this project's preview is served, who may reach it, and how far its start-up has got.
 * Asked every 1.5 s while it starts, so the stage pane can walk its steps, and every 5 s while it
 * waits; never once it is ready. React
 * Query pauses the interval in a hidden tab.
 */
export function usePreview(project: ProjectRef): UseQueryResult<PreviewResponse, Error> {
  const { orgId, projectId } = project;

  return useQuery<PreviewResponse, Error>({
    enabled: ready(project),
    queryFn: ({ signal }) => getPreview(orgId ?? '', projectId ?? '', signal),
    queryKey: previewKey(project),
    refetchInterval: (query) => {
      const stage = query.state.data?.stage;

      if (stage === undefined || stage === 'ready') {
        return false;
      }

      return WAITING.has(stage) ? PREVIEW_IDLE_POLL_MS : PREVIEW_POLL_MS;
    },
  });
}

/**
 * What the frame loads for `preview`: a public preview at its plain address; any other at an
 * address carrying a freshly minted grant code, one per `reloadKey`, since each load spends it.
 * `gcTime: 0` so a remount never reuses a spent code from the cache. If no code can be had, the
 * plain address: the gateway then answers the frame with its own redirect or refusal.
 */
export function usePreviewFrameSrc(
  preview: PreviewResponse | undefined,
  reloadKey: number,
): string | undefined {
  const url = preview?.url;
  const needsGrant = url !== undefined && preview?.visibility !== 'public';
  const grant = useQuery<string, Error>({
    enabled: needsGrant,
    gcTime: 0,
    queryFn: ({ signal }) => framePreviewAddress(url ?? '', signal),
    queryKey: ['preview-frame', url, reloadKey],
    retry: false,
  });

  if (!needsGrant) return url;
  return grant.isError ? url : grant.data;
}

/**
 * Change who may reach the preview.
 *
 * The answer is written straight into the query rather than only invalidating: the PUT returns the
 * whole preview, so a refetch would ask for what we already hold. The invalidation still follows,
 * so anything else mounted on the key agrees.
 */
export function useSetVisibility(
  project: ProjectRef,
): UseMutationResult<PreviewResponse, Error, PreviewVisibility, unknown> {
  const { orgId, projectId } = project;
  const queryClient = useQueryClient();

  return useMutation<PreviewResponse, Error, PreviewVisibility>({
    mutationFn: (visibility) =>
      setPreviewVisibility(orgId ?? '', projectId ?? '', visibility, undefined),
    onSuccess: async (preview) => {
      queryClient.setQueryData(previewKey(project), preview);
      await queryClient.invalidateQueries({ queryKey: previewKey(project) });
    },
  });
}

/**
 * Rotate the preview label. The old URL stops resolving, so the caller gets the new one back from
 * `mutateAsync` — that is what the frame reloads onto, and waiting for the query to settle would
 * leave it pointed at a dead address in between.
 */
export function useRotate(
  project: ProjectRef,
): UseMutationResult<RotatePreviewResponse, Error, void, unknown> {
  const { orgId, projectId } = project;
  const queryClient = useQueryClient();

  return useMutation<RotatePreviewResponse, Error, void>({
    mutationFn: () => rotatePreview(orgId ?? '', projectId ?? '', undefined),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: previewKey(project) });
    },
  });
}
