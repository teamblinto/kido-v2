import {
  IDEMPOTENCY_KEY_HEADER,
  type InviteToProjectResponse,
  type ProjectAccessResponse,
  grantProjectResponseSchema,
  inviteToProjectRequestSchema,
  inviteToProjectResponseSchema,
  projectAccessResponseSchema,
  revokeProjectGrantResponseSchema,
} from '@repo/contracts';
import {
  type UseMutationResult,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { apiRequest } from '@/lib/api/client';

/** A project role, as the contracts spell it. */
export type ProjectRole = ProjectAccessResponse['grants'][number]['role'];

interface ProjectRef {
  readonly orgId: string | undefined;
  readonly projectId: string | undefined;
}

function base({ orgId, projectId }: ProjectRef): string {
  return `/orgs/${encodeURIComponent(orgId ?? '')}/projects/${encodeURIComponent(projectId ?? '')}`;
}

function ready({ orgId, projectId }: ProjectRef): boolean {
  return orgId !== undefined && orgId.length > 0 && projectId !== undefined && projectId.length > 0;
}

export function projectAccessKey({ orgId, projectId }: ProjectRef): readonly unknown[] {
  return ['project-access', orgId, projectId];
}

/**
 * Sharing one project (spec 031 US2, contracts/sharing.md §§ 1–5): who has it, who is invited, and
 * the four changes an owner makes. Every change invalidates the access query, so the panel shows
 * what the server now holds rather than what the click hoped for.
 */
export function useProjectAccess(project: ProjectRef): UseQueryResult<ProjectAccessResponse> {
  return useQuery({
    enabled: ready(project),
    queryFn: ({ signal }) =>
      apiRequest('GET', `${base(project)}/access`, { schema: projectAccessResponseSchema, signal }),
    queryKey: projectAccessKey(project),
  });
}

function useInvalidating<TVariables, TResult>(
  project: ProjectRef,
  mutationFn: (variables: TVariables) => Promise<TResult>,
): UseMutationResult<TResult, Error, TVariables> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn,
    onSettled: () => queryClient.invalidateQueries({ queryKey: projectAccessKey(project) }),
  });
}

export function useInviteToProject(
  project: ProjectRef,
): UseMutationResult<InviteToProjectResponse, Error, { email: string; role: ProjectRole }> {
  return useInvalidating(project, (body) =>
    apiRequest('POST', `${base(project)}/invitations`, {
      body: inviteToProjectRequestSchema.parse(body),
      // One key per click: the server's open-invitation index already makes a repeat harmless.
      headers: { [IDEMPOTENCY_KEY_HEADER]: crypto.randomUUID() },
      schema: inviteToProjectResponseSchema,
    }),
  );
}

export function useWithdrawInvitation(project: ProjectRef): UseMutationResult<void, Error, string> {
  return useInvalidating(project, (invitationId: string) =>
    apiRequest('DELETE', `${base(project)}/invitations/${encodeURIComponent(invitationId)}`),
  );
}

export function useChangeProjectRole(
  project: ProjectRef,
): UseMutationResult<unknown, Error, { role: ProjectRole; userId: string }> {
  return useInvalidating(project, ({ role, userId }) =>
    apiRequest('PUT', `${base(project)}/grants/${encodeURIComponent(userId)}`, {
      body: { role },
      schema: grantProjectResponseSchema,
    }),
  );
}

export function useRemoveFromProject(
  project: ProjectRef,
): UseMutationResult<unknown, Error, string> {
  return useInvalidating(project, (userId: string) =>
    apiRequest('DELETE', `${base(project)}/grants/${encodeURIComponent(userId)}`, {
      schema: revokeProjectGrantResponseSchema,
    }),
  );
}
