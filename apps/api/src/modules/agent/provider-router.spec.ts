import { describe, expect, it, vi } from 'vitest';

import type { AnthropicProvider } from './anthropic.adapter';
import type { CredentialContext, LlmClient } from './llm-provider.port';
import type { OpenAiProvider } from './openai.adapter';
import { ProviderError } from './provider-error';
import { ProviderRouter } from './provider-router';

/** The router only dispatches: each adapter is a `client()` stub returning its own marker. */
function harness() {
  const anthropicClient = {} as LlmClient;
  const openaiClient = {} as LlmClient;
  const anthropic = { client: vi.fn(() => anthropicClient) };
  const openai = { client: vi.fn(() => openaiClient) };
  const router = new ProviderRouter(
    anthropic as unknown as AnthropicProvider,
    openai as unknown as OpenAiProvider,
  );
  return { anthropic, anthropicClient, openai, openaiClient, router };
}

describe('ProviderRouter', () => {
  it("routes 'anthropic' to the Anthropic provider, credential and model untouched", () => {
    const { anthropic, anthropicClient, openai, router } = harness();
    const credential: CredentialContext = { mode: 'BYOK', provider: 'anthropic', apiKey: 'k' };

    expect(router.client(credential, 'claude-x')).toBe(anthropicClient);
    expect(anthropic.client).toHaveBeenCalledWith(credential, 'claude-x');
    expect(openai.client).not.toHaveBeenCalled();
  });

  it("routes 'openai' to the OpenAI provider, credential and model untouched", () => {
    const { anthropic, openai, openaiClient, router } = harness();
    const credential: CredentialContext = {
      mode: 'BYOK',
      provider: 'openai',
      apiKey: 'k',
      keyLastFour: '1234',
    };

    expect(router.client(credential, 'gpt-x')).toBe(openaiClient);
    expect(openai.client).toHaveBeenCalledWith(credential, 'gpt-x');
    expect(anthropic.client).not.toHaveBeenCalled();
  });

  it("throws ProviderError('no-credential') for a provider it has no adapter for", () => {
    const { router } = harness();
    const credential = {
      mode: 'BYOK',
      provider: 'mistral',
      apiKey: 'k',
    } as unknown as CredentialContext;

    expect(() => router.client(credential, 'm')).toThrow(ProviderError);
    expect(() => router.client(credential, 'm')).toThrow(
      expect.objectContaining({ class: 'no-credential' }),
    );
  });
});
