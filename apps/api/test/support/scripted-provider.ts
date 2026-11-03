/**
 * `LlmProvider` fake driven by a queue of per-`complete` scripts (contracts/llm-provider.md,
 * research R12). Every call is logged (deep-frozen copy) for byte comparison across attempts.
 */
import type {
  CredentialContext,
  Delta,
  LlmClient,
  LlmProvider,
  ModelRequest,
  ModelTurn,
} from '../../src/modules/agent/llm-provider.port';
import { ProviderError, type ProviderFailureClass } from '../../src/modules/agent/provider-error';

export type ScriptedStep =
  | {
      text?: string;
      toolCalls?: readonly { id: string; name: string; input: unknown }[];
      usage?: ModelTurn['usage'];
      stop?: ModelTurn['stop'];
    }
  | { fail: ProviderFailureClass; retryAfterMs?: number }
  /** Rejects with exactly this value: what is not a `ProviderError` crashes the attempt. */
  | { throw: unknown }
  | { hang: true }
  | { slow: { chunks: readonly string[]; gapMs: number } };

// The contract requires rejecting with the signal's own reason, not an Error we invent.
/* eslint-disable @typescript-eslint/prefer-promise-reject-errors */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function neverResolve(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
/* eslint-enable @typescript-eslint/prefer-promise-reject-errors */

export class ScriptedProvider implements LlmProvider {
  private readonly steps: ScriptedStep[] = [];
  /** 021: a model with a queue of its own (the summary's cheap model) never eats the main queue. */
  private readonly perModel = new Map<string, ScriptedStep[]>();
  readonly calls: { credential: CredentialContext; model: string; request: ModelRequest }[] = [];
  clients = 0;

  /** Queues steps, consumed one per `complete` call, in order. */
  script(...steps: ScriptedStep[]): this {
    this.steps.push(...steps);
    return this;
  }

  /** Queues steps answered only to calls on `model`, in order. */
  scriptModel(model: string, ...steps: ScriptedStep[]): this {
    this.perModel.set(model, [...(this.perModel.get(model) ?? []), ...steps]);
    return this;
  }

  client(credential: CredentialContext, model: string): LlmClient {
    this.clients += 1;
    return {
      complete: (request, hooks) => {
        this.calls.push(
          Object.freeze({
            credential: Object.freeze({ ...credential }),
            model,
            request: JSON.parse(JSON.stringify(request)) as ModelRequest,
          }),
        );
        return this.run(model, hooks);
      },
    };
  }

  private async run(
    model: string,
    hooks: { onDelta(delta: Delta): void; readonly signal: AbortSignal },
  ): Promise<ModelTurn> {
    const step = (this.perModel.get(model) ?? this.steps).shift();
    if (!step) {
      throw new Error('ScriptedProvider: no step left to answer this call');
    }

    if ('fail' in step) {
      throw new ProviderError(step.fail, { retryAfterMs: step.retryAfterMs });
    }

    if ('throw' in step) {
      throw step.throw;
    }

    if ('hang' in step) {
      return neverResolve(hooks.signal);
    }

    if ('slow' in step) {
      for (const chunk of step.slow.chunks) {
        await sleep(step.slow.gapMs, hooks.signal);
        hooks.onDelta({ kind: 'text', text: chunk });
      }
      return {
        text: step.slow.chunks.join(' '),
        toolCalls: [],
        stop: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    }

    for (const chunk of (step.text ?? '').split(' ').filter((c) => c.length > 0)) {
      hooks.onDelta({ kind: 'text', text: chunk });
    }

    return {
      text: step.text ?? '',
      toolCalls: step.toolCalls ?? [],
      stop: step.stop ?? (step.toolCalls?.length ? 'tool_use' : 'end_turn'),
      usage: step.usage ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    };
  }
}
