/**
 * The port between the executor and one model call (contracts/llm-provider.md).
 *
 * `AnthropicProvider` is the only implementation this feature ships (`anthropic.adapter.ts`, the
 * one file that imports `@anthropic-ai/sdk`); `ScriptedProvider` (`test/support/`) is the fake
 * every other spec drives against. `client()` builds a fresh client per run from `credential` —
 * the provider itself holds no key and no cache (FR-016).
 */

import type { LlmProvider as LlmProviderName } from '@repo/contracts';

export { LLM_PROVIDER } from './agent.constants';
export type { LlmProviderName };

/**
 * One run's credential (020 R2): the router dispatches on `provider`; the adapters read `apiKey`.
 *
 * 032 R9: `BYOS` is a person's linked subscription. `apiKey` then holds the access token, which
 * the adapter sends as a bearer (never as `x-api-key`) to `endpoint.baseURL` with
 * `endpoint.headers`; `expiresAt` tells the executor when to ask for a fresh one.
 */
export interface CredentialContext {
  // Platform credits are retired: the organisation's key or a person's own subscription pays.
  // `PLATFORM` survives only on the `credential_mode` enum, so runs paid with credits still read.
  readonly mode: 'BYOK' | 'BYOS';
  readonly provider: LlmProviderName;
  readonly apiKey: string;
  /** BYOK only: named in the `credential` failure reason, never the key itself. */
  readonly keyLastFour?: string;
  /** BYOS only: the linked account's label, named in the failure sentence. */
  readonly accountLabel?: string;
  /** BYOS only: when the access token expires. */
  readonly expiresAt?: Date;
  /** BYOS only: the subscription profile the provider's sheet names (R13). */
  readonly endpoint?: {
    readonly baseURL: string;
    readonly headers: Readonly<Record<string, string>>;
  };
}

/** 020 R4: the provider's cheapest authenticated call — costs no tokens, changes nothing. */
export type KeyCheck = 'ok' | 'rejected' | 'unreachable';

/** Beside `LlmProvider`, not part of it: each adapter implements both, the router only the first. */
export interface KeyVerifier {
  verify(apiKey: string): Promise<KeyCheck>;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** R7's provider-neutral rebuild of a `run_messages` row into the shape a request sends. */
export type ConversationMessage =
  | { readonly role: 'user'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly text?: string;
      readonly toolCalls: readonly { id: string; name: string; input: unknown }[];
    }
  | {
      readonly role: 'tool';
      readonly results: readonly { toolUseId: string; content: string; isError: boolean }[];
    };

export interface ModelRequest {
  /** The versioned system prompt, cached as one block by the adapter. */
  readonly system: string;
  readonly tools: readonly ToolDefinition[];
  readonly messages: readonly ConversationMessage[];
  /**
   * 021 R5: two blocks between the tools and the conversation; the adapter places the cache
   * breakpoints (Anthropic: `system` and `map` each cached; OpenAI: concatenated into
   * `instructions`, prefix-cached). Empty blocks are omitted. `excerpts` is '' until the
   * retrieval follow-up.
   */
  readonly context?: { readonly map: string; readonly excerpts: string };
}

export type Delta = { kind: 'text'; text: string } | { kind: 'thinking'; text: string };

export interface ModelTurn {
  readonly text: string;
  readonly toolCalls: readonly { id: string; name: string; input: unknown }[];
  readonly stop: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';
  /** 021 R6: cache reads and writes counted apart from `inputTokens`; 0 when the provider reports none. */
  readonly usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
}

export interface LlmClient {
  /** One streamed model call. Text/thinking deltas via `onDelta`; resolves the whole turn. */
  complete(
    request: ModelRequest,
    hooks: { onDelta(delta: Delta): void; readonly signal: AbortSignal },
  ): Promise<ModelTurn>;
}

export interface LlmProvider {
  /** Per run (FR-016): a client for one credential and one model, discarded by the caller. */
  client(credential: CredentialContext, model: string): LlmClient;
}
