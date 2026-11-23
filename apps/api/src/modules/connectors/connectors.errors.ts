import type { ConnectorOpReason, ConnectorProvider, SyncFailureReason } from '@repo/contracts';

import {
  ConflictError,
  DomainError,
  NotFoundError,
  ServiceUnavailableError,
} from '../../common/errors/domain-error';
import type { GithubErrorCategory } from './github-fetch';

/** `Retry-After` for a provider refusal the breaker did not raise — GitHub named no window. */
export const RETRY_AFTER_SECONDS = 60;

/** Contract § 4: a refusal before enqueue — a 409 whose `reason` is the row's own vocabulary. */
export function syncConflict(reason: SyncFailureReason, detail: string): ConflictError {
  return new ConflictError(detail, { reason });
}

/** How each provider is named to a person (spec 030 research R3). */
export const PROVIDER_DISPLAY_NAMES: Readonly<Record<ConnectorProvider, string>> = {
  cloudflare: 'Cloudflare',
  github: 'GitHub',
  neon: 'Neon',
  netlify: 'Netlify',
  resend: 'Resend',
  supabase: 'Supabase',
};

/**
 * Contract § 4 (spec 030 contracts/bindings.md § 5): the circuit is open — a 503 with
 * `Retry-After` and `reason: provider-unavailable`, naming the provider.
 */
export function providerUnavailable(
  retryAfterSeconds: number,
  provider: ConnectorProvider = 'github',
): ServiceUnavailableError {
  return new ServiceUnavailableError(
    `${PROVIDER_DISPLAY_NAMES[provider]} is unavailable; try again later`,
    retryAfterSeconds,
    { reason: 'provider-unavailable' satisfies SyncFailureReason & ConnectorOpReason },
  );
}

/** Spec 030 contracts/bindings.md § 5: what each refusal reason is to a person. */
const REFUSAL_DETAIL: Readonly<Record<ConnectorOpReason, string>> = {
  'build-failed': 'The build this publish waited on failed.',
  disconnected: 'The organisation has no connection to this provider.',
  'in-flight': 'An operation of this kind is already running for this project.',
  'missing-scope': 'The credential is missing a permission this needs.',
  'needs-reauth': 'The connection needs to be reconnected.',
  'not-found': 'The provider no longer has that resource.',
  'provider-refused': 'The provider refused the request.',
  'provider-unavailable': 'The provider is unavailable; try again later.',
  'quota-exceeded': 'The provider account has reached its limit.',
  'rate-limited': 'The provider is rate limiting this account; try again later.',
  'record-conflict': 'A different DNS record already exists at that name.',
  removing: 'The connection is being removed.',
  'site-gone': 'The Netlify site no longer exists.',
  'timed-out': 'The provider did not finish in time.',
  'zone-not-found': 'No zone this token can see holds that domain.',
};

export interface ConnectorRefusalExtra {
  readonly detail?: string;
  readonly retryAfterSeconds?: number;
  readonly [extension: string]: unknown;
}

/**
 * Spec 030 contracts/bindings.md § 5: a connector refusal, in an **existing** slug with the
 * `CONNECTOR_OP_REASONS` word as the `reason` extension. No new problem slug. A refusal the
 * provider may lift on its own is a 503 with `Retry-After`; a credential short of a permission,
 * or a request the provider refused, is 422; a resource that is gone is 404; the rest are 409.
 */
export function connectorRefusal(
  reason: ConnectorOpReason,
  extra: ConnectorRefusalExtra = {},
): DomainError {
  const { detail = REFUSAL_DETAIL[reason], retryAfterSeconds, ...extensions } = extra;

  switch (reason) {
    case 'provider-unavailable':
    case 'rate-limited':
    case 'timed-out':
      return new ServiceUnavailableError(detail, retryAfterSeconds ?? RETRY_AFTER_SECONDS, {
        ...extensions,
        reason,
      });
    case 'missing-scope':
    case 'provider-refused':
      return new DomainError('validation-failed', detail, { ...extensions, reason });
    case 'not-found':
      return new NotFoundError(detail, { ...extensions, reason });
    default:
      return new ConflictError(detail, { ...extensions, reason });
  }
}

/**
 * A GitHub failure on a user-facing call (list, create, resolve), re-stated in the § 4
 * vocabulary: a refused credential is `needs-reauth`, anything else is the provider being
 * unavailable. The caller keeps the `validation` and `not-found` arms it has a better answer for.
 * `detail` replaces the message when the person must hear more than the category (spec 044: the
 * repository exists even though the step after it failed).
 */
export function githubRefusal(
  category: GithubErrorCategory,
  retryAfterSeconds: number,
  detail?: string,
): ConflictError | ServiceUnavailableError {
  if (category === 'unauthorized') {
    return syncConflict('needs-reauth', detail ?? 'The GitHub connection needs to be reconnected.');
  }

  return detail === undefined
    ? providerUnavailable(retryAfterSeconds)
    : new ServiceUnavailableError(detail, retryAfterSeconds, {
        reason: 'provider-unavailable' satisfies SyncFailureReason,
      });
}

/**
 * Spec 026 contracts § 2: the three refusals that stop an import before any row exists.
 *
 * Each carries the `reason` a failed `sync_operations` row would have carried, so a client reads
 * one vocabulary whether the import was refused at the door or failed on the worker — and each
 * gets its own slug, because "push a first commit", "import something smaller" and "pick another
 * branch" are three different things to ask of a person. They take the `RETRY_AFTER_SECONDS`
 * window from above where they need one rather than declaring a second one: there is one default
 * provider window in this module.
 */
export class ImportEmptyRepoError extends DomainError {
  constructor(branch: string) {
    super('import-empty-repo', `The branch ${branch} has no commits to import.`, {
      reason: 'empty-repo' satisfies SyncFailureReason,
    });
  }
}

/** The problem names the limit, because "too large" without a number is not actionable. */
export class ImportRepoTooLargeError extends DomainError {
  constructor(sizeKib: number, limitKib: number) {
    super(
      'import-repo-too-large',
      `That repository is ${String(sizeKib)} KiB; imports are limited to ${String(limitKib)} KiB.`,
      { limitKib, reason: 'repo-too-large' satisfies SyncFailureReason, sizeKib },
    );
  }
}

/** The branch inspect saw is gone by the time the import starts — a 404, not a conflict. */
export class ImportBranchNotFoundError extends DomainError {
  constructor(branch: string) {
    super('import-branch-not-found', `The branch ${branch} no longer exists on that repository.`, {
      reason: 'branch-not-found' satisfies SyncFailureReason,
    });
  }
}

/**
 * A GitHub failure met while inspecting or starting an import, re-stated exactly as
 * {@link githubRefusal} does it, with this module's single default `Retry-After` window.
 */
export function importGithubRefusal(
  category: GithubErrorCategory,
): ConflictError | ServiceUnavailableError {
  return githubRefusal(category, RETRY_AFTER_SECONDS);
}
