import type { CatalogueModel, LlmProvider } from '@repo/contracts';

import { ApiProblem } from '@/lib/api/problem';

/** A person's own subscription at its usage limit (spec 032 US6, research A3). */
export interface SubscriptionLimit {
  readonly provider: LlmProvider;
  /** ISO; absent when the provider gave no reset. */
  readonly resetsAt?: string;
  /**
   * The organisation's API key, which `credential: 'organisation'` would use instead. Absent when
   * the organisation holds none: platform credits are retired, so there is then no fallback.
   */
  readonly alternativeMode?: 'BYOK';
}

const PROVIDER_LABEL: Record<LlmProvider, string> = { anthropic: 'Claude', openai: 'OpenAI' };

/** The catalogue entry's limit, when the selected model is on a limited subscription. */
export function limitOfModel(model: CatalogueModel | undefined): SubscriptionLimit | undefined {
  if (model?.limitedUntil === undefined) return undefined;
  return {
    provider: model.provider,
    resetsAt: model.limitedUntil,
    ...(model.alternativeMode === undefined ? {} : { alternativeMode: model.alternativeMode }),
  };
}

/** A `409 conflict` run create refused with `reason: 'subscription-limited'` (contracts § 4). */
export function limitOfRefusal(error: unknown): SubscriptionLimit | undefined {
  if (!ApiProblem.is(error, 'conflict')) return undefined;
  const detail = error.detail as
    | { reason?: unknown; provider?: unknown; resetsAt?: unknown; alternativeMode?: unknown }
    | undefined;
  if (detail?.reason !== 'subscription-limited') return undefined;
  if (detail.provider !== 'anthropic' && detail.provider !== 'openai') return undefined;
  return {
    provider: detail.provider,
    ...(typeof detail.resetsAt === 'string' ? { resetsAt: detail.resetsAt } : {}),
    ...(detail.alternativeMode === 'BYOK' ? { alternativeMode: detail.alternativeMode } : {}),
  };
}

/** Hour and minute in the viewer's locale and zone, with the date when it is not today. */
export function formatLocalTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const sameDay = at.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    ...(sameDay ? {} : { day: 'numeric', month: 'short' }),
  }).format(at);
}

/** "Your Claude subscription is limited until 09:22". */
export function limitSentence(limit: SubscriptionLimit, now: Date = new Date()): string {
  const base = `Your ${PROVIDER_LABEL[limit.provider]} subscription is limited`;
  return limit.resetsAt === undefined
    ? `${base} — try again later`
    : `${base} until ${formatLocalTime(limit.resetsAt, now)}`;
}

/**
 * A subscription limit's reset (spec 032 T047) in the viewer's own locale and time zone. The
 * server's reason carries the instant as ISO; it is replaced by the local time, or the local time
 * is appended when the reason does not name it.
 */
export function stateReason(
  data: { readonly reason?: string; readonly resetsAt?: string },
  now: Date = new Date(),
): string | undefined {
  if (data.reason === undefined || data.resetsAt === undefined) return data.reason;
  const local = formatLocalTime(data.resetsAt, now);
  return data.reason.includes(data.resetsAt)
    ? data.reason.replace(data.resetsAt, local)
    : `${data.reason} (until ${local})`;
}

export const RUN_ON_ORGANISATION = "Run on the organisation's credential this time";
