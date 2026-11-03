import { z } from 'zod';

import { emailSchema } from '../common/email';

/**
 * The membership slice (T27) — §11's organisation scope, as a wire format.
 *
 * The two mutations here are the ones §11 singles out: "revoked wholesale on password reset or
 * member removal", and "invalidated on any membership or grant change". Both therefore do more than
 * write a row, and the responses below are deliberately thin because neither has anything useful to
 * say beyond "done".
 */

/**
 * §11's organisation roles. Declared here rather than imported from `@repo/db`, because a client
 * has no business depending on the schema package — but the two cannot drift: the API's membership
 * service assigns this union to the `org_role` enum's, so a role added to one and not the other is
 * a compile error on the server.
 */
export const ORG_ROLES = ['owner', 'admin', 'member', 'billing'] as const;

export const orgRoleSchema = z.enum(ORG_ROLES);

export type OrgRoleName = z.output<typeof orgRoleSchema>;

/**
 * One member of an organisation.
 *
 * `acceptedAt` is null for somebody who was invited and has not accepted, and that distinction is
 * load-bearing rather than cosmetic: an issued invitation is not access, and the resolver treats a
 * pending member exactly as it treats a guest. A list that hid the difference would show an
 * administrator a member who cannot actually do anything.
 */
export const orgMemberSchema = z.strictObject({
  acceptedAt: z.iso.datetime().nullable(),
  email: emailSchema,
  invitedAt: z.iso.datetime(),
  role: orgRoleSchema,
  userId: z.uuid(),
});

export type OrgMember = z.output<typeof orgMemberSchema>;

/** `GET /api/v1/orgs/:orgId/members`, behind `org:members.read`. */
export const orgMemberListResponseSchema = z.strictObject({
  members: z.array(orgMemberSchema),
});

export type OrgMemberListResponse = z.output<typeof orgMemberListResponseSchema>;

/** `PATCH /api/v1/orgs/:orgId/members/:userId`, behind `org:members.role-change`. */
export const changeMemberRoleRequestSchema = z.strictObject({ role: orgRoleSchema });

export type ChangeMemberRoleRequest = z.output<typeof changeMemberRoleRequestSchema>;

export const MEMBER_ROLE_CHANGED = 'member-role-changed';

/**
 * The new role and nothing else. Not the whole member: the caller sent the role, and echoing the
 * address back would make a response body out of a value the request already carried.
 */
export const changeMemberRoleResponseSchema = z.strictObject({
  role: orgRoleSchema,
  status: z.literal(MEMBER_ROLE_CHANGED),
});

export type ChangeMemberRoleResponse = z.output<typeof changeMemberRoleResponseSchema>;

export const MEMBER_REMOVED = 'member-removed';

/**
 * `DELETE /api/v1/orgs/:orgId/members/:userId`, behind `org:members.remove`.
 *
 * A constant, with no count of the sessions that were revoked. That number is a fact about how many
 * devices somebody was signed in on, which is not the remover's business and would be a small
 * surveillance channel granted to every administrator.
 */
export const removeMemberResponseSchema = z.strictObject({
  status: z.literal(MEMBER_REMOVED),
});

export type RemoveMemberResponse = z.output<typeof removeMemberResponseSchema>;
