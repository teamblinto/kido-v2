import {
  type McpAuthorizationDecision,
  type McpAuthorizationPreview,
  type McpAuthorizationRequest,
  type McpGrant,
  mcpAuthorizationDecisionSchema,
  mcpAuthorizationPreviewSchema,
  mcpAuthorizationRedirectSchema,
  mcpAuthorizationRequestSchema,
  mcpGrantListSchema,
} from '@repo/contracts';

import { apiRequest } from '@/lib/api/client';

/** Spec 046: what the consent page shows before the person decides. */
export function previewMcpAuthorization(
  request: McpAuthorizationRequest,
  signal?: AbortSignal,
): Promise<McpAuthorizationPreview> {
  return apiRequest('POST', '/oauth/authorize/preview', {
    body: mcpAuthorizationRequestSchema.parse(request),
    schema: mcpAuthorizationPreviewSchema,
    signal,
  });
}

/** Allow or deny; answers the client's redirect URI, carrying `code` or `error`. */
export async function decideMcpAuthorization(decision: McpAuthorizationDecision): Promise<string> {
  const { redirectUrl } = await apiRequest('POST', '/oauth/authorize', {
    body: mcpAuthorizationDecisionSchema.parse(decision),
    schema: mcpAuthorizationRedirectSchema,
  });

  return redirectUrl;
}

function grantsPath(orgId: string, rest = ''): string {
  return `/orgs/${encodeURIComponent(orgId)}/mcp/grants${rest}`;
}

/** The caller's own authorized MCP clients in the organisation. */
export async function listMcpGrants(orgId: string, signal?: AbortSignal): Promise<McpGrant[]> {
  const { items } = await apiRequest('GET', grantsPath(orgId), {
    schema: mcpGrantListSchema,
    signal,
  });

  return items;
}

export function revokeMcpGrant(orgId: string, grantId: string): Promise<void> {
  return apiRequest('DELETE', grantsPath(orgId, `/${encodeURIComponent(grantId)}`));
}
