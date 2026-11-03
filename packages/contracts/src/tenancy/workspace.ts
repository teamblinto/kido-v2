import { z } from 'zod';

/**
 * The workspace slice (T27) — §11's middle scope, as a wire format.
 *
 * Reads only. Spec 001 puts workspace CRUD out of scope: "Only the tables and permission scopes are
 * needed for RBAC to resolve." What ships is what makes "an org member of the wrong role cannot
 * read another workspace" a thing an e2e test can assert.
 */

/** §11's workspace roles, matching the `workspace_role` enum T27 added. */
export const WORKSPACE_ROLE_NAMES = ['admin', 'editor', 'viewer'] as const;

export const workspaceRoleSchema = z.enum(WORKSPACE_ROLE_NAMES);

export type WorkspaceRoleName = z.output<typeof workspaceRoleSchema>;

export const workspaceSummarySchema = z.strictObject({
  createdAt: z.iso.datetime(),
  id: z.uuid(),
  name: z.string().min(1),
  /** The caller's own role in it — never the membership list, which is a separate permission. */
  role: workspaceRoleSchema,
});

export type WorkspaceSummary = z.output<typeof workspaceSummarySchema>;

/** `GET /api/v1/orgs/:orgId/workspaces/:workspaceId`, behind `workspace:read`. */
export const workspaceResponseSchema = z.strictObject({ workspace: workspaceSummarySchema });

export type WorkspaceResponse = z.output<typeof workspaceResponseSchema>;

/**
 * `GET /api/v1/orgs/:orgId/workspaces`.
 *
 * Excludes the workspaces the caller holds no role in, rather than listing them and refusing each.
 * A per-item refusal would tell the caller exactly how many workspaces they cannot see, which is
 * the same leak T30 avoids for projects and is avoided here for the same reason.
 */
export const workspaceListResponseSchema = z.strictObject({
  workspaces: z.array(workspaceSummarySchema),
});

export type WorkspaceListResponse = z.output<typeof workspaceListResponseSchema>;

/**
 * A workspace or project name as the wire accepts it (spec 007): trimmed, then one to 120
 * characters. Trim first, so a whitespace-only name is empty rather than a row nobody can read
 * the name of.
 */
export const containerNameSchema = z.string().trim().min(1).max(120);

/** `POST /api/v1/orgs/:orgId/workspaces`, behind `org:settings.update`. */
export const createWorkspaceRequestSchema = z.strictObject({ name: containerNameSchema });

export type CreateWorkspaceRequest = z.output<typeof createWorkspaceRequestSchema>;

/** `PATCH /api/v1/orgs/:orgId/workspaces/:workspaceId`, behind `org:settings.update`. */
export const renameWorkspaceRequestSchema = z.strictObject({ name: containerNameSchema });

export type RenameWorkspaceRequest = z.output<typeof renameWorkspaceRequestSchema>;
