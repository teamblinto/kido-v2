import { z } from 'zod';

import { emailSchema } from '../common/email';
import { orgRoleSchema } from '../tenancy/membership';
import { verificationTokenSchema } from './verify';

/**
 * The invitation slice (T29, success criterion 10) — the one way somebody becomes a member of an
 * organisation they did not create.
 *
 * Two endpoints and a deliberate asymmetry between them. Issuing an invitation is an administrative
 * act behind `org:members.invite`, and its response is shaped by what it must *not* say. Accepting
 * one is done by the person who received the mail, is authenticated as themselves, and can be told
 * plainly what just happened.
 */

/**
 * `POST /api/v1/orgs/:orgId/invitations`.
 *
 * The role is the full organisation vocabulary rather than a restricted subset, because the
 * restriction that matters is relational — an actor may not confer a role above their own — and a
 * schema has neither of the two rows it would need to check that. `InvitationService` holds it, the
 * same place `MembershipService.changeRole` holds the identical rule for an existing member.
 */
export const inviteMemberRequestSchema = z.strictObject({
  email: emailSchema,
  role: orgRoleSchema,
});

export type InviteMemberRequest = z.output<typeof inviteMemberRequestSchema>;

/** What an issued invitation answers with — `202 Accepted`, because the mail goes out after commit. */
export const INVITATION_SENT = 'invitation-sent';

/**
 * The response to issuing an invitation, and the shape criterion 10's enumeration-safety property
 * is written into.
 *
 * Three members, and the argument is about the ones that are absent. An address an administrator
 * typed either has a Forge account or does not, is either already a member or is not, and **this
 * response is byte-identical in all four combinations**. It has to be: `org:members.invite` is a
 * permission plenty of people hold, and a response that varied would be an account-existence oracle
 * any admin could query one address at a time, for addresses that have nothing to do with their
 * organisation.
 *
 * `strictObject` with a literal `status` is what keeps it that way. A later task's well-meant
 * `{ existingUser: true }` or `{ alreadyMember: false }` is a failing test here rather than a leak
 * in production — the same guard `resendVerificationResponseSchema` puts on the same class of bug.
 *
 * `id` and `expiresAt` are safe to return and worth returning: both are facts about a row in the
 * caller's *own* organisation, which they may already list, and neither differs by anything about
 * the invited address. `id` is also what makes a repeated `Idempotency-Key` provable — a second
 * execution would necessarily mint a different one.
 */
export const invitationAcceptedResponseSchema = z.strictObject({
  expiresAt: z.iso.datetime(),
  id: z.uuid(),
  status: z.literal(INVITATION_SENT),
});

export type InvitationAcceptedResponse = z.output<typeof invitationAcceptedResponseSchema>;

/**
 * `POST /api/v1/orgs/:orgId/invitations/accept`.
 *
 * The token comes from the link and the organisation from the path, which is not redundancy: every
 * tenant-owned read runs under RLS, so acceptance has to establish a tenant context *before* it can
 * look the invitation up at all. `schema/rbac.ts` states it — "the invitation link therefore carries
 * the organisation id alongside the token" — and the id is not the secret. The token is.
 */
export const acceptInvitationRequestSchema = z.strictObject({ token: verificationTokenSchema });

export type AcceptInvitationRequest = z.output<typeof acceptInvitationRequestSchema>;

export const INVITATION_ACCEPTED = 'invitation-accepted';

/**
 * What accepting answers with.
 *
 * The organisation and the role, because the person who just joined is entitled to know both and
 * the client needs them to route somewhere useful. Never the token: it was the credential in the
 * request, and echoing a credential puts it in every client log and browser history entry the
 * response reaches.
 */
export const acceptInvitationResponseSchema = z.strictObject({
  orgId: z.uuid(),
  role: orgRoleSchema,
  status: z.literal(INVITATION_ACCEPTED),
});

export type AcceptInvitationResponse = z.output<typeof acceptInvitationResponseSchema>;
