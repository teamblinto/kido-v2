import type { MailMessage } from '../mailer.port';
import { type DomainNoticeMailInput, cnameInstruction, domainNotice } from './domain-notice';

export type DomainReleasedMailInput = DomainNoticeMailInput;

/**
 * "{hostname} has been released from {project}" (spec 028 FR-022, FR-023): sent when a domain
 * drifted for 30 days has been deregistered and its hostname freed.
 */
export function domainReleasedMail(input: DomainReleasedMailInput): MailMessage {
  return domainNotice(
    'domain-released',
    input,
    `${input.hostname} has been released from ${input.projectName}`,
    {
      closing: [
        'You are receiving this because you are an owner of the organisation or added this domain.',
      ],
      heading: `${input.hostname} has been released`,
      paragraphs: [
        `${input.hostname} did not point at ${input.projectName} for 30 days, so it has been released from the project. It no longer serves the site, and its certificate and routing have been removed.`,
        `To use it again, add it again from the Domains panel and create the records it shows. ${cnameInstruction(input)}`,
      ],
    },
  );
}
