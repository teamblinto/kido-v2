import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { listMcpGrants, revokeMcpGrant } from './mcp-api';

export function mcpGrantsKey(orgId: string): readonly unknown[] {
  return ['mcp', orgId, 'grants'];
}

export function useMcpGrants(orgId: string) {
  return useQuery({
    queryFn: ({ signal }) => listMcpGrants(orgId, signal),
    queryKey: mcpGrantsKey(orgId),
  });
}

export function useRevokeMcpGrant(orgId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (grantId: string) => revokeMcpGrant(orgId, grantId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: mcpGrantsKey(orgId) }),
  });
}
