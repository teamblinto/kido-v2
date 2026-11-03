import { type ByosRefusalReason, LLM_PROVIDERS } from '@repo/contracts';

import {
  ConflictError,
  DomainError,
  NotFoundError,
  ServiceUnavailableError,
} from '../../../common/errors/domain-error';
import type { LlmProviderName } from '../llm-provider.port';
import type { ByosProviders } from './byos-providers';

/** `Retry-After` when the provider could not be reached during a link (contracts § 1). */
export const LINK_RETRY_AFTER_SECONDS = 30;

const NOT_OFFERED = 'No such provider.';

/**
 * `:provider` on every `/me/linked-accounts/:provider/*` route (spec 032 US1.1): a provider that is
 * not offered — unknown, not in force, or unconfigured — answers the same `404 not-found`.
 */
export async function assertOffered(
  providers: Pick<ByosProviders, 'offered'>,
  param: string,
): Promise<LlmProviderName> {
  if (!(LLM_PROVIDERS as readonly string[]).includes(param)) throw new NotFoundError(NOT_OFFERED);
  const provider = param as LlmProviderName;
  if (!(await providers.offered(provider))) throw new NotFoundError(NOT_OFFERED);
  return provider;
}

/** The link state was unknown, expired, spent, or someone else's (contracts § 1). */
export function stateInvalid(): DomainError {
  return new DomainError(
    'oauth-state-invalid',
    'This link attempt has expired or was already used. Start again from settings.',
  );
}

/**
 * Research R14: no new slug — each refusal is an existing one carrying `reason` from
 * `BYOS_REFUSAL_REASONS`, which the settings page maps to its sentence.
 */
export function byosRefusal(
  reason: Extract<ByosRefusalReason, 'denied' | 'exchange-refused' | 'provider-unavailable'>,
): DomainError {
  switch (reason) {
    case 'denied':
      return new DomainError('oauth-exchange-failed', 'The link was cancelled at the provider.', {
        reason,
      });
    case 'exchange-refused':
      return new DomainError('oauth-exchange-failed', 'The provider refused the link.', {
        reason,
      });
    case 'provider-unavailable':
      return new ServiceUnavailableError(
        'The provider could not be reached; try again shortly.',
        LINK_RETRY_AFTER_SECONDS,
        { reason },
      );
  }
}

/**
 * Run create's two BYOS refusals (contracts § 4): `409 conflict` with `reason` and `provider`,
 * never the account label or anything of the grant. `resetsAt` is ISO for the web to format.
 */
export function subscriptionRefusal(
  resolution:
    | { readonly kind: 'subscription-needs-reauth'; readonly provider: LlmProviderName }
    | {
        readonly kind: 'subscription-limited';
        readonly provider: LlmProviderName;
        readonly resetsAt: Date | null;
        readonly alternativeMode: 'BYOK' | null;
      },
): DomainError {
  if (resolution.kind === 'subscription-needs-reauth') {
    return new ConflictError('Your subscription needs reconnecting in Settings › Account.', {
      provider: resolution.provider,
      reason: resolution.kind,
    });
  }
  return new ConflictError('Your subscription is rate-limited.', {
    alternativeMode: resolution.alternativeMode,
    provider: resolution.provider,
    reason: resolution.kind,
    ...(resolution.resetsAt === null ? {} : { resetsAt: resolution.resetsAt.toISOString() }),
  });
}
