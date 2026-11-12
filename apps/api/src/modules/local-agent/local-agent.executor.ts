import { Inject, Injectable, Logger, type OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type CompanionPolicy,
  type CompanionRunEvent,
  type LocalAgentProvider,
  sandboxToolOf,
  type SubscriptionRunTarget,
  truncateToolOutput,
} from '@repo/contracts';
import type { LocalAgentRunRow } from '@repo/db';
import { createHash } from 'node:crypto';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { DomainError } from '../../common/errors/domain-error';
import type { Environment } from '../../config/environment';
import type { TenantTransaction } from '../../database/database.types';
import { TenantContext } from '../../database/tenant-context';
import { type LocalRunExecutor, RunExecutorRegistry } from '../agent/run-executor-registry';
import type { ExecutionContext, RunOutcome } from '../agent/run-executor.port';
import { FencedError } from '../agent/run-store';
import { failed, SandboxTools, toolContent } from '../agent/sandbox-tools';
import type { BrokerResult, ToolBroker } from '../agent/tool-broker';
import { PermissionResolutionService } from '../rbac/permission-resolution.service';
import { scoped } from '../rbac/permissions';
import { integrationNote } from '../sandbox/integration-note';
import { PREVIEW_ENV_SOURCE, type PreviewEnvSource } from '../sandbox/sandbox.constants';
import { AgentHomeService } from './agent-home.service';
import {
  LOCAL_FAILURES,
  mapCompanionEvent,
  notRunnable,
  terminalOutcome,
  withOrigin,
} from './event-mapping';
import { LOCAL_AGENT_TIMINGS, type LocalAgentTimings } from './local-agent.constants';
import { LocalAgentRepository } from './local-agent.repository';
import {
  LocalAgentStore,
  type RunChannel,
  type RunCursor,
  type RunReader,
} from './local-agent.store';
import { COMPANION_POLICY } from './policy';

const PROMPT_LIMIT = 32_000;

/**
 * The CLI has no system prompt of ours, so the project's connected-services note leads the turn's
 * prompt; the whole stays within the command's limit, the person's words cut before the note.
 */
export function framePrompt(note: string, prompt: string): string {
  if (note === '') return prompt.slice(0, PROMPT_LIMIT);
  const head = `${note}

The user's request:
`;

  return `${head}${prompt}`.slice(0, PROMPT_LIMIT);
}

/**
 * `run.start`'s `conversationKey`: opaque and stable per project, so the runner can give the CLI
 * one directory per project and its resume finds the session it saved there. A digest, so no id
 * lands in a path in the agent home.
 */
export function conversationKeyOf(orgId: string, projectId: string): string {
  return createHash('sha256').update(`${orgId}:${projectId}`).digest('hex').slice(0, 32);
}

/** A run this executor can still drive: Claude on the project sandbox (spec 041). */
type HomeRun = LocalAgentRunRow & { provider: LocalAgentProvider; toolMode: 'sandbox' };

function isHomeRun(row: LocalAgentRunRow): row is HomeRun {
  return row.toolMode === 'sandbox' && row.provider === 'claude';
}

/** Whether the run may still use its device: answers the failure when it may not. */
type Authorise = () => Promise<RunOutcome | undefined>;

/**
 * A subscription run as a `RunExecutor` (spec 041, on spec 040's runner bridge). A fresh turn
 * publishes `run.start` to the agent home's command stream, then this consumes the turn's runner
 * event stream and maps each event through `ctx.emit`; the consumer keeps fencing, transitions and
 * persistence as for any run. A re-claimed attempt (`running`) picks the stream up at its saved
 * cursor instead.
 *
 * Every attempt first re-checks that the home's device is still the starter's and live, and that
 * the starter still holds `project:agent.run`; the device check repeats at each idle tick, and a
 * revocation aborts the run at once through its control stream.
 *
 * The sandbox tool bridge: each attempt readies the project's sandbox as the cloud agent does
 * (`SandboxTools.prepare`), offers the CLI the sandbox tools in `run.start`, runs each `tool.call`
 * through the broker exactly as a cloud tool call — the same milestones, step bound and
 * `tool_error` rule — and answers it with `tool.result`. A completed turn is checkpointed.
 *
 * A run admitted on a person's own paired computer before that feature was retired (spec 040: the
 * `workspace` tool mode, Codex, or a device that is no agent home) is failed with a clear reason.
 */
@Injectable()
export class LocalAgentExecutor implements LocalRunExecutor, OnModuleInit {
  private readonly logger = new Logger(LocalAgentExecutor.name);
  private readonly enabled: boolean;
  private readonly policy: CompanionPolicy = COMPANION_POLICY;

  constructor(
    @Inject(RunExecutorRegistry) private readonly registry: RunExecutorRegistry,
    @Inject(LocalAgentStore) private readonly channel: LocalAgentStore,
    @Inject(LocalAgentRepository) private readonly repository: LocalAgentRepository,
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(LOCAL_AGENT_TIMINGS) private readonly timings: LocalAgentTimings,
    @Inject(PermissionResolutionService) private readonly permissions: PermissionResolutionService,
    @Inject(ConfigService) config: ConfigService<Environment, true>,
    @Inject(SandboxTools) private readonly sandbox: SandboxTools,
    @Inject(AgentHomeService) private readonly homes: AgentHomeService,
    @Optional()
    @Inject(PREVIEW_ENV_SOURCE)
    private readonly previewEnv?: PreviewEnvSource,
  ) {
    this.enabled = config.get('LOCAL_AGENT_ENABLED', { infer: true });
  }

  onModuleInit(): void {
    if (this.enabled) this.registry.register(this);
  }

  /**
   * Run admission: the person's cloud agent home, signed in by the runner's last status report,
   * else `subscription-not-connected`. Recorded as a sandbox-tool-mode run on the home's device;
   * the attempt wakes the home if it is stopped.
   */
  async admitSubscription(
    tx: TenantTransaction,
    run: { orgId: string; projectId: string; runId: string; userId: string },
    target: SubscriptionRunTarget,
  ): Promise<void> {
    if (!this.homes.enabled) {
      throw new DomainError(
        'subscription-unavailable',
        'Running Claude Code on your own subscription is not available on this deployment.',
      );
    }

    const home = await this.homes.admissible(tx, run.userId, target.provider);

    if (home === undefined) {
      throw new DomainError(
        'subscription-not-connected',
        'Connect your Claude subscription in Settings, then try again.',
        { provider: target.provider },
      );
    }

    await this.repository.insertRun(tx, {
      deviceId: home.deviceId,
      orgId: run.orgId,
      provider: target.provider,
      runId: run.runId,
    });
  }

  release(runId: string): Promise<void> {
    return this.channel.clearRun(runId);
  }

  async execute(context: ExecutionContext): Promise<RunOutcome> {
    const { run } = context;
    const target = await context.dispatch(() =>
      this.repository.runOn(this.tenant.tx, run.orgId, run.id),
    );

    if (target === undefined) return LOCAL_FAILURES.noTarget();

    // Spec 040's own-computer runs still in flight at the cut-over: nothing can run them now.
    if (!isHomeRun(target) || !(await this.homes.isHome(target.deviceId))) {
      this.logger.warn(`retired local run failed: run=${run.id} device=${target.deviceId}`);
      return LOCAL_FAILURES.retired();
    }

    const authorise: Authorise = () => this.authorise(context, target);

    try {
      // Authority first: a revoked device or a starter who lost access never wakes (or pays for) a home.
      const refused = await authorise();

      if (refused !== undefined) return withOrigin(refused);

      // A home's runner may be stopped (idle) — start it and wait (≤ 120 s, cancellable) before
      // `run.start`. The wake bumps `last_used_at` first, so an idle stop spares the home.
      const woken = await this.homes.wake(target.deviceId, {
        cancelled: () => context.cancelled(),
        signal: context.signal,
      });
      if (woken === 'cancelled') return { kind: 'stopped' };
      if (woken !== 'online') return withOrigin(LOCAL_FAILURES.transport(target.provider));

      return withOrigin(await this.attempt(context, target, authorise));
    } finally {
      // The idle clock restarts when a run ends; a failed write must not replace the outcome.
      await this.homes.touchDevice(target.deviceId).catch(() => undefined);
    }
  }

  private async attempt(
    context: ExecutionContext,
    target: HomeRun,
    authorise: Authorise,
  ): Promise<RunOutcome> {
    const { run } = context;
    const reader = this.channel.reader();

    try {
      const outcome = await new LocalRun(context, target, {
        authorise,
        channel: this.channel,
        clock: this.clock,
        policy: this.policy,
        reader,
        integrations: async () =>
          this.previewEnv === undefined
            ? ''
            : integrationNote(
                Object.keys(await this.previewEnv(this.tenant.tx, run.orgId, run.projectId)),
              ),
        sandbox: this.sandbox,
        timings: this.timings,
      }).execute();

      this.logger.log(
        `subscription run ended: run=${run.id} device=${target.deviceId} provider=${target.provider} outcome=${outcome.kind}`,
      );

      return outcome;
    } finally {
      reader.close();
    }
  }

  /**
   * Only the starter's own live home runs their prompts, and only while they may still run agents
   * in the project: a device revoked or re-owned since admission, or a starter removed or
   * downgraded since, fails the run rather than act on authority it no longer has.
   */
  private async authorise(
    context: ExecutionContext,
    target: HomeRun,
  ): Promise<RunOutcome | undefined> {
    const { run } = context;
    const device = await context.dispatch(() =>
      this.repository.deviceOn(this.tenant.tx, target.deviceId),
    );

    if (device?.userId !== run.userId || device.revokedAt !== null) {
      return LOCAL_FAILURES.revoked(target.provider);
    }

    const held = await this.permissions.for(run.orgId, run.userId);

    return held.has(scoped('project:agent.run', run.projectId))
      ? undefined
      : LOCAL_FAILURES.accessLost(target.provider);
  }
}

interface LocalRunDeps {
  readonly authorise: Authorise;
  readonly channel: RunChannel;
  readonly clock: ClockPort;
  readonly policy: CompanionPolicy;
  readonly reader: RunReader;
  readonly sandbox: SandboxTools;
  readonly timings: LocalAgentTimings;
  /** The project's connected-services note (env names only); called inside a dispatch. */
  readonly integrations: () => Promise<string>;
}

/** One attempt at one turn: the state the loop keeps between reads. */
class LocalRun {
  /** The CLI's own ids for its bridged tool calls, whose events the server's tool calls replace. */
  private readonly bridged = new Set<string>();
  /** The step bound's count, as the cloud agent keeps it: from the committed `tool.end`s. */
  private readonly counter: { steps: number };
  private broker: ToolBroker | undefined;
  private interruptedAt: number | undefined;
  private readonly channel: RunChannel;
  private readonly timings: LocalAgentTimings;
  /** 1 for the prompt, +1 per answer: the runner dedupes `run.start` on (run, turn). */
  private readonly turn: number;
  private text = '';
  private cursor: RunCursor = { control: '0-0', events: '0-0' };
  private turnStartedAt = 0;
  /** Set once `run.start` is out, cleared by the runner's first event of the turn. */
  private startDeadline: number | undefined;

  constructor(
    private readonly context: ExecutionContext,
    private readonly target: HomeRun,
    private readonly deps: LocalRunDeps,
  ) {
    this.channel = deps.channel;
    this.timings = deps.timings;
    this.counter = { steps: context.run.committed.toolEnds };
    this.turn = Math.max(
      1,
      context.run.messages.filter((message) => message.role === 'user').length,
    );
  }

  private get runId(): string {
    return this.context.run.id;
  }

  private now(): number {
    return this.deps.clock.now().getTime();
  }

  async execute(): Promise<RunOutcome> {
    const outcome = await this.loop();

    // From here the uplink refuses this turn's events: a late retry cannot reach the next turn.
    await this.channel.endTurn(this.runId);

    return outcome;
  }

  private async loop(): Promise<RunOutcome> {
    const { run } = this.context;
    const { provider } = this.target;

    // The sandbox is made ready, probed and baselined on every attempt, as a cloud run's is.
    const prepared = await this.deps.sandbox.prepare(this.context);
    if (prepared !== undefined) {
      return run.status === 'starting' ? prepared : this.end(prepared);
    }
    this.broker = this.deps.sandbox.broker(run);

    if (run.status === 'starting') {
      const started = await this.start(this.broker);
      if (started !== undefined) return started;
    } else {
      this.cursor = await this.channel.cursor(this.runId);
      const active = await this.channel.activeTurn(this.runId);
      this.turnStartedAt = active?.turn === this.turn ? active.startedAt : this.now();
      await this.context.dispatch(() =>
        this.channel.markTurn(this.runId, this.turn, this.turnStartedAt),
      );
    }

    let lastActivity = this.now();
    let lastCancelPoll = Number.NEGATIVE_INFINITY;

    for (;;) {
      this.throwIfAborted();
      const now = this.now();

      if (this.interruptedAt === undefined && now - lastCancelPoll >= this.timings.cancelPollMs) {
        lastCancelPoll = now;
        if (await this.context.cancelled()) {
          this.interruptedAt = now;
          await this.interrupt();
        }
      }

      if (
        this.interruptedAt !== undefined &&
        now - this.interruptedAt >= this.timings.interruptWaitMs
      ) {
        return { kind: 'stopped' };
      }

      // Deadlines that hold however busy or online the runner is (spec 040 § 6); a cancel already
      // under way ends on its own wait above.
      if (
        this.interruptedAt === undefined &&
        this.startDeadline !== undefined &&
        now >= this.startDeadline
      ) {
        return this.end(LOCAL_FAILURES.notStarted(provider));
      }

      if (this.interruptedAt === undefined && now - this.turnStartedAt >= this.timings.maxRunMs) {
        return this.end(LOCAL_FAILURES.tooLong(provider, this.timings.maxRunMs));
      }

      if (now - lastActivity >= this.timings.runIdleMs) {
        if (!(await this.channel.online(this.target.deviceId))) {
          return this.end(LOCAL_FAILURES.transport(provider));
        }
        const refused = await this.deps.authorise();
        if (refused !== undefined) return this.end(refused);
        lastActivity = now;
      }

      const read = await this.deps.reader.read(
        this.runId,
        this.turn,
        this.cursor,
        this.timings.readBlockMs,
      );

      const [abort] = read.aborts;

      if (abort !== undefined) {
        return this.end(
          abort.reason === 'revoked'
            ? LOCAL_FAILURES.revoked(provider)
            : LOCAL_FAILURES.overBudget(provider),
        );
      }

      for (const { event, id } of read.events) {
        this.cursor = { ...this.cursor, events: id };
        this.startDeadline = undefined;
        lastActivity = this.now();
        const outcome = await this.handle(event);

        // A tool call is activity until it is answered, and is not re-run by a successor once done.
        if (event.type === 'tool.call') {
          lastActivity = this.now();
          if (outcome === undefined) await this.channel.saveCursor(this.runId, this.cursor);
        }

        if (outcome !== undefined) {
          await this.channel.saveCursor(this.runId, this.cursor);
          return this.interruptedAt === undefined ? outcome : { kind: 'stopped' };
        }
      }

      if (read.events.length > 0) {
        await this.channel.saveCursor(this.runId, this.cursor);
      }
    }
  }

  /**
   * A fresh turn: wait out the grace for the runner, re-check its CLI against the policy on its
   * current report, then — under the fence, so a stale attempt sends nothing — open the turn and
   * hand the runner the prompt and the sandbox toolset.
   */
  private async start(broker: ToolBroker): Promise<RunOutcome | undefined> {
    const { run } = this.context;
    const { deviceId, provider } = this.target;
    const deadline = this.now() + this.timings.offlineGraceMs;

    while (!(await this.channel.online(deviceId))) {
      this.throwIfAborted();
      if (await this.context.cancelled()) return { kind: 'stopped' };
      if (this.now() >= deadline) {
        return LOCAL_FAILURES.offline(provider);
      }
      // Nothing is on the turn's stream yet; the read is the wait. The cursor stays put.
      await this.deps.reader.read(this.runId, this.turn, this.cursor, this.timings.readBlockMs);
    }

    const status = (await this.channel.status(deviceId))?.providers.find(
      (each) => each.provider === provider,
    );
    const refused = notRunnable(status, provider, this.deps.policy);

    if (refused !== undefined) return refused;

    const prompt = run.messages.filter((message) => message.role === 'user').at(-1)?.content;

    if (prompt === undefined) return LOCAL_FAILURES.noPrompt(provider);

    this.turnStartedAt = this.now();
    await this.context.dispatch(async () => {
      const note = await this.deps.integrations();
      await this.channel.beginTurn(this.runId, this.turn, this.turnStartedAt);
      await this.channel.publish(deviceId, {
        conversationKey: conversationKeyOf(run.orgId, run.projectId),
        model: run.model === provider ? null : run.model,
        prompt: framePrompt(note, prompt),
        provider,
        resume:
          this.target.providerSessionId === null
            ? null
            : { providerSessionId: this.target.providerSessionId },
        runId: this.runId,
        toolset: this.deps.sandbox.toolset(broker),
        turn: this.turn,
        type: 'run.start',
      });
    });
    this.startDeadline = this.now() + this.timings.startAckMs;

    return undefined;
  }

  /** The run ends on this side whatever the runner does: tell it to stop, and fail the run. */
  private async end(outcome: RunOutcome): Promise<RunOutcome> {
    await this.interrupt();

    return outcome;
  }

  private async handle(event: CompanionRunEvent): Promise<RunOutcome | undefined> {
    switch (event.type) {
      case 'text.delta':
        this.text += event.data.text;
        break;
      case 'tool.start':
        // The server's own tool call is the step of record; the CLI's view of it is a duplicate.
        if (sandboxToolOf(event.data.name) !== undefined) {
          this.bridged.add(event.data.toolId);
          return undefined;
        }
        break;
      case 'tool.output':
        if (this.bridged.has(event.data.toolId)) return undefined;
        break;
      case 'tool.end':
        if (this.bridged.delete(event.data.toolId)) return undefined;
        break;
      case 'tool.call':
        return this.toolCall(event.data);
      case 'terminal': {
        const outcome = terminalOutcome(event.data, this.target.provider);
        // The assistant's words are the conversation of record, so the next turn has them (§ 3.9).
        if (outcome.kind === 'awaiting_input' && this.text.trim() !== '') {
          await this.context.persist({ content: this.text, role: 'assistant', toolCalls: [] });
        }
        // A completed turn on the sandbox is checkpointed, as a cloud run's last turn is.
        if (outcome.kind === 'awaiting_input') {
          return (await this.deps.sandbox.checkpoint(this.context, this.turn)) ?? outcome;
        }
        return outcome;
      }
      default:
        break;
    }

    const mapped = mapCompanionEvent(this.runId, event);

    if (mapped !== undefined) await this.context.emit(mapped);

    return undefined;
  }

  /**
   * One bridged call, run exactly as the cloud agent runs one (`SandboxTools.call`: schema check,
   * step bound, fenced dispatch, the same milestones), answered to the runner. A call that arrives
   * while the run is stopping is answered as a refusal. The third failed call in a row ends the
   * run in the consumer; the runner is told to stop with it.
   */
  private async toolCall(
    data: Extract<CompanionRunEvent, { type: 'tool.call' }>['data'],
  ): Promise<RunOutcome | undefined> {
    const { broker, deps } = this;

    if (broker === undefined || this.interruptedAt !== undefined) {
      await this.toolResult(data.callId, {
        detail: 'the run is stopping',
        kind: 'not-allowed',
        ok: false,
      });
      return undefined;
    }

    let result: BrokerResult | 'step-limit';
    try {
      result = await deps.sandbox.call(this.context, broker, data, this.counter);
    } catch (error) {
      // A fence means another attempt holds the run (and the runner); anything else ends it here.
      if (!(error instanceof FencedError)) await this.interrupt().catch(() => undefined);
      throw error;
    }

    if (result === 'step-limit') return this.end(failed('step-limit'));

    await this.toolResult(data.callId, result);
    return undefined;
  }

  private toolResult(callId: string, result: BrokerResult) {
    return this.channel.publish(this.target.deviceId, {
      callId,
      ...(result.ok ? {} : { isError: true }),
      ok: result.ok,
      output: truncateToolOutput(toolContent(result)),
      runId: this.runId,
      turn: this.turn,
      type: 'tool.result',
    });
  }

  private interrupt() {
    return this.channel.publish(this.target.deviceId, {
      runId: this.runId,
      turn: this.turn,
      type: 'run.interrupt',
    });
  }

  /** The consumer's signal (fence, shutdown): its reason is what it expects back. */
  private throwIfAborted(): void {
    if (this.context.signal.aborted) throw this.context.signal.reason as Error;
  }
}
