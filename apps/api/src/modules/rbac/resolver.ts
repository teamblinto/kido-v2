import type { OrgRole, PermissionEntry, ProjectRole, WorkspaceRole } from './permissions';
import {
  ORG_ROLE_PERMISSIONS,
  PROJECT_ROLE_PERMISSIONS,
  scoped,
  WORKSPACE_ROLE_PERMISSIONS,
} from './permissions';

/** The user being resolved. Only the identity is used; nothing here reads account state. */
export interface ResolvableUser {
  readonly id: string;
}

/**
 * The tenant being resolved against. `deletedAt` is required rather than optional because a caller
 * that has not loaded it has not established that the tenant is live, and defaulting the answer to
 * "not deleted" would make the omission invisible.
 */
export interface ResolvableOrg {
  readonly deletedAt: Date | null;
  readonly id: string;
}

/**
 * The rows below are structural subsets of the Drizzle row types — `Membership` and `ProjectGrant`
 * are assignable to them as they come out of the database, which `resolver.spec.ts` proves — so
 * T27 hands over what it already loaded rather than mapping it into a shape that exists only here.
 */
export interface ResolvedMembership {
  readonly acceptedAt: Date | null;
  readonly orgId: string;
  readonly role: OrgRole;
  readonly userId: string;
}

/** Workspace membership has no table yet (T27); §11 fixes the vocabulary and `permissions.ts` holds it. */
export interface ResolvedWorkspaceRole {
  readonly orgId: string;
  readonly role: WorkspaceRole;
  readonly userId: string;
  readonly workspaceId: string;
}

export interface ResolvedProjectGrant {
  readonly orgId: string;
  readonly projectId: string;
  readonly role: ProjectRole;
  readonly userId: string;
}

/** Both the org and the user must match, on every row, in every scope. */
function belongsTo(user: ResolvableUser, org: ResolvableOrg) {
  return (row: { readonly orgId: string; readonly userId: string }): boolean =>
    row.orgId === org.id && row.userId === user.id;
}

/**
 * Resolve `(user, org)` to the flat permission set §11 describes.
 *
 * **Pure.** No database, no Redis, no clock, no configuration — every input is an argument and
 * nothing survives the call. That is not a stylistic preference: it is what makes the policy engine
 * exhaustively testable, which is why the plan marks T24 `[TDD, pure]` and asks for no uncovered
 * branch. If a change here wants a query, the argument list is wrong. Loading the rows is T27's
 * job; caching the answer is `permission-cache.ts`'s (T25).
 *
 * **Three scopes compose, and nothing cascades.** The answer is the union of what the org role, the
 * workspace roles and the project grants each grant. An org owner does not implicitly own every
 * project: §11's table gives the org scope members, billing, connectors, domains, settings and
 * audit export, and lists the project rights separately. Inventing a cascade would grant access the
 * document never describes, and over-granting is the one failure mode an authorisation engine
 * cannot afford — T27 gives a creator explicit workspace and project roles instead.
 *
 * **Entries carry their resource.** Org permissions are bare, because the whole set already belongs
 * to one org. Workspace and project permissions are qualified — `project:deploy@{project_id}` — via
 * {@link scoped}. A flat set of bare slugs could not tell "editor of this project" from "editor of
 * some project", and being editor of one project would silently mean write access to every one.
 *
 * **A guest is an absence, not a filter.** "An external collaborator with access to named projects
 * only and no visibility into the organisation" (§11). A guest holds no accepted membership row, so
 * the org and workspace scopes are not narrowed for them — they are never entered. A membership
 * that exists but has not been accepted is the same thing: an issued invitation is not access, so
 * a pending member resolves exactly as a guest does, from their project grants alone.
 *
 * Rows for another org or another user are ignored rather than trusted. The caller is expected to
 * have queried correctly, but this set is cached per `(user, org)` and nothing downstream re-checks
 * which tenant a slug came from, so a wrong row here would be a cross-tenant grant nobody catches.
 *
 * @returns a new set on every call — a caller that mutates it cannot affect the next one
 */
export function resolve(
  user: ResolvableUser,
  org: ResolvableOrg,
  memberships: readonly ResolvedMembership[],
  workspaceRoles: readonly ResolvedWorkspaceRole[],
  projectGrants: readonly ResolvedProjectGrant[],
): ReadonlySet<PermissionEntry> {
  const permissions = new Set<PermissionEntry>();

  // A soft-deleted tenant is not one anyone acts in. The window between delete and purge exists so
  // a tenant can be restored (ADR 012); it must not also be a window in which the last owner can
  // still export the audit trail.
  if (org.deletedAt !== null) {
    return permissions;
  }

  const mine = belongsTo(user, org);

  for (const grant of projectGrants) {
    if (mine(grant)) {
      for (const permission of PROJECT_ROLE_PERMISSIONS[grant.role]) {
        permissions.add(scoped(permission, grant.projectId));
      }
    }
  }

  const membership = memberships.find((row) => mine(row) && row.acceptedAt !== null);

  // Guest, or invited and not yet accepted: the project grants above are the whole answer.
  if (membership === undefined) {
    return permissions;
  }

  for (const permission of ORG_ROLE_PERMISSIONS[membership.role]) {
    permissions.add(permission);
  }

  for (const workspaceRole of workspaceRoles) {
    if (mine(workspaceRole)) {
      for (const permission of WORKSPACE_ROLE_PERMISSIONS[workspaceRole.role]) {
        permissions.add(scoped(permission, workspaceRole.workspaceId));
      }
    }
  }

  return permissions;
}
