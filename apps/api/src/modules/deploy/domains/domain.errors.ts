import type { DomainConflictReason } from '@repo/contracts';

import { ConflictError } from '../../../common/errors/domain-error';
import type { DOMAINS_PER_ORG, DOMAINS_PER_PROJECT } from './domain.constants';

const DETAIL: Record<DomainConflictReason, string> = {
  'apex-not-supported': 'Use a subdomain, such as www or app; a root domain cannot be added.',
  'domain-limit': 'This project or organisation already has the most domains it can have.',
  'domains-unavailable': 'Custom domains are not available right now.',
  // SC-011: fixed, and nothing else rides with it — it must not say where the hostname is held.
  'hostname-unavailable': 'That hostname is not available.',
  'invalid-hostname': 'That is not a valid hostname.',
  'not-deployable': "This project's template does not declare a build.",
  'not-retryable': 'Only a failed domain can be retried.',
  'project-archived': 'This project is archived.',
  'reserved-hostname': 'That hostname belongs to the platform.',
};

/**
 * A refusal before anything is written, following `deploy.errors.ts`. `domain-limit` carries the
 * `limit` that was reached (10 per project or 50 per org).
 */
export function domainConflict(
  reason: DomainConflictReason,
  extensions: { limit?: typeof DOMAINS_PER_ORG | typeof DOMAINS_PER_PROJECT } = {},
): ConflictError {
  return new ConflictError(DETAIL[reason], { ...extensions, reason });
}

/**
 * `domains_hostname_live_key` refused the insert: a live row already holds the hostname, in this
 * org or another (R9). The repository's typed answer; the service turns it into
 * `domainConflict('hostname-unavailable')`, whose fixed detail says nothing about the holder.
 */
export class HostnameHeld extends Error {
  constructor() {
    super('A live domain already holds this hostname.');
    this.name = 'HostnameHeld';
  }
}
