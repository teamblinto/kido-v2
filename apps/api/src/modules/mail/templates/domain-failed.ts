import type { DomainFailureReason } from '@repo/contracts';

import type { MailMessage } from '../mailer.port';
import { type DomainNoticeMailInput, cnameInstruction, domainNotice } from './domain-notice';

export interface DomainFailedMailInput extends DomainNoticeMailInput {
  /** The blocking CAA zone and the record to add there, from `last_check.caa` when `blocked`. */
  readonly caa?: { readonly record: string; readonly zone: string };
  /** The provider's refusal text (`last_check.edgeMessage`), quoted for `provider-refused`. */
  readonly edgeMessage?: string | null;
  readonly reason: DomainFailureReason;
}

/**
 * One sentence per failure reason, each naming the fix (spec 028 US4). Exhaustive over the
 * contract's closed set, so a new reason does not compile until it has one.
 */
function fixFor(input: DomainFailedMailInput): string {
  const { hostname } = input;

  switch (input.reason) {
    case 'caa-blocked':
      return input.caa === undefined
        ? `A CAA record on ${hostname} or a parent domain does not allow our certificate authority to issue a certificate. Add a CAA record allowing letsencrypt.org, as shown in the Domains panel, or remove the one that blocks it.`
        : `A CAA record on ${input.caa.zone} does not allow our certificate authority to issue a certificate. Add the CAA record ${input.caa.record} to ${input.caa.zone}, or remove the one that blocks it.`;
    case 'certificate-failed':
      return `A certificate for ${hostname} could not be issued. ${cnameInstruction(input)} Also check that no CAA record blocks our certificate authority.`;
    case 'ownership-not-found':
      return `The ownership record was not found. Add the TXT record _forge-challenge.${hostname} with the value shown in the Domains panel.`;
    case 'provider-refused':
      return `Our edge provider refused ${hostname}. Check that it is a hostname you control and that it is not already connected to another service.`;
    case 'routing-not-found':
      return input.target === undefined
        ? `The routing record was not found. Add a CNAME record for ${hostname} pointing at the target shown in the Domains panel.`
        : `The routing record was not found. Add a CNAME record for ${hostname} pointing at ${input.target}.`;
    case 'verification-timeout':
      return `Its records were not confirmed within 72 hours. Check that the TXT and CNAME records shown in the Domains panel exist exactly as shown.`;
  }
}

/**
 * "{hostname} could not be connected to {project}" (spec 028 FR-022, US4): sent once when a domain
 * ends `failed`, directly or after deregistration. Retry starts a new window with a new token.
 */
export function domainFailedMail(input: DomainFailedMailInput): MailMessage {
  const refusal =
    input.reason === 'provider-refused' &&
    input.edgeMessage !== undefined &&
    input.edgeMessage !== null &&
    input.edgeMessage.trim().length > 0
      ? [`The provider said: “${input.edgeMessage}”`]
      : [];

  return domainNotice(
    'domain-failed',
    input,
    `${input.hostname} could not be connected to ${input.projectName}`,
    {
      closing: [
        'You are receiving this because you are an owner of the organisation or added this domain.',
      ],
      heading: `${input.hostname} could not be connected`,
      paragraphs: [
        `${input.hostname} could not be connected to ${input.projectName}, and it is not serving the site.`,
        fixFor(input),
        ...refusal,
        'Once that is done, retry from the Domains panel. A retry starts a new 72-hour window.',
      ],
    },
  );
}
