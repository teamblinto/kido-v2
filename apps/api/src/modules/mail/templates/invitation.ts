import type { MailMessage } from '../mailer.port';
import { formatDuration, renderHtml, renderText } from './layout';
import { invitationUrl } from './links';

export interface InvitationMailInput {
  /** `APP_URL`. The mail module never reads configuration; the adapter's caller supplies this. */
  readonly appUrl: string;
  /** The window T29's token enforces, passed in rather than restated here. */
  readonly expiresInMinutes: number;
  /** The inviter's display name. Absent when they have not set one — the mail still makes sense. */
  readonly invitedBy?: string;
  /**
   * The organisation the link accepts into. It rides in the URL because acceptance has to open a
   * tenant transaction before it can read anything — `links.ts` argues why that is safe. Nothing
   * renders it; {@link InvitationMailInput.orgName} is what a reader sees.
   */
  readonly orgId: string;
  readonly orgName: string;
  /** The membership role being offered, as T24's catalogue spells it. */
  readonly role: string;
  readonly to: string;
  /** The raw token. It reaches the link and nothing else — never the subject, never a log. */
  readonly token: string;
}

/**
 * "You have been invited to join {org}" (T29, success criterion 10).
 *
 * The only template in the set that interpolates values a stranger chose: an organisation name, an
 * inviter's display name and a role all originate with a user, and this mail is delivered to an
 * address that user typed in. `renderHtml` escapes every one of them — an organisation named
 * `<img src=x onerror=…>` has to reach the recipient as text.
 *
 * The subject carries the organisation name **unescaped**, because a subject header is not HTML and
 * `Acme &amp; Co` in a notification bar is a bug rather than a defence. `MailMessage.to` is a bare
 * address for the related reason: a rendered `Name <addr>` would be a header-injection surface.
 *
 * It deliberately does not say who else is in the organisation, or whether the address already has
 * a Forge account. T29 requires that inviting an existing member not become an enumeration oracle,
 * and the mail is the side of that which reaches a person.
 */
export function invitationMail(input: InvitationMailInput): MailMessage {
  const url = invitationUrl(input.appUrl, input.orgId, input.token);
  const invitation =
    input.invitedBy === undefined || input.invitedBy.trim().length === 0
      ? `You have been invited to join ${input.orgName} on Forge as ${input.role}.`
      : `${input.invitedBy} has invited you to join ${input.orgName} on Forge as ${input.role}.`;

  const body = {
    action: { label: 'Accept the invitation', url },
    closing: [
      `This invitation works once and expires in ${formatDuration(input.expiresInMinutes)}.`,
      'If you were not expecting it, you can ignore this message — no account of yours was changed.',
    ],
    heading: `Join ${input.orgName} on Forge`,
    paragraphs: [
      invitation,
      'Accepting adds you to the organisation. If you do not have a Forge account yet, you will be able to create one on the way in.',
    ],
  } as const;

  return {
    html: renderHtml(body),
    subject: `You have been invited to join ${input.orgName} on Forge`,
    template: 'invitation',
    text: renderText(body),
    to: input.to,
  };
}
