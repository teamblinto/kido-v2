import { z } from 'zod';

import { orgRoleSchema } from './membership';

/**
 * The organisation slice (T27).
 *
 * `POST /api/v1/orgs` is the *only* way an organisation comes into existence. ADR 007 settled that
 * signup creates a user and nothing else — "creating an organisation is an explicit, authenticated
 * action, and it belongs to T27" — so this schema is what that action accepts.
 *
 * Everything else here is a read. Project and workspace CRUD stay out of scope per spec 001; what
 * ships is the minimum RBAC needs to be demonstrable.
 */

export const ORG_NAME_MAX_LENGTH = 100;
export const ORG_SLUG_MAX_LENGTH = 63;

/**
 * The organisation's handle. Lowercase, digits and single hyphens, and globally unique — the column
 * carries `orgs_slug_key`.
 *
 * Client-supplied rather than derived from the name, and the difference is worth stating. Deriving
 * it would mean the server silently picking a different slug when one is taken, which is a value
 * the caller then has to be told about and may not want; asking for it makes the collision an
 * explicit `409` the caller resolves. 63 characters because a slug is the kind of thing that ends
 * up in a hostname label, and inheriting that limit now is cheaper than discovering it later.
 */
export const orgSlugSchema = z
  .string()
  .min(2)
  .max(ORG_SLUG_MAX_LENGTH)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    error: 'Use lowercase letters, digits and single hyphens.',
  });

export const createOrgRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(ORG_NAME_MAX_LENGTH),
  slug: orgSlugSchema,
});

export type CreateOrgRequest = z.output<typeof createOrgRequestSchema>;

/**
 * An organisation as a member sees it.
 *
 * No `creditBalance` and no `settings`. §11 gives billing a role of its own, so the balance belongs
 * to a billing response rather than to the answer everyone with `org:read` gets, and `settings` is
 * an open `jsonb` column that will hold things not everybody may see. A summary that grew either by
 * default is a summary that leaks the day somebody puts something sensitive in it.
 */
export const orgSummarySchema = z.strictObject({
  createdAt: z.iso.datetime(),
  id: z.uuid(),
  name: z.string().min(1),
  plan: z.string().min(1),
  slug: orgSlugSchema,
});

export type OrgSummary = z.output<typeof orgSummarySchema>;

/** `POST /api/v1/orgs` and `GET /api/v1/orgs/:orgId` answer with the same shape. */
export const orgResponseSchema = z.strictObject({ org: orgSummarySchema });

export type OrgResponse = z.output<typeof orgResponseSchema>;

/**
 * An organisation in the caller's own list, and the role they hold in it.
 *
 * The role rides along for the reason `workspaceSummarySchema` carries one: a listing exists to be
 * chosen from, and the first thing a client does with the choice is decide which of its own
 * controls to render. Without it every entry costs a second request to find out whether the caller
 * is an owner or a member, and a client that guesses renders a settings link that 403s.
 *
 * It is the caller's role and never a member list. "Who else is in this organisation" is
 * `GET /orgs/:orgId/members`, behind a permission of its own — this response is available to anyone
 * with a session, so anything it grew would be visible to every member regardless of role.
 *
 * Spec 031 (contracts/sharing.md § 6) lists guests too: `access` says which, and `role` is null
 * exactly for a guest, who holds project grants and no organisation role.
 */
export const orgMembershipSchema = orgSummarySchema
  .extend({ access: z.enum(['member', 'guest']), role: orgRoleSchema.nullable() })
  .refine((entry) => (entry.role === null) === (entry.access === 'guest'), {
    error: 'A guest has no organisation role, and a member always has one.',
    path: ['role'],
  });

export type OrgMembership = z.output<typeof orgMembershipSchema>;

/**
 * `GET /api/v1/orgs` — the organisations the caller is a member of.
 *
 * The one read in the API that is rooted at a person rather than at an organisation, and it is what
 * a client calls to find out which `:orgId` to put in every other URL. It takes no parameters at
 * all: whose organisations these are is settled by the session cookie, and a `userId` here would be
 * a way to ask after somebody else's.
 *
 * **Membership, not visibility.** An accepted membership only. Somebody invited and not yet
 * accepted holds no permissions — the resolver treats a pending membership exactly as it treats a
 * guest — and a guest with a project grant is given "no visibility into the organisation" by §11.
 * Listing either would put an organisation in front of a caller who is refused every route inside
 * it, which is a worse answer than not listing it.
 *
 * An account in no organisation gets an empty array rather than a `404`: "which organisations am I
 * in?" has an answer even when it is "none", and that answer is what a client shows a
 * just-registered user the create-an-organisation screen from.
 */
export const orgListResponseSchema = z.strictObject({
  orgs: z.array(orgMembershipSchema),
});

export type OrgListResponse = z.output<typeof orgListResponseSchema>;

/**
 * `GET`/`PUT /orgs/:orgId/settings/personal-accounts` (spec 032, contracts § 2): whether members
 * may run on their own linked subscriptions. The same shape is the request and the response.
 */
export const personalAccountsPolicySchema = z.strictObject({ allowed: z.boolean() });

export type PersonalAccountsPolicy = z.output<typeof personalAccountsPolicySchema>;
