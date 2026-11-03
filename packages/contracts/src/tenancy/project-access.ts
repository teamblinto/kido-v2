import { z } from 'zod';

import { projectRoleSchema } from './project';

/** Sharing a project (spec 031, contracts/sharing.md §§ 1–5). */

/** `GET …/projects/:projectId/access`: grants and open invitations, never the org's members. */
export const projectAccessResponseSchema = z.strictObject({
  grants: z.array(z.strictObject({ email: z.email(), role: projectRoleSchema, userId: z.uuid() })),
  invitations: z.array(
    z.strictObject({
      email: z.email(),
      expiresAt: z.iso.datetime(),
      id: z.uuid(),
      role: projectRoleSchema,
    }),
  ),
});

export type ProjectAccessResponse = z.output<typeof projectAccessResponseSchema>;

/** `POST …/projects/:projectId/invitations`. */
export const inviteToProjectRequestSchema = z.strictObject({
  email: z.email().max(254),
  role: projectRoleSchema,
});

export type InviteToProjectRequest = z.output<typeof inviteToProjectRequestSchema>;

/** Always `202`, whatever the address (FR-020, SC-007). */
export const inviteToProjectResponseSchema = z.strictObject({
  expiresAt: z.iso.datetime(),
  id: z.uuid(),
  status: z.literal('invitation-sent'),
});

export type InviteToProjectResponse = z.output<typeof inviteToProjectResponseSchema>;

/** `POST …/project-invitations/accept`. */
export const acceptProjectInvitationRequestSchema = z.strictObject({
  token: z.string().min(32).max(128),
});

export type AcceptProjectInvitationRequest = z.output<typeof acceptProjectInvitationRequestSchema>;

export const acceptProjectInvitationResponseSchema = z.strictObject({ projectId: z.uuid() });

export type AcceptProjectInvitationResponse = z.output<
  typeof acceptProjectInvitationResponseSchema
>;

/** A grant change or removal that would leave the project with no owner: `409`. */
export const projectAccessConflictReasonSchema = z.enum(['last-owner']);

export type ProjectAccessConflictReason = z.output<typeof projectAccessConflictReasonSchema>;
