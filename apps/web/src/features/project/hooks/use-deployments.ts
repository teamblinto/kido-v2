import type {
  Deployment,
  DeploymentListResponse,
  DeploymentLogResponse,
  DeploymentResponse,
  DeploymentState,
  Site,
  SiteResponse,
  UpdateSiteRequest,
} from '@repo/contracts';
import {
  type UseMutationResult,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { createDeployment, getDeploymentLog, getSite, listDeployments, updateSite } from '../api';

interface ProjectRef {
  readonly orgId: string | undefined;
  readonly projectId: string | undefined;
}

/** How often the list is re-read while a build is moving: inside the spec's 5 s (US6 #2). */
export const DEPLOYMENT_POLL_MS = 2000;

const IN_FLIGHT: ReadonlySet<DeploymentState> = new Set(['queued', 'building', 'uploading']);

/** A row whose state can still change on its own. */
export function isInFlight(deployment: Pick<Deployment, 'state'>): boolean {
  return IN_FLIGHT.has(deployment.state);
}

function ready({ orgId, projectId }: ProjectRef): boolean {
  return orgId !== undefined && orgId.length > 0 && projectId !== undefined && projectId.length > 0;
}

function deploymentsKey({ orgId, projectId }: ProjectRef): readonly unknown[] {
  return ['deployments', orgId, projectId];
}

function siteKey({ orgId, projectId }: ProjectRef): readonly unknown[] {
  return ['site', orgId, projectId];
}

/**
 * The project's deployments, newest first (the first page — the panel's history).
 *
 * Polled every two seconds while any row is in flight and not at all otherwise. This is the app's
 * first `refetchInterval`, and it is chosen over a server-sent stream on purpose: a build moves
 * through at most four states in minutes, so a short poll that stops by itself keeps "the new
 * status within 5 s" honest without a new SSE channel, a new broker fan-out, or a connection held
 * open by every viewer of the project screen (research R17).
 *
 * When the last in-flight row settles, the site is re-read too: a deploy that went live changed
 * the address and the current pointer, and nothing else would tell the site query so.
 */
export function useDeployments(project: ProjectRef): UseQueryResult<DeploymentListResponse, Error> {
  const { orgId, projectId } = project;
  const queryClient = useQueryClient();

  const query = useQuery({
    enabled: ready(project),
    queryFn: ({ signal }) => listDeployments(orgId ?? '', projectId ?? '', {}, signal),
    queryKey: deploymentsKey(project),
    refetchInterval: (q) =>
      (q.state.data?.items.some(isInFlight) ?? false) ? DEPLOYMENT_POLL_MS : false,
  });

  const moving = query.data?.items.some(isInFlight) ?? false;
  const wasMoving = useRef(moving);

  useEffect(() => {
    if (wasMoving.current && !moving) {
      void queryClient.invalidateQueries({ queryKey: ['site', orgId, projectId] });
    }

    wasMoving.current = moving;
  }, [moving, orgId, projectId, queryClient]);

  return query;
}

/** The project's site, unwrapped from `{ site }`. */
export function useSite(project: ProjectRef): UseQueryResult<Site, Error> {
  const { orgId, projectId } = project;

  return useQuery({
    enabled: ready(project),
    queryFn: ({ signal }) => getSite(orgId ?? '', projectId ?? '', signal),
    queryKey: siteKey(project),
    select: (data: SiteResponse) => data.site,
  });
}

/**
 * One deployment's log tail, fetched only once a row asks for it. A failed build's log does not
 * change after it ends, so it is not refetched in the background.
 */
export function useDeploymentLog(
  project: ProjectRef,
  deploymentId: string | undefined,
): UseQueryResult<DeploymentLogResponse, Error> {
  const { orgId, projectId } = project;

  return useQuery({
    enabled: ready(project) && deploymentId !== undefined,
    queryFn: ({ signal }) =>
      getDeploymentLog(orgId ?? '', projectId ?? '', deploymentId ?? '', signal),
    queryKey: ['deployment-log', orgId, projectId, deploymentId],
    staleTime: Infinity,
  });
}

async function invalidateBoth(
  queryClient: ReturnType<typeof useQueryClient>,
  project: ProjectRef,
): Promise<void> {
  await Promise.all(
    [deploymentsKey(project), siteKey(project)].map((queryKey) =>
      queryClient.invalidateQueries({ queryKey }),
    ),
  );
}

/**
 * Ask for a deploy of a checkpoint (`undefined` is the project's head).
 *
 * The idempotency key follows `useRevert`: minted once per intent — per checkpoint — and held
 * until that intent's request succeeds. Pressing "try again" after a dropped connection or a 503
 * is the same decision and reuses the key, so the server answers with the first attempt's
 * deployment instead of queueing a second build; deploying again after one was accepted is a new
 * decision, and the cleared key makes it one.
 */
export function useDeploy(
  project: ProjectRef,
): UseMutationResult<DeploymentResponse, Error, string | undefined, unknown> {
  const { orgId, projectId } = project;
  const queryClient = useQueryClient();
  const keys = useRef(new Map<string, string>());

  return useMutation({
    mutationFn: (checkpointId: string | undefined) => {
      const intent = checkpointId ?? 'head';
      let key = keys.current.get(intent);

      if (key === undefined) {
        key = crypto.randomUUID();
        keys.current.set(intent, key);
      }

      return createDeployment(
        orgId ?? '',
        projectId ?? '',
        checkpointId === undefined ? {} : { checkpointId },
        key,
      );
    },
    onSuccess: async (_response, checkpointId) => {
      keys.current.delete(checkpointId ?? 'head');
      await invalidateBoth(queryClient, project);
    },
  });
}

/** Release a succeeded deployment (rollback / roll-forward) or take the site offline. */
export function useUpdateSite(
  project: ProjectRef,
): UseMutationResult<SiteResponse, Error, UpdateSiteRequest, unknown> {
  const { orgId, projectId } = project;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: UpdateSiteRequest) => updateSite(orgId ?? '', projectId ?? '', body),
    onSuccess: async () => {
      await invalidateBoth(queryClient, project);
    },
  });
}
