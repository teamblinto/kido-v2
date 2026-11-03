import type { MailMessage } from '../mailer.port';
import { type DomainNoticeMailInput, cnameInstruction, days, domainNotice } from './domain-notice';

export interface DomainReleaseWarningMailInput extends DomainNoticeMailInput {
  /** Whole days until the release, computed by the caller from `drifted_at` (a week at 23 days). */
  readonly releaseInDays: number;
}

/**
 * "{hostname} will be released from {project} in 7 days" (spec 028 FR-022, US3): the one warning
 * before a domain drifted for 30 days is released. `release_warned_at` stops a repeat.
 */
export function domainReleaseWarningMail(input: DomainReleaseWarningMailInput): MailMessage {
  const left = days(input.releaseInDays);

  return domainNotice(
    'domain-release-warning',
    input,
    `${input.hostname} will be released from ${input.projectName} in ${left}`,
    {
      closing: [
        'You are receiving this because you are an owner of the organisation or added this domain.',
      ],
      heading: `${input.hostname} will be released in ${left}`,
      paragraphs: [
        `${input.hostname} has not pointed at ${input.projectName} for more than three weeks. It will be released from the project in ${left}, and its certificate and routing will be removed.`,
        `${cnameInstruction(input)} The domain returns to active at the first check that passes, and nothing is released.`,
      ],
    },
  );
}
