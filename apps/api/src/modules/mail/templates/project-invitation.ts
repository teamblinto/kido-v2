import type { MailMessage } from '../mailer.port';
import { formatDuration, renderHtml, renderText } from './layout';
import { projectInvitationUrl } from './links';

export interface ProjectInvitationMailInput {
  /** `APP_URL`. */
  readonly appUrl: string;
  readonly expiresInMinutes: number;
  /** The inviter's address. Absent when the inviting account is gone — the mail still reads. */
  readonly invitedBy?: string;
  /** Rides in the link (`?org=`) so acceptance can open its tenant transaction; never rendered. */
  readonly orgId: string;
  readonly projectName: string;
  /** The project role being offered. */
  readonly role: string;
  readonly to: string;
  /** The raw token. It reaches the link and nothing else. */
  readonly token: string;
}

/**
 * "You've been invited to a project" (spec 031, contracts/sharing.md § 7).
 *
 * Like `invitationMail` it interpolates values a user chose — a project name — into mail to an
 * address that user typed, so everything in the body goes through `renderHtml`'s escaping. The
 * subject is fixed text: it names neither the project nor the organisation, so nothing a stranger
 * chose reaches a header. It says nothing about whether the address has an account (FR-020).
 */
export function projectInvitationMail(input: ProjectInvitationMailInput): MailMessage {
  const url = projectInvitationUrl(input.appUrl, input.orgId, input.token);
  const invitation =
    input.invitedBy === undefined || input.invitedBy.trim().length === 0
      ? `You have been invited to the project ${input.projectName} on Forge as ${input.role}.`
      : `${input.invitedBy} has invited you to the project ${input.projectName} on Forge as ${input.role}.`;

  const body = {
    action: { label: 'Open the project', url },
    closing: [
      `This invitation works once and expires in ${formatDuration(input.expiresInMinutes)}.`,
      'If you were not expecting it, you can ignore this message — no account of yours was changed.',
    ],
    heading: `Join ${input.projectName} on Forge`,
    paragraphs: [
      invitation,
      'Accepting gives you access to this project only. If you do not have a Forge account yet, you will be able to create one on the way in.',
    ],
  } as const;

  return {
    html: renderHtml(body),
    subject: "You've been invited to a project",
    template: 'project-invitation',
    text: renderText(body),
    to: input.to,
  };
}
