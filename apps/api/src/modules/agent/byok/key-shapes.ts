import type { LlmProviderName } from '../llm-provider.port';

/**
 * What each provider's key looks like (research R10). Provider knowledge, so it lives beside the
 * adapters rather than in the contract, which only carries the neutral length bounds. `sk-ant-` is
 * an `sk-` prefix, so an Anthropic key passes the `openai` shape — the verify call closes that.
 */
export const KEY_SHAPES: Record<LlmProviderName, RegExp> = {
  anthropic: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
  openai: /^sk-[A-Za-z0-9_-]{20,}$/,
};

export function hasShape(provider: LlmProviderName, key: string): boolean {
  return KEY_SHAPES[provider].test(key);
}

/** The `secrets.purpose` a provider's key is sealed under (data-model.md): bound into the AAD. */
export function purposeFor(provider: LlmProviderName): string {
  return `byok:${provider}:api-key`;
}
