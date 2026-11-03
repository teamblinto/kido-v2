import type { CredentialContext, LlmProviderName } from '../llm-provider.port';
import type { RunOutcome } from '../run-executor.port';

const DISPLAY_NAMES: Record<LlmProviderName, string> = { anthropic: 'Anthropic', openai: 'OpenAI' };

/**
 * Research R7: the `credential` failure class and its two sentences — the provider by display
 * name and the key by its last four, never anything the provider said. What `chat-panel.tsx`
 * renders as `state.reason`.
 */
export function credentialFailed(
  failure: 'unauthorised' | 'rate-limited',
  credential: Pick<CredentialContext, 'provider' | 'keyLastFour'> &
    Partial<Pick<CredentialContext, 'mode' | 'accountLabel'>>,
  detail: { readonly resetsAt?: Date } = {},
): RunOutcome {
  if (credential.mode === 'BYOS') return subscriptionFailed(failure, credential, detail);

  const key = `the organisation's key ending ${credential.keyLastFour ?? '????'}`;
  const provider = DISPLAY_NAMES[credential.provider];

  return {
    failureClass: 'credential',
    kind: 'failed',
    reason:
      failure === 'unauthorised'
        ? `${provider} rejected ${key} — an admin must replace or remove it in Settings › Connectors`
        : `${provider} is rate-limiting ${key} — the run can be retried; check the key's quota`,
  };
}

/**
 * 032 R10/R11: a person's own subscription — "your <Provider> account (<label>)", never the
 * organisation and never the provider's words. The reset rides as ISO; the web formats it (T047).
 */
function subscriptionFailed(
  failure: 'unauthorised' | 'rate-limited',
  credential: Pick<CredentialContext, 'provider' | 'accountLabel'>,
  detail: { readonly resetsAt?: Date },
): RunOutcome {
  const account = `Your ${DISPLAY_NAMES[credential.provider]} account (${credential.accountLabel ?? 'linked'})`;
  const reason =
    failure === 'unauthorised'
      ? `${account} needs reconnecting in Settings › Account`
      : detail.resetsAt === undefined
        ? `${account} is rate-limited — try again later`
        : `${account} is rate-limited until ${detail.resetsAt.toISOString()}`;

  return {
    failureClass: 'credential',
    kind: 'failed',
    reason,
    ...(failure === 'rate-limited' && detail.resetsAt !== undefined
      ? { resetsAt: detail.resetsAt }
      : {}),
  };
}
