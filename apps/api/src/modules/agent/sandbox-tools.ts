import { Logger } from '@nestjs/common';
import type { CompanionToolDefinition } from '@repo/contracts';

import type { ClockPort } from '../../common/clock/clock.port';
import type { TenantContext } from '../../database/tenant-context';
import { type CheckpointService, GitStepError } from '../checkpoints/checkpoint.service';
import type { SandboxLifecycle } from '../sandbox/sandbox-lifecycle';
import type { SandboxTimings } from '../sandbox/sandbox.constants';
import { DaytonaError, SandboxGuardError } from '../sandbox/sandbox.errors';
import type { SandboxPort, SandboxRef } from '../sandbox/sandbox.port';
import { MAX_TOOL_CALLS } from './agent.constants';
import type { ExecutionContext, RunOutcome } from './run-executor.port';
import { type BrokerResult, type ToolCall, ToolBroker } from './tool-broker';
import { toInputSchema } from './tool-schema';
import { type ToolName, TOOLS } from './tools';

/** Default allowlist when no `AGENT_ALLOWED_TOOLS` provider is bound: every tool. */
export const ALL_TOOLS: ReadonlySet<ToolName> = new Set(TOOLS.map((tool) => tool.name));

export function failed(reason: string): RunOutcome {
  return { failureClass: 'executor', kind: 'failed', reason };
}

/**
 * What `failed('checkpoint')` covers (016 contracts § 4): the sandbox refusing or unreachable, or
 * a git step answering badly. A failed insert is none of these and propagates.
 */
function checkpointFailure(
  error: unknown,
): error is SandboxGuardError | DaytonaError | GitStepError {
  return (
    error instanceof SandboxGuardError ||
    error instanceof DaytonaError ||
    error instanceof GitStepError
  );
}

/**
 * Resolves after `ms`, or at once when `signal` aborts (the caller reads the reason); never rejects.
 * The global timer rather than `timers/promises`, so a suite's fake clock can drive the wait.
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** What the model reads back for a call (contracts/tool-broker.md step 5: `kind: <kind>\n<detail>`). */
export function toolContent(result: BrokerResult): string {
  return result.ok ? result.output : `kind: ${result.kind}\n${result.detail}`;
}

export interface SandboxToolsDeps {
  readonly port: SandboxPort;
  readonly lifecycle: SandboxLifecycle;
  /** `tenant.tx` is the scope `dispatch` opens. */
  readonly tenant: TenantContext;
  readonly checkpoints: CheckpointService;
  readonly sandboxTimings: SandboxTimings;
  readonly clock: ClockPort;
  readonly allowed: ReadonlySet<ToolName>;
}

/**
 * The sandbox half of a run, shared by every executor whose tools run in the project's sandbox:
 * the cloud agent (`AgentExecutor`) and a local CLI on the sandbox tool bridge (spec 041). One
 * place for the pre-flight (014 readiness, the probe, the 016 baseline), one tool call's
 * milestones (`tool.start` → broker → `tool.end`, `file.patch`) under the step bound, and the
 * turn-end checkpoint — so both kinds of run look the same on the stream and in the history.
 */
export class SandboxTools {
  private readonly logger = new Logger(SandboxTools.name);

  constructor(private readonly deps: SandboxToolsDeps) {}

  /** A broker over the allowed tools for this run's project. */
  broker(run: ExecutionContext['run']): ToolBroker {
    return new ToolBroker(TOOLS, this.deps.allowed, this.deps.port, refOf(run));
  }

  /**
   * The broker's definitions with each schema flattened to a root `type: object` — the shape a
   * CLI's tool server (MCP) takes, as the providers do.
   */
  toolset(broker: ToolBroker): CompanionToolDefinition[] {
    return broker.definitions().map((definition) => ({
      description: definition.description,
      // `toInputSchema` always answers a root `type: object`.
      inputSchema: toInputSchema(definition.inputSchema) as CompanionToolDefinition['inputSchema'],
      name: definition.name as ToolName,
    }));
  }

  /**
   * Pre-flight (014 contract § 2): the sandbox is made ready — created, claimed or resumed —
   * before the probe, the run waiting in `starting`. Then a project with no sandbox fails before
   * the first request; anything else the probe says is the tools' problem, reported per call as
   * `ok:false`. 016 US4 (R10): the baseline exists before the first turn, so the turn-end commit
   * has a parent; a sandbox that cannot be initialised fails the run as a commit failure would.
   * `undefined` means proceed.
   */
  async prepare(context: ExecutionContext): Promise<RunOutcome | undefined> {
    const { run } = context;
    const ref = refOf(run);
    try {
      const waited = await this.awaitSandbox(context, ref);
      if (waited !== undefined) return waited;
      await context.dispatch(() => this.deps.port.list(ref, '.'));
    } catch (error) {
      if (error instanceof SandboxGuardError && error.kind === 'no-sandbox')
        return failed('no-sandbox');
      if (!(error instanceof SandboxGuardError) && !(error instanceof DaytonaError)) throw error;
      this.logger.warn(`sandbox probe failed: run=${run.id} kind=${error.kind}`);
    }
    try {
      await context.dispatch(() =>
        this.deps.checkpoints.ensureRepository(
          ref,
          { leaseEpoch: run.epoch, operationId: `${run.id}/baseline` },
          this.deps.tenant.tx,
        ),
      );
    } catch (error) {
      if (!checkpointFailure(error)) throw error;
      this.logger.warn(`baseline failed: run=${run.id} kind=${error.kind} cause=${error.message}`);
      return failed('checkpoint');
    }
    return undefined;
  }

  /**
   * One tool call as the run sees it: the step bound (`MAX_TOOL_CALLS`), `tool.start`, the
   * broker's fenced dispatch, `tool.end` (a failed one is the consumer's `tool_error` step), and
   * `file.patch` for an edit that changed something. `'step-limit'` when the bound is reached.
   */
  async call(
    context: ExecutionContext,
    broker: ToolBroker,
    call: ToolCall,
    counter: { steps: number },
  ): Promise<BrokerResult | 'step-limit'> {
    const { run } = context;
    if (counter.steps >= MAX_TOOL_CALLS) return 'step-limit';

    counter.steps += 1;
    const stepId: `${string}/${string}` = `${run.id}/${String(counter.steps)}`;
    await context.emit({
      data: { input: call.input, stepId, tool: call.name },
      type: 'tool.start',
    });
    const result = await broker.handle(call, { leaseEpoch: run.epoch, operationId: stepId }, (fn) =>
      context.dispatch(fn),
    );
    await context.emit({
      data: result.ok
        ? { ok: true, output: result.output, stepId }
        : { error: result.kind, ok: false, stepId },
      type: 'tool.end',
    });
    if (result.ok && result.patch !== undefined) {
      await context.emit({ data: result.patch, type: 'file.patch' });
    }
    return result;
  }

  /**
   * 016 FR-006/FR-007: the commit, its row and `checkpoint.created` share the dispatch's tenant
   * transaction; a sandbox that cannot commit fails the run without a checkpoint.
   */
  async checkpoint(context: ExecutionContext, turn: number): Promise<RunOutcome | undefined> {
    const { run } = context;
    let checkpoint: { id: string; label: string };
    try {
      checkpoint = await context.dispatch(() =>
        this.deps.checkpoints.commitTurn(
          refOf(run),
          { leaseEpoch: run.epoch, operationId: `${run.id}/checkpoint-${String(turn)}` },
          { runId: run.id, turn },
          this.deps.tenant.tx,
        ),
      );
    } catch (error) {
      if (!checkpointFailure(error)) throw error;
      this.logger.warn(
        `checkpoint failed: run=${run.id} kind=${error.kind} cause=${error.message}`,
      );
      return failed('checkpoint');
    }
    await context.emit({
      data: { checkpointId: checkpoint.id, label: checkpoint.label },
      type: 'checkpoint',
    });
    return undefined;
  }

  /**
   * The wait of 014 contract § 2: `ensureReady` in a dispatch (the tenant scope, fence first); when
   * the sandbox is not ready, one `sandbox.preparing` milestone, then a poll every `runWaitPollMs`
   * until ready, `cancelled()`, or `runWaitMs` on the clock has gone. `undefined` means proceed.
   * ponytail: a 1–2 s row read per waiting run; pub/sub on the op's settle is the upgrade.
   */
  private async awaitSandbox(
    context: ExecutionContext,
    ref: SandboxRef,
  ): Promise<RunOutcome | undefined> {
    const { runWaitMs, runWaitPollMs } = this.deps.sandboxTimings;
    const ctx = {
      leaseEpoch: context.run.epoch,
      operationId: `${context.run.id}/sandbox`,
    } as const;
    const ensure = () =>
      context.dispatch(() => this.deps.lifecycle.ensureReady(this.deps.tenant.tx, ref, ctx));
    let readiness = await ensure();
    if (readiness.ready) return undefined;

    await context.emit({ data: { transition: readiness.because }, type: 'sandbox.preparing' });
    const deadline = this.deps.clock.now().getTime() + runWaitMs;
    while (!readiness.ready && this.deps.clock.now().getTime() < deadline) {
      await sleep(runWaitPollMs, context.signal);
      if (context.signal.aborted) throw context.signal.reason;
      if (await context.cancelled()) return { kind: 'stopped' };
      readiness = await ensure();
    }

    return readiness.ready ? undefined : failed(`sandbox unavailable: ${readiness.because}`);
  }
}

function refOf(run: ExecutionContext['run']): SandboxRef {
  return { orgId: run.orgId, projectId: run.projectId };
}
