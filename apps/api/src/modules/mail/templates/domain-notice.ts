import type { MailMessage, MailTemplateId } from '../mailer.port';
import { type MailBody, renderHtml, renderText } from './layout';
import { projectDomainsUrl } from './links';

/**
 * What every custom-domain notice is rendered from (spec 028 research R14). The consumer reads the
 * row, the project and the recipient's address at send time and passes them in; the mail module
 * never reads a table or configuration.
 */
export interface DomainNoticeMailInput {
  /** `APP_URL`. */
  readonly appUrl: string;
  /** The normalised ASCII hostname. Escaped like any other value: the template does not trust it. */
  readonly hostname: string;
  readonly projectId: string;
  /** A member-chosen name, so escaped in the html part and left raw in the subject. */
  readonly projectName: string;
  /**
   * `CUSTOM_HOSTNAME_TARGET`, the name a hostname's CNAME points at. Absent when the edge is not
   * configured; the mail then points at the Domains panel, which shows the record, instead.
   */
  readonly target?: string;
  readonly to: string;
}

/** The one routing instruction the notices share, with or without a configured target. */
export function cnameInstruction(input: DomainNoticeMailInput): string {
  return input.target === undefined
    ? `Make sure the CNAME record for ${input.hostname} points at the target shown in the Domains panel.`
    : `Make sure the CNAME record for ${input.hostname} points at ${input.target}.`;
}

/** "7 days", "1 day". */
export function days(count: number): string {
  return `${count} day${count === 1 ? '' : 's'}`;
}

/**
 * Renders a notice. The subject is passed through untouched: a subject header is not HTML, and
 * `Acme &amp; Co` in a notification bar is a bug rather than a defence (as `invitation.ts` argues).
 */
export function domainNotice(
  template: MailTemplateId,
  input: DomainNoticeMailInput,
  subject: string,
  body: Omit<MailBody, 'action'>,
): MailMessage {
  const content: MailBody = {
    ...body,
    action: {
      label: 'Open the Domains panel',
      url: projectDomainsUrl(input.appUrl, input.projectId),
    },
  };

  return {
    html: renderHtml(content),
    subject,
    template,
    text: renderText(content),
    to: input.to,
  };
}
