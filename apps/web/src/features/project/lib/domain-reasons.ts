import type {
  DomainConflictReason,
  DomainFailureReason,
  DomainRecord,
  DomainState,
} from '@repo/contracts';

import { ApiProblem, messageFor } from '@/lib/api/problem';

/**
 * Copy for every refusal reason (`DOMAIN_CONFLICT_REASONS` in `@repo/contracts`). Local to the domains panel on purpose, as `deploy-reasons.ts` is:
 * no problem slug is added, so no `MESSAGES` entry is either (research R13).
 */
export const DOMAIN_CONFLICT_COPY = {
  'apex-not-supported':
    'A root domain such as acme.com cannot point here. Use a subdomain, such as www.acme.com or app.acme.com.',
  'domain-limit': 'The most domains allowed has been reached. Remove one to add another.',
  'domains-unavailable': 'Custom domains are not available right now. Try again later.',
  'hostname-unavailable': 'That hostname is not available.',
  'invalid-hostname': 'That is not a valid hostname. Enter a name such as app.acme.com.',
  'not-deployable':
    'This project’s template has no static build, so there is nothing a domain could serve.',
  'not-retryable': 'Only a domain that failed can be retried.',
  'project-archived': 'This project is archived. Restore it to manage its domains.',
  'reserved-hostname': 'That hostname belongs to the platform and cannot be added.',
} as const satisfies Record<DomainConflictReason, string>;

/** `domain-limit` names which limit was reached through its `limit` extension. */
export const DOMAIN_LIMIT_COPY = {
  10: 'A project can have at most 10 domains. Remove one to add another.',
  50: 'An organisation can have at most 50 domains. Remove one to add another.',
} as const satisfies Record<10 | 50, string>;

/** Why a domain is `failed` — the most specific reason the checks found. */
export const DOMAIN_FAILURE_COPY = {
  'caa-blocked':
    'A CAA record on the domain does not allow the certificate authority to issue a certificate for it.',
  'certificate-failed': 'The certificate for this hostname could not be issued.',
  'ownership-not-found': 'The ownership TXT record was not found, or did not match.',
  'provider-refused': 'The edge provider refused this hostname.',
  'routing-not-found': 'The CNAME record was not found, or does not point here.',
  'verification-timeout': 'The records were not confirmed within 72 hours.',
} as const satisfies Record<DomainFailureReason, string>;

/** Each state's badge and the sentence under it. */
export const DOMAIN_STATE_COPY = {
  active: {
    description: 'Serving the project’s site over HTTPS.',
    label: 'Active',
    variant: 'success',
  },
  drifted: {
    description:
      'The records no longer point here, so the domain has stopped serving. Put them back to restore it.',
    label: 'Records changed',
    variant: 'warning',
  },
  failed: {
    description: 'Not verified. Fix the records and retry, or remove the domain.',
    label: 'Failed',
    variant: 'danger',
  },
  pending: {
    description:
      'Create the records below. The domain is checked automatically until they are found.',
    label: 'Verifying',
    variant: 'info',
  },
  removing: {
    description: 'Being removed. It no longer serves the site.',
    label: 'Removing',
    variant: 'muted',
  },
} as const satisfies Record<
  DomainState,
  {
    readonly description: string;
    readonly label: string;
    readonly variant: 'danger' | 'info' | 'muted' | 'success' | 'warning';
  }
>;

/** What the last check saw for one record. */
export const DOMAIN_RECORD_STATUS_COPY = {
  apex: 'Root domain',
  found: 'Found',
  mismatch: 'Wrong value',
  missing: 'Not found',
  unchecked: 'Not checked yet',
} as const satisfies Record<DomainRecord['status'], string>;

/** A record's purpose, as its copy button and its row name it. */
export const DOMAIN_RECORD_PURPOSE_COPY = {
  certificate: 'certificate',
  ownership: 'ownership',
  routing: 'routing',
} as const satisfies Record<DomainRecord['purpose'], string>;

/** A `429` on check now: when it can be asked for again. */
export function checkLimitedCopy(retryAfterSeconds: number): string {
  const seconds = Math.max(1, Math.ceil(retryAfterSeconds));

  return `Checked moments ago. You can check again in ${String(seconds)} second${seconds === 1 ? '' : 's'}.`;
}

export function isDomainConflictReason(value: unknown): value is DomainConflictReason {
  return typeof value === 'string' && Object.hasOwn(DOMAIN_CONFLICT_COPY, value);
}

/**
 * A refusal on any domain route, put into words: a `409`'s `reason` (with `domain-limit`'s
 * `limit`), a `429`'s `retryAfter`, and otherwise the generic slug copy.
 */
export function domainErrorCopy(error: unknown): string {
  if (ApiProblem.is(error, 'rate-limited')) {
    const retryAfter = error.detail?.retryAfter;

    return typeof retryAfter === 'number' ? checkLimitedCopy(retryAfter) : messageFor(error);
  }

  const reason = ApiProblem.is(error) ? error.detail?.reason : undefined;

  if (!isDomainConflictReason(reason)) {
    return messageFor(error);
  }

  if (reason === 'domain-limit') {
    const limit = ApiProblem.is(error) ? error.detail?.limit : undefined;

    if (limit === 10 || limit === 50) {
      return DOMAIN_LIMIT_COPY[limit];
    }
  }

  return DOMAIN_CONFLICT_COPY[reason];
}
