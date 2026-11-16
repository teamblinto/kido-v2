import Anthropic from '@anthropic-ai/sdk';
import { Inject, Injectable, Optional } from '@nestjs/common';

import { ANTHROPIC_TRANSPORT, type AnthropicTransport, MAX_OUTPUT_TOKENS } from './agent.constants';
import type {
  ConversationMessage,
  CredentialContext,
  KeyCheck,
  KeyVerifier,
  LlmClient,
  LlmProvider,
  ModelRequest,
  ModelTurn,
  PromptAttachment,
} from './llm-provider.port';
import { renderAttachment } from './prompt';
import { classify, ProviderError } from './provider-error';
import { toInputSchema } from './tool-schema';

/**
 * `LlmProvider` over `@anthropic-ai/sdk` (contracts/llm-provider.md, research R1/R2, ADR 034) — the
 * one file in the tree that imports the SDK. A client is built per `client()` call from the
 * credential it is given, with the SDK's retries off so FR-022's loop is the only one; the request
 * is `system` (cached block, then 021's map cached and excerpts uncached, empty blocks omitted),
 * `tools` (eager input streaming) and `messages`, nothing else.
 */
@Injectable()
export class AnthropicProvider implements LlmProvider, KeyVerifier {
  constructor(
    @Optional() @Inject(ANTHROPIC_TRANSPORT) private readonly transport: AnthropicTransport = {},
  ) {}

  /**
   * Pinned, not left to the SDK's defaults: those read `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`
   * from the environment, which `environment.ts` never declares (FR-024). Retries off: FR-022's
   * loop is the only one, and a key check is one request.
   */
  private sdk(apiKey: string): Anthropic {
    return new Anthropic({
      apiKey,
      authToken: null,
      maxRetries: 0,
      fetch: this.transport.fetch ?? globalThis.fetch,
      baseURL: this.transport.baseURL ?? 'https://api.anthropic.com',
    });
  }

  /**
   * 032 R9: a linked subscription's access token is a bearer (`authToken`), never `x-api-key`
   * (`apiKey: null`), sent to the profile's base URL with its headers. The endpoint comes from the
   * credential, not the transport: a subscription is a different host than the platform's key.
   */
  private sdkFor(credential: CredentialContext): Anthropic {
    if (credential.mode !== 'BYOS') return this.sdk(credential.apiKey);
    const { endpoint } = credential;
    if (endpoint === undefined) throw new Error('A BYOS credential carries no endpoint.');
    return new Anthropic({
      apiKey: null,
      authToken: credential.apiKey,
      baseURL: endpoint.baseURL,
      defaultHeaders: endpoint.headers,
      maxRetries: 0,
      fetch: this.transport.fetch ?? globalThis.fetch,
    });
  }

  /** 020 R4: `GET /v1/models?limit=1` — the cheapest authenticated call, no tokens spent. */
  async verify(apiKey: string): Promise<KeyCheck> {
    return check(() => this.sdk(apiKey).models.list({ limit: 1 }));
  }

  /** 032 R9: the same check in bearer form, against the subscription's endpoint. */
  async verifyBearer(credential: CredentialContext): Promise<KeyCheck> {
    return check(() => this.sdkFor(credential).models.list({ limit: 1 }));
  }

  client(credential: CredentialContext, model: string): LlmClient {
    const client = this.sdkFor(credential);

    return {
      complete: async (request, hooks) => {
        const { signal } = hooks;
        const stream = client.messages.stream(
          {
            model,
            max_tokens: MAX_OUTPUT_TOKENS,
            system: toSystemBlocks(request),
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: toInputSchema(tool.inputSchema) as Anthropic.Tool.InputSchema,
              eager_input_streaming: true,
            })),
            messages: request.messages.map(toMessageParam),
          },
          { signal },
        );
        stream.on('text', (text) => hooks.onDelta({ kind: 'text', text }));

        try {
          for await (const event of stream) {
            // ponytail: the default display is `omitted`, so thinking arrives as empty deltas and
            // nothing is forwarded; `thinking: { type: 'adaptive', display: 'summarized' }` is the
            // upgrade when the console wants reasoning (research R2).
            if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') {
              if (event.delta.thinking !== '')
                hooks.onDelta({ kind: 'thinking', text: event.delta.thinking });
            }
          }
          return toTurn(await stream.finalMessage());
        } catch (error) {
          // The SDK answers an abort with its own `APIUserAbortError`; the port promises the
          // signal's reason so the executor can tell a cancel or a fence from a failure.
          if (signal.aborted) throw signal.reason;
          throw withRateLimitReset(classify(error), error, Date.now());
        }
      },
    };
  }
}

async function check(call: () => Promise<unknown>): Promise<KeyCheck> {
  try {
    await call();
    return 'ok';
  } catch (error) {
    return classify(error).class === 'unauthorised' ? 'rejected' : 'unreachable';
  }
}

/** 021 R5: `[system{cache}, map{cache}, excerpts]` — two breakpoints, empty blocks omitted. */
function toSystemBlocks(request: ModelRequest): Anthropic.TextBlockParam[] {
  const cached = { type: 'ephemeral' } as const;
  const { map = '', excerpts = '' } = request.context ?? {};
  return [
    { type: 'text', text: request.system, cache_control: cached },
    ...(map !== '' ? [{ type: 'text' as const, text: map, cache_control: cached }] : []),
    ...(excerpts !== '' ? [{ type: 'text' as const, text: excerpts }] : []),
  ];
}

function toMessageParam(message: ConversationMessage): Anthropic.MessageParam {
  switch (message.role) {
    case 'user':
      // A message without files stays a plain string, so its request bytes (and cache) are as before.
      if (message.attachments === undefined || message.attachments.length === 0) {
        return { role: 'user', content: message.content };
      }
      return {
        role: 'user',
        content: [
          ...message.attachments.flatMap(toAttachmentBlocks),
          // The API refuses an empty text block; a message may be files alone.
          ...(message.content !== ''
            ? [{ type: 'text', text: message.content } satisfies Anthropic.TextBlockParam]
            : []),
        ],
      };
    case 'assistant':
      return {
        role: 'assistant',
        content: [
          ...(message.text !== undefined
            ? [{ type: 'text', text: message.text } satisfies Anthropic.TextBlockParam]
            : []),
          ...message.toolCalls.map((call): Anthropic.ToolUseBlockParam => ({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: call.input,
          })),
        ],
      };
    case 'tool':
      return {
        role: 'user',
        content: message.results.map((result): Anthropic.ToolResultBlockParam => ({
          type: 'tool_result',
          tool_use_id: result.toolUseId,
          content: result.content,
          is_error: result.isError,
        })),
      };
  }
}

/**
 * Spec 048: an image or PDF with bytes goes as its native block, then (every kind) its text form —
 * for an image or PDF the tag naming its workspace path, for the rest the extracted text.
 */
function toAttachmentBlocks(attachment: PromptAttachment): Anthropic.ContentBlockParam[] {
  const text: Anthropic.TextBlockParam = { type: 'text', text: renderAttachment(attachment) };
  const { data, kind, mimeType } = attachment;
  if (data === undefined) return [text];
  if (kind === 'image') {
    const image: Anthropic.ImageBlockParam = {
      type: 'image',
      source: {
        type: 'base64',
        // The upload allowlist admits only these four raster types as `image`.
        media_type: mimeType as Anthropic.Base64ImageSource['media_type'],
        data: data.toString('base64'),
      },
    };
    return [image, text];
  }
  if (kind === 'pdf') {
    const document: Anthropic.DocumentBlockParam = {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: data.toString('base64') },
    };
    return [document, text];
  }
  return [text];
}

function toTurn(message: Anthropic.Message): ModelTurn {
  const stop = message.stop_reason;
  // A refused turn is classified here so no caller can run its tools (contracts/llm-provider.md
  // rule 8); a stop the port does not name is a response we cannot read.
  if (stop === 'refusal') throw new ProviderError('refused');
  if (stop !== 'end_turn' && stop !== 'tool_use' && stop !== 'max_tokens') {
    throw new ProviderError('malformed-response');
  }
  const { usage } = message;
  return {
    text: message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join(''),
    toolCalls: message.content
      .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
      .map((block) => ({ id: block.id, name: block.name, input: block.input })),
    stop,
    usage: {
      // 021 R6: uncached input and the two cache counts kept apart; RunStore.addUsage sums them.
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    },
  };
}

const LIMITS = ['requests', 'tokens', 'input-tokens', 'output-tokens'];

/**
 * 032 T057: a 429 that sent no `retry-after` still names when its limits refill, as RFC 3339
 * instants in `anthropic-ratelimit-*-reset`. The wait is the exhausted limit's reset (its
 * `-remaining` is `0`); when none says so, the latest, since until then the limit that tripped may
 * not have refilled. A past or unreadable instant is no wait at all.
 */
export function withRateLimitReset(
  classified: ProviderError,
  error: unknown,
  nowMs: number,
): ProviderError {
  if (classified.class !== 'rate-limited' || classified.retryAfterMs !== undefined) {
    return classified;
  }
  const headers = (error as { headers?: { get(name: string): string | null } }).headers;
  const exhausted = LIMITS.filter(
    (limit) => headers?.get(`anthropic-ratelimit-${limit}-remaining`) === '0',
  );
  const waits = (exhausted.length > 0 ? exhausted : LIMITS)
    .map((limit) => Date.parse(headers?.get(`anthropic-ratelimit-${limit}-reset`) ?? '') - nowMs)
    .filter((ms) => ms > 0);
  if (waits.length === 0) return classified;
  return new ProviderError('rate-limited', {
    requestId: classified.requestId,
    retryAfterMs: Math.max(...waits),
    status: classified.status,
  });
}
