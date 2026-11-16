import { z } from 'zod';

import { containerNameSchema } from './workspace';

/**
 * The project slice (T27, and the surface T30 proves guest access over) — §11's innermost scope.
 *
 * Reads only, for the reason `workspace.ts` gives. What ships is what makes "a guest sees only
 * granted projects" assertable.
 */

/** §11's project roles, matching the `project_role` enum. */
export const PROJECT_ROLE_NAMES = ['owner', 'editor', 'commenter', 'viewer'] as const;

export const projectRoleSchema = z.enum(PROJECT_ROLE_NAMES);

export type ProjectRoleName = z.output<typeof projectRoleSchema>;

/**
 * A project as somebody who may see it sees it.
 *
 * No `previewLabel` and no `repoKey`. The label is the hostname a preview is served on (Appendix
 * A), which is a capability rather than a description — anybody holding it can reach the preview —
 * and a listing that handed it out would make "share externally" (an owner's permission, §11) a
 * thing every viewer could do.
 *
 * **No `workspaceId` either, and that one is T30's** (§11: a guest has "no visibility into the
 * organisation"). A workspace id is organisation structure: it tells a guest that a container
 * exists and that two of the projects they were granted live in the same one. That is a small leak
 * and it is still a leak of exactly the kind the guest scope is defined to prevent, and it would
 * arrive through the one response a guest is entitled to.
 *
 * The alternative — include it for members and omit it for guests — was rejected. It makes the
 * shape of a response depend on who asked, which is a thing every consumer then has to handle and
 * one refactor away from being wrong in the direction that leaks. Nothing needs it today: grouping
 * projects by workspace belongs to a workspace-scoped listing, which arrives with project CRUD in a
 * later phase.
 */
export const projectSummarySchema = z.strictObject({
  createdAt: z.iso.datetime(),
  id: z.uuid(),
  name: z.string().min(1),
  /**
   * 022: the caller's project-qualified permissions, unqualified (`agent.run`, not
   * `project:agent.run`). Required rather than optional, so a caller can never mistake "the field
   * was not filled" for "you may do nothing" — the list route answers `[]` deliberately and the
   * single-project route fills it.
   */
  permissions: z.array(z.string()),
});

export type ProjectSummary = z.output<typeof projectSummarySchema>;

/** `GET /api/v1/orgs/:orgId/projects/:projectId`, behind `project:read`. */
export const projectResponseSchema = z.strictObject({ project: projectSummarySchema });

export type ProjectResponse = z.output<typeof projectResponseSchema>;

/**
 * `GET /api/v1/orgs/:orgId/projects`.
 *
 * The listing T30 is written around: it **excludes** projects the caller may not read rather than
 * returning a refusal per item. A per-item `403` tells a guest exactly how many projects they
 * cannot see — a count of the organisation's work, handed to somebody §11 gives "no visibility into
 * the organisation" — so what they cannot see simply is not there.
 */
export const projectListResponseSchema = z.strictObject({
  projects: z.array(projectSummarySchema),
});

export type ProjectListResponse = z.output<typeof projectListResponseSchema>;

/**
 * `PUT /api/v1/orgs/:orgId/projects/:projectId/grants/:userId` — the row that makes somebody a
 * guest (T30).
 *
 * A `PUT` rather than a `POST`, because granting is idempotent by nature: "this person has this
 * role on this project" is a statement about a state, the table has a unique key on
 * `(org_id, project_id, user_id)`, and re-sending it with the same role must not be a conflict.
 */
export const grantProjectRequestSchema = z.strictObject({ role: projectRoleSchema });

export type GrantProjectRequest = z.output<typeof grantProjectRequestSchema>;

export const PROJECT_GRANTED = 'project-granted';

export const grantProjectResponseSchema = z.strictObject({
  role: projectRoleSchema,
  status: z.literal(PROJECT_GRANTED),
});

export type GrantProjectResponse = z.output<typeof grantProjectResponseSchema>;

export const PROJECT_GRANT_REVOKED = 'project-grant-revoked';

/** `DELETE /api/v1/orgs/:orgId/projects/:projectId/grants/:userId`. */
export const revokeProjectGrantResponseSchema = z.strictObject({
  status: z.literal(PROJECT_GRANT_REVOKED),
});

export type RevokeProjectGrantResponse = z.output<typeof revokeProjectGrantResponseSchema>;

/** The starting points a project can be created from (spec 007). Immutable once chosen. */
export const PROJECT_TEMPLATES = ['vite-react', 'nextjs', 'node-api', 'python'] as const;

export const projectTemplateSchema = z.enum(PROJECT_TEMPLATES);

export type ProjectTemplate = z.output<typeof projectTemplateSchema>;

/**
 * `POST /api/v1/orgs/:orgId/workspaces/:workspaceId/projects`, behind `workspace:projects.create`.
 *
 * Under the workspace rather than `/projects`, because the permission that admits it is a
 * workspace-scoped one and the guard reads its qualifying id from the path (ADR 031).
 */
export const createProjectRequestSchema = z.strictObject({
  /**
   * Spec 047: `name` is provisional — the server replaces it with a generated one once it knows
   * what the project is about (its first prompt). A rename by a person always wins over it.
   */
  autoName: z.boolean().optional(),
  name: containerNameSchema,
  template: projectTemplateSchema.default('vite-react'),
});

export type CreateProjectRequest = z.input<typeof createProjectRequestSchema>;

/** `PATCH /api/v1/orgs/:orgId/workspaces/:workspaceId/projects/:projectId`. */
export const renameProjectRequestSchema = z.strictObject({ name: containerNameSchema });

export type RenameProjectRequest = z.output<typeof renameProjectRequestSchema>;
