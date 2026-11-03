import type { orgRole, projectRole, workspaceRole } from '@repo/db';

/**
 * The permission vocabulary — the single source of truth for every slug the platform can check
 * (T24). Nothing else may invent one: `@RequirePermission()` (T26) takes {@link Permission}, so a
 * slug this file does not list is a compile error at the call site rather than a string that
 * reaches production and quietly never matches anything.
 *
 * It is a `.ts` file rather than a set of tables on purpose. `packages/db/src/schema/rbac.ts` says
 * so directly: "RBAC has no catalogue tables by design — the permission set each role expands to is
 * code in the resolver, not rows." A catalogue in the database would be a catalogue that can differ
 * between two deployments of the same image.
 *
 * §11 composes three scopes plus a guest state, and the tables below are read straight off it:
 *
 * | Scope     | Roles                             | Grants (§11)                                          |
 * | --------- | --------------------------------- | ----------------------------------------------------- |
 * | org       | owner, admin, member, billing     | members, billing, connectors, domains, settings, audit |
 * | workspace | admin, editor, viewer             | create/archive projects, connectors, invite            |
 * | project   | owner, editor, commenter, viewer  | run the agent, edit files, deploy, preview, share      |
 * | guest     | project-scoped                    | named projects only, no visibility into the org        |
 *
 * Slugs are imperative — `org:members.invite`. Audit actions (`membership.created`) are past tense
 * and live in a separate catalogue; keeping the two visibly different is what stops one being
 * pasted where the other belongs (`modules/audit/audit-actions.ts` makes the same point).
 *
 * The import above is type-only, and deliberately: this module has no runtime dependencies at all,
 * which is the same property {@link resolve} is judged on.
 */

/** What a permission applies to. A guest may draw from `project` and nothing else — {@link GUEST_SCOPES}. */
export const PERMISSION_SCOPES = Object.freeze(['org', 'workspace', 'project'] as const);

export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

/**
 * Organisation-scoped permissions. §11's org row: "Members, billing, connectors, domains, org
 * settings, audit export." These need no resource qualifier — a resolved set already belongs to
 * exactly one `(user, org)` pair.
 */
export const ORG_PERMISSIONS = Object.freeze({
  'org:audit.export': 'Export the organisation audit trail.',
  'org:billing.manage': 'Change the plan, the payment method and the billing details.',
  'org:billing.read': 'See invoices, the current plan and the credit balance.',
  'org:connectors.manage': 'Connect, reconfigure and remove organisation connectors.',
  'org:connectors.read': 'See which organisation connectors exist.',
  'org:domains.manage': 'Add, verify and remove custom domains.',
  'org:members.invite': 'Invite an address into the organisation.',
  'org:members.read': 'See who belongs to the organisation.',
  'org:members.remove': 'Remove another member from the organisation.',
  'org:members.role-change': 'Change the organisation role of another member.',
  'org:read': 'See that the organisation exists, and its name and plan.',
  'org:settings.update': 'Change organisation settings.',
  'org:webhooks.manage': 'Create, change and remove webhook endpoints and read their delivery log.',
} as const satisfies Readonly<Record<string, string>>);

export type OrgPermission = keyof typeof ORG_PERMISSIONS;

/**
 * Workspace-scoped permissions. §11's workspace row: "Create and archive projects, manage workspace
 * connectors, invite into the workspace." Always qualified with a workspace id — see {@link scoped}.
 */
export const WORKSPACE_PERMISSIONS = Object.freeze({
  'workspace:connectors.manage': 'Connect, reconfigure and remove workspace connectors.',
  'workspace:members.invite': 'Invite someone into the workspace.',
  'workspace:projects.archive': 'Archive a project in the workspace.',
  'workspace:projects.create': 'Create a project in the workspace.',
  'workspace:read': 'See the workspace and the projects it holds.',
} as const satisfies Readonly<Record<string, string>>);

export type WorkspacePermission = keyof typeof WORKSPACE_PERMISSIONS;

/**
 * Project-scoped permissions. §11's project row: "Run the agent, edit files, deploy, rotate the
 * preview label, share externally", plus the comment right the `commenter` role is named for.
 * Always qualified with a project id — see {@link scoped}.
 */
export const PROJECT_PERMISSIONS = Object.freeze({
  'project:agent.run': 'Start an agent run in the project.',
  'project:comment.create': 'Comment on the project.',
  'project:deploy': 'Deploy the project.',
  'project:files.write': 'Edit the files in the project.',
  'project:preview.rotate': 'Rotate the project preview label.',
  'project:read': 'See the project, its files and its runs.',
  'project:share.external': 'Share the project outside the organisation.',
} as const satisfies Readonly<Record<string, string>>);

export type ProjectPermission = keyof typeof PROJECT_PERMISSIONS;

/** Every permission the platform knows, in one object, for anything that needs to enumerate them. */
export const PERMISSIONS = Object.freeze({
  ...ORG_PERMISSIONS,
  ...WORKSPACE_PERMISSIONS,
  ...PROJECT_PERMISSIONS,
});

export type Permission = OrgPermission | WorkspacePermission | ProjectPermission;

/**
 * A member of a resolved permission set: an org permission as it stands, or a workspace or project
 * permission qualified with the id of the resource it applies to.
 */
export type PermissionEntry = string;

/** `permission@resourceId`. Excluded from every slug and from uuids, so it cannot be ambiguous. */
export const RESOURCE_DELIMITER = '@';

/**
 * All three role vocabularies the schema fixes (`packages/db/src/schema/tenancy.ts`), derived from
 * the enums rather than restated — a second hand-written list is a list that drifts, and a role
 * that can be stored but not resolved is a row that silently grants nothing.
 *
 * The workspace one was the exception until T27: §11 fixed it, but nothing stored it, so it lived
 * here as a literal with a note saying it would move when `workspace_members` arrived. It has.
 */
export type OrgRole = (typeof orgRole.enumValues)[number];
export type ProjectRole = (typeof projectRole.enumValues)[number];
export type WorkspaceRole = (typeof workspaceRole.enumValues)[number];

/**
 * The value form, for anything that needs to enumerate the workspace roles rather than name one.
 *
 * Written out rather than taken from `workspaceRole.enumValues`, which would be a *runtime* import
 * of `@repo/db` and would cost this module the property stated at the top of the file — that it has
 * no runtime dependencies at all. It cannot drift from the enum regardless: `satisfies` rejects a
 * role the enum does not have, and a role the enum gains but this list forgets fails to compile at
 * {@link WORKSPACE_ROLE_PERMISSIONS}, whose `Record<WorkspaceRole, …>` must be exhaustive.
 * `permissions.spec.ts` closes the loop by asserting the two agree.
 */
export const WORKSPACE_ROLES = Object.freeze([
  'admin',
  'editor',
  'viewer',
] as const satisfies readonly WorkspaceRole[]);

/**
 * `owner` ⊇ `admin` ⊇ `member` is a ladder; `billing` is not on it.
 *
 * §11 lists `billing` as a role of its own rather than a rung above `member`, so `admin` gets to
 * *see* the plan and the invoices — an admin who cannot see what the org is spending cannot do the
 * job — but changing the plan or the card is the owner's or the billing role's alone. If `admin`
 * managed billing too, the `billing` role would be decorative.
 *
 * `org:members.role-change` is here for `admin`, which means an admin can in principle promote
 * someone (including themselves) to owner. That is a service-level invariant, not a catalogue one:
 * the guard answers "may this user change roles at all", and T27's membership service is where "but
 * not to a role above your own" belongs.
 */
export const ORG_ROLE_PERMISSIONS = Object.freeze({
  admin: [
    'org:audit.export',
    'org:billing.read',
    'org:connectors.manage',
    'org:connectors.read',
    'org:domains.manage',
    'org:members.invite',
    'org:members.read',
    'org:members.remove',
    'org:members.role-change',
    'org:read',
    'org:settings.update',
    'org:webhooks.manage',
  ],
  billing: ['org:billing.manage', 'org:billing.read', 'org:read'],
  member: ['org:connectors.read', 'org:members.read', 'org:read'],
  owner: [
    'org:audit.export',
    'org:billing.manage',
    'org:billing.read',
    'org:connectors.manage',
    'org:connectors.read',
    'org:domains.manage',
    'org:members.invite',
    'org:members.read',
    'org:members.remove',
    'org:members.role-change',
    'org:read',
    'org:settings.update',
    'org:webhooks.manage',
  ],
} as const satisfies Readonly<Record<OrgRole, readonly OrgPermission[]>>);

/** `admin` ⊇ `editor` ⊇ `viewer`, exactly as §11's workspace row reads. */
export const WORKSPACE_ROLE_PERMISSIONS = Object.freeze({
  admin: [
    'workspace:connectors.manage',
    'workspace:members.invite',
    'workspace:projects.archive',
    'workspace:projects.create',
    'workspace:read',
  ],
  editor: ['workspace:projects.create', 'workspace:read'],
  viewer: ['workspace:read'],
} as const satisfies Readonly<Record<WorkspaceRole, readonly WorkspacePermission[]>>);

/**
 * `owner` ⊇ `editor` ⊇ `commenter` ⊇ `viewer`. Rotating the preview label and sharing externally
 * are the owner's alone: both change who outside the organisation can reach the project, which is
 * not something an editor of the files should decide.
 */
export const PROJECT_ROLE_PERMISSIONS = Object.freeze({
  commenter: ['project:comment.create', 'project:read'],
  editor: [
    'project:agent.run',
    'project:comment.create',
    'project:deploy',
    'project:files.write',
    'project:read',
  ],
  owner: [
    'project:agent.run',
    'project:comment.create',
    'project:deploy',
    'project:files.write',
    'project:preview.rotate',
    'project:read',
    'project:share.external',
  ],
  viewer: ['project:read'],
} as const satisfies Readonly<Record<ProjectRole, readonly ProjectPermission[]>>);

/**
 * The scopes a guest may draw from — "access to named projects only and no visibility into the
 * organisation" (§11). Stated here rather than only inside {@link resolve} so that the constraint
 * is checkable against the catalogue itself: `permissions.spec.ts` proves no project role can reach
 * a slug outside these scopes, which is what makes the guest rule structural instead of a filter
 * someone could later widen.
 */
export const GUEST_SCOPES = Object.freeze([
  'project',
] as const satisfies readonly PermissionScope[]);

/** The scope that owns a slug. Encoded in the prefix, so this reads it rather than looking it up. */
export function scopeOf(permission: Permission): PermissionScope {
  return permission.slice(0, permission.indexOf(':')) as PermissionScope;
}

/**
 * Qualify a workspace or project permission with the resource it applies to.
 *
 * A resolved set is flat and covers a whole org, so an unqualified `project:files.write` in it
 * would mean "may write files in some project" and would be read by a guard as "may write files in
 * *this* project". Editor of one project, viewer of another — the commonest arrangement there is —
 * would then be a write on both. Every entry that is not org-scoped therefore carries its resource.
 */
export function scoped(
  permission: WorkspacePermission | ProjectPermission,
  resourceId: string,
): PermissionEntry {
  if (resourceId.length === 0 || resourceId.includes(RESOURCE_DELIMITER)) {
    throw new TypeError(
      `resource id ${JSON.stringify(resourceId)} must be non-empty and must not contain ` +
        `${JSON.stringify(RESOURCE_DELIMITER)}, which separates a permission from its resource`,
    );
  }

  return `${permission}${RESOURCE_DELIMITER}${resourceId}`;
}
