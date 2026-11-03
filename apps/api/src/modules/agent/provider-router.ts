import { Injectable } from '@nestjs/common';

import { AnthropicProvider } from './anthropic.adapter';
import type {
  CredentialContext,
  LlmClient,
  LlmProvider,
  LlmProviderName,
} from './llm-provider.port';
import { OpenAiProvider } from './openai.adapter';
import { ProviderError } from './provider-error';

/**
 * `LLM_PROVIDER` (020 R2): dispatches `client()` on `credential.provider`, passing the credential
 * and model through untouched. A provider with no adapter is `no-credential` — the executor
 * reports it as the run's `credential` failure rather than a crash.
 */
@Injectable()
export class ProviderRouter implements LlmProvider {
  private readonly adapters: Record<LlmProviderName, LlmProvider>;

  constructor(anthropic: AnthropicProvider, openai: OpenAiProvider) {
    this.adapters = { anthropic, openai };
  }

  client(credential: CredentialContext, model: string): LlmClient {
    const adapter = this.adapters[credential.provider] as LlmProvider | undefined;
    if (adapter === undefined) throw new ProviderError('no-credential');
    return adapter.client(credential, model);
  }
}
