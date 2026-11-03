import {
  type ChangeMemberRoleResponse,
  type OrgMemberListResponse,
  type OrgRoleName,
  type RemoveMemberResponse,
  changeMemberRoleRequestSchema,
  changeMemberRoleResponseSchema,
  removeMemberResponseSchema,
} from '@repo/contracts';
import {
  type UseMutationResult,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { listMembers } from '@/features/workspace/api';
import { apiRequest } from '@/lib/api/client';

/** The workspace home's key too, so its member count follows a removal. */
function membersKey(orgId: string): readonly unknown[] {
  return ['members', orgId];
}

function memberPath(orgId: string, userId: string): string {
  return `/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`;
}

export function useMembers(orgId: string): UseQueryResult<OrgMemberListResponse> {
  return useQuery({
    queryFn: ({ signal }) => listMembers(orgId, signal),
    queryKey: membersKey(orgId),
    // `org:members.read` is not held by every role; a 403 is an answer, not a fault.
    retry: false,
  });
}

/** Every change re-reads the list, so it shows what the server holds rather than what was hoped. */
function useInvalidating<TVariables, TResult>(
  orgId: string,
  mutationFn: (variables: TVariables) => Promise<TResult>,
): UseMutationResult<TResult, Error, TVariables> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn,
    onSettled: () => queryClient.invalidateQueries({ queryKey: membersKey(orgId) }),
  });
}

/** `PATCH /orgs/:orgId/members/:userId`, behind `org:members.role-change`. */
export function useChangeMemberRole(
  orgId: string,
): UseMutationResult<ChangeMemberRoleResponse, Error, { role: OrgRoleName; userId: string }> {
  return useInvalidating(orgId, ({ role, userId }) =>
    apiRequest('PATCH', memberPath(orgId, userId), {
      body: changeMemberRoleRequestSchema.parse({ role }),
      schema: changeMemberRoleResponseSchema,
    }),
  );
}

/** `DELETE /orgs/:orgId/members/:userId`, behind `org:members.remove`; revokes their sessions. */
export function useRemoveMember(
  orgId: string,
): UseMutationResult<RemoveMemberResponse, Error, string> {
  return useInvalidating(orgId, (userId: string) =>
    apiRequest('DELETE', memberPath(orgId, userId), { schema: removeMemberResponseSchema }),
  );
}
