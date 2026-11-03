import { Injectable } from '@nestjs/common';
import { runFailureClassSchema } from '@repo/contracts';
import { z } from 'zod';

import type { ExecutionContext, RunExecutor, RunOutcome, RunSnapshot } from './run-executor.port';

/**
 * The fake bound as `RUN_EXECUTOR` until spec 011 binds the real one (contracts/executor-port.md
 * § ScriptedExecutor). It reads its script from the run's first `user` message, so an e2e drives
 * every state with nothing but a `POST`; a prompt that is not a script runs {@link DEFAULT_SCRIPT}.
 * 011 replaces one binding in `agent.module.ts`; nothing else names this class.
 */
const stepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tool'), ok: z.boolean().optional() }),
  z.object({ kind: z.literal('patch'), path: z.string().optional() }),
  z.object({ kind: z.literal('token'), text: z.string().optional() }),
  z.object({
    input: z.number().int().min(0).optional(),
    kind: z.literal('usage'),
    output: z.number().int().min(0).optional(),
  }),
  z.object({ kind: z.literal('sleep'), ms: z.number().int().min(0) }),
  z.object({ kind: z.literal('stall') }),
  z.object({ kind: z.literal('await-input') }),
  z.object({ kind: z.literal('pause'), reason: z.string() }),
  z.object({
    failureClass: runFailureClassSchema,
    kind: z.literal('fail'),
    reason: z.string().optional(),
  }),
  z.object({ kind: z.literal('succeed') }),
]);

const scriptSchema = z.object({ script: z.array(stepSchema) });

export type Step = z.output<typeof stepSchema>;

/** Three tool pairs, a patch, a usage, then succeeded — quickstart step 3. */
export const DEFAULT_SCRIPT: readonly Step[] = Object.freeze([
  { kind: 'tool' },
  { kind: 'tool' },
  { kind: 'tool' },
  { kind: 'patch' },
  { kind: 'usage' },
  { kind: 'succeed' },
]);

/** `{ "script": Step[] }` or the default; anything that fails to parse is the default. */
export function parseScript(prompt: string): readonly Step[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(prompt);
  } catch {
    return DEFAULT_SCRIPT;
  }

  const result = scriptSchema.safeParse(parsed);

  return result.success ? result.data.script : DEFAULT_SCRIPT;
}

@Injectable()
export class ScriptedExecutor implements RunExecutor {
  async execute(context: ExecutionContext): Promise<RunOutcome> {
    const { run } = context;
    const prompt = run.messages.find((message) => message.role === 'user')?.content ?? '';
    const steps = parseScript(prompt);
    const start = resumeIndex(steps, run);

    // The step being redone had its tool.start committed and its tool.end lost (FR-019): the
    // usage it is about to spend again is marked before it is spent.
    if (run.committed.openStepId !== null) {
      await context.emit({
        data: {
          costMicros: 0,
          duplicateOf: run.committed.openStepId,
          inputTokens: 0,
          outputTokens: 0,
        },
        type: 'usage',
      });
    }

    for (const [index, step] of steps.entries()) {
      if (index < start) {
        continue;
      }

      if (await context.cancelled()) {
        return { kind: 'stopped' };
      }

      const outcome = await this.step(context, step, index);

      if (outcome !== undefined) {
        return outcome;
      }
    }

    return { kind: 'succeeded' };
  }

  private async step(
    context: ExecutionContext,
    step: Step,
    index: number,
  ): Promise<RunOutcome | undefined> {
    const stepId = `${context.run.id}/${index}`;

    switch (step.kind) {
      case 'tool': {
        const ok = step.ok ?? true;

        await context.emit({
          data: { input: { step: index }, stepId, tool: 'scripted' },
          type: 'tool.start',
        });
        await context.emit({ data: { chunk: 'working', stepId }, type: 'tool.delta' });
        await context.emit({
          data: ok
            ? { ok, output: { step: index }, stepId }
            : { error: `scripted failure at step ${index}`, ok, stepId },
          type: 'tool.end',
        });

        return undefined;
      }
      case 'token':
        await context.emit({ data: { text: step.text ?? 'tok' }, type: 'token' });

        return undefined;
      case 'patch':
        await context.emit({
          data: { diff: `--- a\n+++ b\n@@ step ${index} @@\n`, path: step.path ?? 'src/App.tsx' },
          type: 'file.patch',
        });

        return undefined;
      case 'usage': {
        const inputTokens = step.input ?? 10;
        const outputTokens = step.output ?? 5;

        await context.emit({
          data: { costMicros: inputTokens * 3 + outputTokens * 15, inputTokens, outputTokens },
          type: 'usage',
        });

        return undefined;
      }
      case 'sleep':
        await sleep(step.ms, context.signal);

        return undefined;
      case 'stall':
        await sleep(undefined, context.signal);

        return undefined;
      case 'await-input':
        return { kind: 'awaiting_input' };
      case 'pause':
        return { kind: 'paused', reason: step.reason };
      case 'fail':
        return {
          failureClass: step.failureClass,
          kind: 'failed',
          reason: step.reason ?? `scripted failure at step ${index}`,
        };
      case 'succeed':
        return { kind: 'succeeded' };
    }
  }
}

/**
 * Where a resumed attempt picks the script up (contracts/executor-port.md § Resume rule): past as
 * many `tool` steps as have a committed `tool.end`, as many `await-input` steps as there are
 * user messages beyond the prompt, and as many `pause` steps as there are `paused` state events —
 * everything before the last of those is done, whatever its kind.
 */
function resumeIndex(steps: readonly Step[], run: RunSnapshot): number {
  let tools = run.committed.toolEnds;
  let inputs = run.messages.filter((message) => message.role === 'user').length - 1;
  let pauses = run.committed.pauses;
  let start = 0;

  for (const [index, step] of steps.entries()) {
    if (step.kind === 'tool' && tools > 0) {
      tools -= 1;
      start = index + 1;
    } else if (step.kind === 'await-input' && inputs > 0) {
      inputs -= 1;
      start = index + 1;
    } else if (step.kind === 'pause' && pauses > 0) {
      pauses -= 1;
      start = index + 1;
    } else if (tools === 0 && inputs === 0 && pauses === 0) {
      break;
    }
  }

  return start;
}

/** Resolves after `ms`, or never when `ms` is undefined; rejects with the signal's reason on abort. */
function sleep(ms: number | undefined, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);

      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };
    const timer =
      ms === undefined
        ? undefined
        : setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          }, ms);

    signal.addEventListener('abort', onAbort, { once: true });
  });
}
