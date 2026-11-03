import { z } from 'zod';

import {
  DaytonaError,
  type DaytonaErrorKind,
  SandboxGuardError,
  type SandboxGuardKind,
} from '../sandbox/sandbox.errors';
import type { MutationContext, SandboxPort, SandboxRef } from '../sandbox/sandbox.port';
import type { ToolDefinition } from './llm-provider.port';
import type { ToolName, ToolOutcome, ToolSpec } from './tools';

/** The broker's own refusals, made before the port is touched. */
export type RefusalKind = 'not-allowed' | 'invalid-input';

export type BrokerResult =
  | { readonly ok: true; readonly output: string; readonly patch?: ToolOutcome['patch'] }
  | {
      readonly ok: false;
      readonly kind: RefusalKind | SandboxGuardKind | DaytonaErrorKind;
      readonly detail: string;
    };

export interface ToolCall {
  readonly name: string;
  readonly input: unknown;
}

/**
 * The §04 guard (contracts/tool-broker.md): the allowlist is fixed at construction, every call is
 * validated against its spec's schema, and dispatch goes through the execution context's fenced
 * `run`. It emits nothing — the executor turns results into events and messages.
 */
export class ToolBroker {
  private readonly allowed: ReadonlySet<ToolName>;
  private readonly memo: readonly ToolDefinition[];

  constructor(
    private readonly specs: readonly ToolSpec[],
    allowed: ReadonlySet<ToolName>,
    private readonly port: SandboxPort,
    private readonly ref: SandboxRef,
  ) {
    this.allowed = new Set(allowed);
    this.memo = Object.freeze(
      specs
        .filter((spec) => this.allowed.has(spec.name))
        .map((spec) => ({
          description: spec.description,
          inputSchema: z.toJSONSchema(spec.input),
          name: spec.name,
        })),
    );
    Object.freeze(this);
  }

  /** JSON-schema tool definitions for exactly `allowed`, in `specs` order (FR-006). */
  definitions(): readonly ToolDefinition[] {
    return this.memo;
  }

  /** Validate, then dispatch through `run`. Never throws a tool failure; rethrows a fence or a bug. */
  async handle(
    call: ToolCall,
    ctx: MutationContext,
    run: <T>(fn: () => Promise<T>) => Promise<T>,
  ): Promise<BrokerResult> {
    const spec = this.specs.find((s) => s.name === call.name);
    if (!spec || !this.allowed.has(spec.name)) {
      return {
        detail: `tool ${call.name} is not available in this run`,
        kind: 'not-allowed',
        ok: false,
      };
    }

    const parsed = spec.input.safeParse(call.input);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ` : '') + issue.message)
        .join('; ');
      return { detail, kind: 'invalid-input', ok: false };
    }

    try {
      // `run` checks the fence here; the sandbox side re-checks the row on every callback
      // (`SandboxCallbackGuard`, spec 017 R11), so a lease lost in between lands at most one request.
      const outcome = await run(() => spec.call(this.port, this.ref, parsed.data, ctx));
      return outcome.patch === undefined
        ? { ok: true, output: outcome.output }
        : { ok: true, output: outcome.output, patch: outcome.patch };
    } catch (error) {
      if (error instanceof SandboxGuardError)
        return { detail: error.detail, kind: error.kind, ok: false };
      if (error instanceof DaytonaError)
        return { detail: error.message, kind: error.kind, ok: false };
      throw error;
    }
  }
}
