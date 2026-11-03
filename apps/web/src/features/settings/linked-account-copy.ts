import { BYOS_REFUSAL_REASONS, type ByosRefusalReason } from '@repo/contracts';

import { ApiProblem, messageFor } from '@/lib/api/problem';

/** Contracts § 1/§ 4's refusal vocabulary as copy. Local on purpose: no new slug (research R14). */
const REASON_COPY: Record<ByosRefusalReason, (provider: string) => string> = {
  denied: (provider) => `${provider} did not authorise the connection.`,
  'exchange-refused': (provider) => `${provider} refused the connection. Please try again.`,
  'provider-unavailable': (provider) => `${provider} could not be reached. Try again shortly.`,
  'subscription-limited': (provider) =>
    `Your ${provider} subscription has reached its usage limit.`,
  'subscription-needs-reauth': (provider) =>
    `Your ${provider} account needs reconnecting before it can be used.`,
};

function isReason(value: unknown): value is ByosRefusalReason {
  return typeof value === 'string' && (BYOS_REFUSAL_REASONS as readonly string[]).includes(value);
}

export function linkErrorCopy(error: unknown, provider: string): string {
  const reason = ApiProblem.is(error) ? error.detail?.reason : undefined;

  return isReason(reason) ? REASON_COPY[reason](provider) : messageFor(error);
}

/**
 * A run-create refusal carrying a BYOS `reason` (contracts § 4) as its sentence, naming the
 * provider from the problem's `provider`; `undefined` for any other failure, so the caller falls
 * back to the shared catalogue. Without it a `409 subscription-needs-reauth` read as the generic
 * `conflict` sentence (found by the T064 walk).
 */
export function byosRefusalCopy(error: unknown): string | undefined {
  if (!ApiProblem.is(error)) return undefined;
  const detail = error.detail as { reason?: unknown; provider?: unknown } | undefined;
  if (!isReason(detail?.reason)) return undefined;

  return REASON_COPY[detail.reason](detail.provider === 'openai' ? 'OpenAI' : 'Claude');
}
