import type { MailMessage } from '../mailer.port';
import { type DomainNoticeMailInput, cnameInstruction, domainNotice } from './domain-notice';

export type DomainDriftedMailInput = DomainNoticeMailInput;

/**
 * "{hostname} no longer points at {project}" (spec 028 FR-022, US3): sent once when an `active`
 * domain fails its third consecutive check and becomes `drifted`. It keeps serving while drifted,
 * so the mail says what to fix before the certificate cannot renew, and when it will be released.
 */
export function domainDriftedMail(input: DomainDriftedMailInput): MailMessage {
  return domainNotice(
    'domain-drifted',
    input,
    `${input.hostname} no longer points at ${input.projectName}`,
    {
      closing: [
        'You are receiving this because you are an owner of the organisation or added this domain.',
      ],
      heading: `${input.hostname} no longer points at ${input.projectName}`,
      paragraphs: [
        `The last three checks of ${input.hostname}, connected to ${input.projectName}, could not confirm its DNS records. The domain is still served for now, but its certificate cannot renew until this is fixed.`,
        `${cnameInstruction(input)} Also check that no CAA record on ${input.hostname} or its parent domains blocks our certificate authority.`,
        'It returns to active at the first check that passes. If it is not fixed within 30 days, the domain will be released from the project.',
      ],
    },
  );
}
