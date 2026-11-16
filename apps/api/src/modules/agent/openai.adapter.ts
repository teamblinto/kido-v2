import { Inject, Injectable, Optional } from '@nestjs/common';
import OpenAI from 'openai';

import { MAX_OUTPUT_TOKENS, OPENAI_TRANSPORT, type OpenAiTransport } from './agent.constants';
import type {
  ConversationMessage,
  CredentialContext,
  KeyCheck,
  KeyVerifier,
  LlmClient,
  LlmProvider,
  ModelTurn,
  PromptAttachment,
} from './llm-provider.port';
import { renderAttachment } from './prompt';
import { classify, ProviderError } from './provider-error';
import { toInputSchema } from './tool-schema';

/**
 * `LlmProvider` over `openai` (020 research R3) — the one file in the tree that imports the SDK.
 * The Anthropic adapter's shape: a client per `client()` call, the SDK's retries off, the
 * conversation rebuilt whole per request (`store: false`, no `previous_response_id`) through the
 * Responses API. `verify()` is the key check of R4: the cheapest authenticated call.
 */
@Injectable()
export class OpenAiProvider implements LlmProvider, KeyVerifier {
  constructor(
    @Optional() @Inject(OPENAI_TRANSPORT) private readonly transport: OpenAiTransport = {},
  ) {}

  private sdk(apiKey: string): OpenAI {
    // Pinned, not left to the SDK's defaults: those read `OPENAI_BASE_URL` / `OPENAI_ORG_ID` /
    // `OPENAI_PROJECT_ID` from the environment, which `environment.ts` never declares.
    return new OpenAI({
      apiKey,
      organization: null,
      project: null,
      maxRetries: 0,
      fetch: this.transport.fetch ?? globalThis.fetch,
      baseURL: this.transport.baseURL ?? 'https://api.openai.com/v1',
    });
  }

  /**
   * 032 R9: a linked subscription's access token rides as the bearer the SDK makes of `apiKey`,
   * sent to the profile's base URL with its headers rather than the transport's.
   */
  private sdkFor(credential: CredentialContext): OpenAI {
    if (credential.mode !== 'BYOS') return this.sdk(credential.apiKey);
    const { endpoint } = credential;
    if (endpoint === undefined) throw new Error('A BYOS credential carries no endpoint.');
    return new OpenAI({
      apiKey: credential.apiKey,
      organization: null,
      project: null,
      baseURL: endpoint.baseURL,
      defaultHeaders: endpoint.headers,
      maxRetries: 0,
      fetch: this.transport.fetch ?? globalThis.fetch,
    });
  }

  async verify(apiKey: string): Promise<KeyCheck> {
    return check(() => this.sdk(apiKey).models.list());
  }

  /** 032 R9: the same check in bearer form, against the subscription's endpoint. */
  async verifyBearer(credential: CredentialContext): Promise<KeyCheck> {
    return check(() => this.sdkFor(credential).models.list());
  }

  client(credential: CredentialContext, model: string): LlmClient {
    const client = this.sdkFor(credential);

    return {
      complete: async (request, hooks) => {
        const { signal } = hooks;
        try {
          const stream = await client.responses.create(
            {
              model,
              // 021 R5: map and excerpts follow the system prompt as one prefix; the Responses
              // API caches prefixes without markers, so no breakpoints are sent.
              instructions: [request.system, request.context?.map, request.context?.excerpts]
                .filter((block) => block !== undefined && block !== '')
                .join('\n\n'),
              max_output_tokens: MAX_OUTPUT_TOKENS,
              store: false,
              tools: request.tools.map((tool): OpenAI.Responses.FunctionTool => ({
                type: 'function',
                name: tool.name,
                description: tool.description,
                parameters: toInputSchema(tool.inputSchema),
                strict: false,
              })),
              input: request.messages.flatMap(toInputItems),
              stream: true,
            },
            { signal },
          );
          let response: OpenAI.Responses.Response | undefined;
          for await (const event of stream) {
            if (event.type === 'response.output_text.delta') {
              hooks.onDelta({ kind: 'text', text: event.delta });
            } else if (
              event.type === 'response.completed' ||
              event.type === 'response.incomplete'
            ) {
              response = event.response;
            } else if (event.type === 'response.failed') {
              throw new ProviderError('unavailable');
            }
          }
          if (response === undefined) throw new ProviderError('malformed-response');
          return toTurn(response);
        } catch (error) {
          // The SDK answers an abort with its own `APIUserAbortError`; the port promises the
          // signal's reason so the executor can tell a cancel or a fence from a failure.
          if (signal.aborted) throw signal.reason;
          throw withRateLimitReset(classify(error), error);
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

/**
 * 032 T059: a 429 that sent no `retry-after` still names its wait in `x-ratelimit-reset-requests`
 * / `-tokens`, as a duration (`20ms`, `1s`, `6m0s`). The wait is the exhausted limit's reset (its
 * `x-ratelimit-remaining-*` is `0`); when none says so, the longer one, since until then the limit
 * that tripped may not have reset.
 */
function withRateLimitReset(classified: ProviderError, error: unknown): ProviderError {
  if (classified.class !== 'rate-limited' || classified.retryAfterMs !== undefined) {
    return classified;
  }
  const headers = (error as { headers?: { get(name: string): string | null } }).headers;
  const limits = ['requests', 'tokens'];
  const exhausted = limits.filter(
    (limit) => headers?.get(`x-ratelimit-remaining-${limit}`) === '0',
  );
  const waits = (exhausted.length > 0 ? exhausted : limits)
    .map((limit) => durationMs(headers?.get(`x-ratelimit-reset-${limit}`) ?? ''))
    .filter((ms): ms is number => ms !== undefined);
  if (waits.length === 0) return classified;
  return new ProviderError('rate-limited', {
    requestId: classified.requestId,
    retryAfterMs: Math.max(...waits),
    status: classified.status,
  });
}

const DURATION_PART = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
const UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, ms: 1, s: 1_000 };

/** A Go-style duration as milliseconds; anything else (or zero) is no wait at all. */
export function durationMs(value: string): number | undefined {
  if (!/^(?:\d+(?:\.\d+)?(?:ms|h|m|s))+$/.test(value)) return undefined;
  let total = 0;
  for (const [, amount, unit] of value.matchAll(DURATION_PART)) {
    total += Number(amount) * UNIT_MS[unit!]!;
  }
  return total > 0 ? Math.ceil(total) : undefined;
}

function toInputItems(message: ConversationMessage): OpenAI.Responses.ResponseInputItem[] {
  switch (message.role) {
    case 'user':
      // A message without files stays a plain string, so its request bytes (and cache) are as before.
      if (message.attachments === undefined || message.attachments.length === 0) {
        return [{ role: 'user', content: message.content }];
      }
      return [
        {
          role: 'user',
          content: [
            ...message.attachments.flatMap(toAttachmentParts),
            ...(message.content !== ''
              ? [{ type: 'input_text', text: message.content } as const]
              : []),
          ],
        },
      ];
    case 'assistant':
      return [
        ...(message.text !== undefined
          ? [{ role: 'assistant', content: message.text } as const]
          : []),
        ...message.toolCalls.map((call): OpenAI.Responses.ResponseFunctionToolCall => ({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.input),
        })),
      ];
    case 'tool':
      return message.results.map(
        (result): OpenAI.Responses.ResponseInputItem.FunctionCallOutput => ({
          type: 'function_call_output',
          call_id: result.toolUseId,
          output: result.isError ? `[error] ${result.content}` : result.content,
        }),
      );
  }
}

/**
 * Spec 048: an image (`input_image`) or PDF (`input_file`) with bytes goes as a data URL, then
 * (every kind) its text form — for an image or PDF the tag naming its workspace path, for the
 * rest the extracted text. Uploading through the Files API first was rejected: a stored file per
 * request to clean up, and the run's key may not be allowed to write files.
 */
function toAttachmentParts(attachment: PromptAttachment): OpenAI.Responses.ResponseInputContent[] {
  const text: OpenAI.Responses.ResponseInputText = {
    type: 'input_text',
    text: renderAttachment(attachment),
  };
  const { data, kind, mimeType, name } = attachment;
  if (data === undefined) return [text];
  const dataUrl = `data:${mimeType};base64,${data.toString('base64')}`;
  if (kind === 'image') {
    return [{ type: 'input_image', detail: 'auto', image_url: dataUrl }, text];
  }
  if (kind === 'pdf') return [{ type: 'input_file', filename: name, file_data: dataUrl }, text];
  return [text];
}

function toTurn(response: OpenAI.Responses.Response): ModelTurn {
  const messages = response.output.filter(
    (item): item is OpenAI.Responses.ResponseOutputMessage => item.type === 'message',
  );
  const parts = messages.flatMap((message) => message.content);
  // A refused turn is classified here so no caller can run its tools (contracts/llm-provider.md
  // rule 8).
  if (parts.some((part) => part.type === 'refusal')) throw new ProviderError('refused');
  const toolCalls = response.output
    .filter(
      (item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === 'function_call',
    )
    .map((call) => ({
      id: call.call_id,
      name: call.name,
      input: JSON.parse(call.arguments) as unknown,
    }));
  const truncated =
    response.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens';
  return {
    text: parts
      .filter((part): part is OpenAI.Responses.ResponseOutputText => part.type === 'output_text')
      .map((part) => part.text)
      .join(''),
    toolCalls,
    stop: truncated ? 'max_tokens' : toolCalls.length > 0 ? 'tool_use' : 'end_turn',
    usage: {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      // 021 R6: OpenAI reports cache reads only; writes are implicit, so 0.
      cacheReadTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
      cacheWriteTokens: 0,
    },
  };
}
