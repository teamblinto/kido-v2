import type { OrgMembership, ProjectSummary } from '@repo/contracts';

import type { Project, Workspace } from '../types';

/**
 * The API's shapes, as these screens render them.
 *
 * Kept in one module so the mismatches are visible together rather than discovered one component at
 * a time — and every one of them is a deliberate decision about a field the API does not serve.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "Edited 2 hours ago", from the only timestamp a project carries.
 *
 * `createdAt` is not an edit time, and the label says "Created" rather than "Edited" because of it.
 * A last-touched timestamp arrives when projects have a lifecycle to report; until then, claiming
 * one would be the card asserting something nothing measured.
 */
export function describeAge(iso: string, now: number): string {
  const elapsed = now - new Date(iso).getTime();

  if (Number.isNaN(elapsed) || elapsed < 0) {
    return 'Created recently';
  }

  if (elapsed < HOUR) {
    const minutes = Math.max(1, Math.floor(elapsed / MINUTE));

    return `Created ${String(minutes)} minute${minutes === 1 ? '' : 's'} ago`;
  }

  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);

    return `Created ${String(hours)} hour${hours === 1 ? '' : 's'} ago`;
  }

  const days = Math.floor(elapsed / DAY);

  if (days === 1) {
    return 'Created yesterday';
  }

  return `Created ${String(days)} days ago`;
}

/**
 * A project card from a `ProjectSummary`.
 *
 * The card carries only what the API serves. See {@link Project} for the two fields that used
 * to be here and why they are not.
 */
export function toProjectCard(project: ProjectSummary, now: number): Project {
  return {
    activity: describeAge(project.createdAt, now),
    id: project.id,
    name: project.name,
  };
}

/**
 * The sidebar's workspace identity, from an organisation membership.
 *
 * The switcher shows organisations, not the API's `workspaces` — the two words collide, and this is
 * where they are reconciled. What the sidebar calls a workspace is the tenant the caller is
 * currently working in, which is an organisation; the API's workspaces are containers *inside* one,
 * and spec 001 gives them no UI of their own.
 *
 * `seats` is a member count when the caller may read the member list and the role otherwise.
 * `org:members.read` is not a permission every role holds, and a sidebar that showed "—" to a
 * perfectly ordinary member would look broken rather than restricted.
 */
export function toWorkspaceSummary(org: OrgMembership, memberCount: number | undefined): Workspace {
  // A guest (spec 031) holds project grants and no organisation role.
  const role = org.role ?? 'guest';

  return {
    id: org.id,
    name: org.name,
    plan: capitalise(org.plan),
    seats:
      memberCount === undefined
        ? `You are ${article(role)} ${role}`
        : `${String(memberCount)} member${memberCount === 1 ? '' : 's'}`,
  };
}

function capitalise(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
}

function article(role: string): string {
  return /^[aeiou]/i.test(role) ? 'an' : 'a';
}
