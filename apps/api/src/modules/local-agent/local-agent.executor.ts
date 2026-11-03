import { Inject, Injectable, Logger, type OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type CompanionPolicy,
  type CompanionRunEvent,
  type LocalAgentRunTarget,
  type RunApprovalDecision,
  sandboxToolOf,
  type SubscriptionRunTarget,
  truncateToolOutput,
} from '@repo/contracts';
import type { LocalAgentRunRow } from '@repo/db';
import { createHash } from 'node:crypto';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { DomainError, NotFoundError } from '../../common/errors/domain-error';
import { ValidationFailedError } from '../../common/validation/validation-failed.error';
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
import { AgentHomeService } from './agent-home.service';
import {
  LOCAL_FAILURES,
  type LocalAgentOrigin,
  mapCompanionEvent,
  notRunnable,
  stepIdOf,
  terminalOutcome,
  withOrigin,
} from './event-mapping';
import { LOCAL_AGENT_TIMINGS, type LocalAgentTimings } from './local-agent.constants';
import { LocalAgentRepository } from './local-agent.repository';
import {
  type ApprovalDecision,
  LocalAgentStore,
  type RunChannel,
  type RunCursor,
  type RunReader,
} from './local-agent.store';
import { companionPolicy, runnable } from './policy';

const PROMPT_LIMIT = 32_000;

/**
 * `run.start`'s `conversationKey`: opaque and stable per project, so the companion can give the
 * CLI one directory per project and its resume finds the session it saved there. A digest, so no
 * id lands in a path on the device.
 */
export function conversationKeyOf(orgId: string, projectId: string): string {
  return createHash('sha256').update(`${orgId}:${projectId}`).digest('hex').slice(0, 32);
}

/** Whether the run may still use its device: answers the failure when it may not. */
type Authorise = () => Promise<RunOutcome | undefined>;

/**
 * The local agent as a `RunExecutor` (spec 040 § 3 decision 4). A fresh turn publishes `run.start`
 * to the device's command stream, then this consumes the turn's companion-event stream and maps
 * each event through `ctx.emit`; the consumer keeps fencing, transitions and persistence as for
 * any run. A re-claimed attempt (`running`) picks the stream up at its saved cursor instead.
 *
 * Every attempt first re-checks that the device is still the starter's and live, and that the
 * starter still holds `project:agent.run` (spec 040 § 3, authorisation); the device check repeats
 * at each idle tick, and a revocation aborts the run at once through its control stream.
 *
 * Approvals: a companion `approval.request` is emitted durably and recorded with its deadline; a
 * person's decision arrives on the run's control stream (`RunApprovalController`), and this —
 * the fence holder — emits the one `approval.resolved`, writes it under the fence, and only then
 * drops the request and answers the device. A wait past `approvalTimeoutMs` is denied
 * `by: 'timeout'`; a run that ends first resolves what is left `by: 'run-ended'`.
 *
 * The sandbox tool bridge (spec 041): a run in the `sandbox` tool mode first readies the project's
 * sandbox as the cloud agent does (`SandboxTools.prepare`), offers the CLI the sandbox tools in
 * `run.start`, runs each `tool.call` through the broker exactly as a cloud tool call — the same
 * milestones, step bound and `tool_error` rule — and answers it with `tool.result`. A completed
 * turn is checkpointed. Approvals are not used: the tools act only inside the sandbox.
 */
@Injectable()
export class LocalAgentExecutor implements LocalRunExecutor, OnModuleInit {
  private readonly logger = new Logger(LocalAgentExecutor.name);
  private readonly enabled: boolean;
  private readonly policy: CompanionPolicy;

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
    // 041: wakes a stopped agent home; absent only in a spec that does not exercise one.
    @Optional() @Inject(AgentHomeService) private readonly homes?: AgentHomeService,
  ) {
    this.enabled = config.get('LOCAL_AGENT_ENABLED', { infer: true });
    this.policy = companionPolicy(
      config.get('LOCAL_AGENT_CODEX_CHATGPT_AUTH', { infer: true }) === 'allow',
    );
  }

  onModuleInit(): void {
    if (this.enabled) this.registry.register(this);
  }

  /**
   * Run admission (spec 040 § 6): the caller's own live device, online, its CLI ready, the
   * workspace known. No workspace is the `sandbox` tool mode (spec 041), which needs of the
   * project's sandbox what a cloud run does at creation — nothing: the attempt readies it.
   */
  async admit(
    tx: TenantTransaction,
    run: { orgId: string; projectId: string; runId: string; userId: string },
    target: LocalAgentRunTarget,
  ): Promise<void> {
    // 041: the sandbox tool mode drives the CLI through Claude Code's tool server; Claude only.
    if (target.workspaceId === undefined && target.provider !== 'claude') {
      throw new ValidationFailedError('custom', [
        {
          code: 'sandbox_tools_claude_only',
          detail: 'Only Claude Code can run on the project sandbox; name a workspace for Codex.',
          pointer: '/localAgent/provider',
        },
      ]);
    }

    const device = await this.repository.deviceOn(tx, target.deviceId);

    if (device?.userId !== run.userId || device.revokedAt !== null) {
      throw new NotFoundError('No such device among yours.');
    }

    // 041: an agent home runs only subscription runs, which reach it by `subscription`.
    if (device.kind === 'cloud') {
      throw new ValidationFailedError('custom', [
        {
          code: 'device_not_local',
          detail: 'Choose one of your own computers.',
          pointer: '/localAgent/deviceId',
        },
      ]);
    }

    if (!(await this.channel.online(device.id))) {
      throw new DomainError(
        'local-agent-offline',
        `${device.name} is offline. Start baios-companion on it and try again.`,
        { deviceId: device.id },
      );
    }

    const status = await this.channel.status(device.id);
    const provider = status?.providers.find((each) => each.provider === target.provider);

    if (provider === undefined || !runnable(provider, this.policy)) {
      throw new DomainError(
        'local-agent-provider-unavailable',
        `${target.provider} is not ready on ${device.name}: install it, sign it in with baios-companion login ${target.provider}, or use a sign-in this deployment allows.`,
        { deviceId: device.id, provider: target.provider },
      );
    }

    const { workspaceId } = target;

    if (
      workspaceId !== undefined &&
      !status!.workspaces.some((workspace) => workspace.id === workspaceId)
    ) {
      throw new DomainError(
        'local-agent-workspace-unknown',
        `${device.name} has no workspace with that id. Register it with baios-companion workspace add.`,
        { deviceId: device.id, workspaceId: target.workspaceId },
      );
    }

    await this.repository.insertRun(tx, {
      deviceId: device.id,
      orgId: run.orgId,
      permissionMode: target.permissionMode ?? 'default',
      provider: target.provider,
      runId: run.runId,
      toolMode: workspaceId === undefined ? 'sandbox' : 'workspace',
      workspaceId: workspaceId ?? null,
    });
  }

  /**
   * Spec 041: a run on the person's own Claude subscription, in their cloud agent home — signed in
   * by the runner's last status report, else `subscription-not-connected`. Recorded as a
   * sandbox-tool-mode run on the home's device; the attempt wakes the home if it is stopped.
   */
  async admitSubscription(
    tx: TenantTransaction,
    run: { orgId: string; projectId: string; runId: string; userId: string },
    target: SubscriptionRunTarget,
  ): Promise<void> {
    if (this.homes?.enabled !== true) {
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
      permissionMode: 'default',
      provider: target.provider,
      runId: run.runId,
      toolMode: 'sandbox',
      workspaceId: null,
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

    const origin: LocalAgentOrigin =
      this.homes !== undefined && (await this.homes.isHome(target.deviceId))
        ? 'subscription'
        : 'device';
    const authorise: Authorise = () => this.authorise(context, target);

    try {
      // Authority first: a revoked device or a starter who lost access never wakes (or pays for) a home.
      const refused = await authorise();

      if (refused !== undefined) return withOrigin(refused, origin);

      // 041: a home's runner may be stopped (idle) — start it and wait (≤ 120 s, cancellable)
      // before `run.start`. The wake bumps `last_used_at` first, so an idle stop spares the home.
      if (origin === 'subscription') {
        const woken = await this.homes!.wake(target.deviceId, {
          cancelled: () => context.cancelled(),
          signal: context.signal,
        });
        if (woken === 'cancelled') return { kind: 'stopped' };
        if (woken !== 'online') {
          return withOrigin(LOCAL_FAILURES.transport(target.provider), origin);
        }
      }

      return withOrigin(await this.attempt(context, target, authorise), origin);
    } finally {
      // The idle clock restarts when a run ends; a failed write must not replace the outcome.
      if (origin === 'subscription') {
        await this.homes?.touchDevice(target.deviceId).catch(() => undefined);
      }
    }
  }

  private async attempt(
    context: ExecutionContext,
    target: LocalAgentRunRow,
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
        sandbox: target.toolMode === 'sandbox' ? this.sandbox : undefined,
        timings: this.timings,
      }).execute();

      this.logger.log(
        `local run ended: run=${run.id} device=${target.deviceId} provider=${target.provider} outcome=${outcome.kind}`,
      );

      return outcome;
    } finally {
      reader.close();
    }
  }

  /**
   * Only the starter's own live device runs their prompts, and only while they may still run
   * agents in the project: a device revoked or re-owned since admission, or a starter removed or
   * downgraded since, fails the run rather than act on authority it no longer has.
   */
  private async authorise(
    context: ExecutionContext,
    target: LocalAgentRunRow,
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
  /** Set for the `sandbox` tool mode (spec 041) only. */
  readonly sandbox: SandboxTools | undefined;
  readonly timings: LocalAgentTimings;
}

/** One attempt at one turn: the state the loop keeps between reads. */
class LocalRun {
  private readonly pending = new Map<string, number>();
  private readonly openSteps: string[] = [];
  /** The CLI's own ids for its bridged tool calls, whose events the server's tool calls replace. */
  private readonly bridged = new Set<string>();
  /** The step bound's count, as the cloud agent keeps it: from the committed `tool.end`s. */
  private readonly counter: { steps: number };
  private broker: ToolBroker | undefined;
  private interruptedAt: number | undefined;
  private readonly channel: RunChannel;
  private readonly timings: LocalAgentTimings;
  /** 1 for the prompt, +1 per answer: the companion dedupes `run.start` on (run, turn). */
  private readonly turn: number;
  private text = '';
  private cursor: RunCursor = { control: '0-0', events: '0-0' };
  private turnStartedAt = 0;
  /** Set once `run.start` is out, cleared by the companion's first event of the turn. */
  private startDeadline: number | undefined;

  constructor(
    private readonly context: ExecutionContext,
    private readonly target: LocalAgentRunRow,
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

    // Whatever is still waiting is closed now, so a reload never shows a live prompt on a dead run.
    for (const requestId of [...this.pending.keys()]) {
      await this.resolve(requestId, 'deny', 'run-ended');
    }

    // From here the uplink refuses this turn's events: a late retry cannot reach the next turn.
    await this.channel.endTurn(this.runId);

    return outcome;
  }

  private async loop(): Promise<RunOutcome> {
    const { run } = this.context;
    const { provider } = this.target;

    // 041: the sandbox is made ready, probed and baselined on every attempt, as a cloud run's is.
    if (this.deps.sandbox !== undefined) {
      const prepared = await this.deps.sandbox.prepare(this.context);
      if (prepared !== undefined) {
        return run.status === 'starting' ? prepared : this.end(prepared);
      }
      this.broker = this.deps.sandbox.broker(run);
    }

    if (run.status === 'starting') {
      const started = await this.start();
      if (started !== undefined) return started;
    } else {
      this.cursor = await this.channel.cursor(this.runId);
      for (const [requestId, deadline] of await this.channel.approvals(this.runId)) {
        this.pending.set(requestId, deadline);
      }
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

      // Deadlines that hold however busy or online the device is (spec 040 § 6); a cancel already
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

      for (const [requestId, deadline] of [...this.pending]) {
        if (now >= deadline && (await this.resolve(requestId, 'deny', 'timeout'))) {
          await this.respond(requestId, 'deny', 'No one answered in time.');
        }
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

      for (const { decision, id } of read.decisions) {
        this.cursor = { ...this.cursor, control: id };
        await this.decide(decision);
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

      if (read.events.length > 0 || read.decisions.length > 0) {
        await this.channel.saveCursor(this.runId, this.cursor);
      }
    }
  }

  /**
   * A fresh turn: wait out the grace for the device, re-check its CLI against the policy on its
   * current report, then — under the fence, so a stale attempt sends nothing — open the turn and
   * hand the device the prompt.
   */
  private async start(): Promise<RunOutcome | undefined> {
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
      await this.channel.beginTurn(this.runId, this.turn, this.turnStartedAt);
      await this.channel.publish(deviceId, {
        conversationKey: conversationKeyOf(run.orgId, run.projectId),
        model: run.model === provider ? null : run.model,
        permissionMode: this.target.permissionMode,
        prompt: prompt.slice(0, PROMPT_LIMIT),
        provider,
        resume:
          this.target.providerSessionId === null
            ? null
            : { providerSessionId: this.target.providerSessionId },
        runId: this.runId,
        toolMode: this.target.toolMode,
        ...(this.broker === undefined ? {} : { toolset: this.deps.sandbox!.toolset(this.broker) }),
        turn: this.turn,
        type: 'run.start',
        workspaceId: this.target.workspaceId,
      });
    });
    this.startDeadline = this.now() + this.timings.startAckMs;

    return undefined;
  }

  /** The run ends on this side whatever the device does: tell it to stop, and fail the run. */
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
        // 041: the server's own tool call is the step of record; the CLI's view of it is a duplicate.
        if (this.broker !== undefined && sandboxToolOf(event.data.name) !== undefined) {
          this.bridged.add(event.data.toolId);
          return undefined;
        }
        this.openSteps.push(stepIdOf(this.runId, event.data.toolId));
        break;
      case 'tool.output':
        if (this.bridged.has(event.data.toolId)) return undefined;
        break;
      case 'tool.end': {
        if (this.bridged.delete(event.data.toolId)) return undefined;
        const index = this.openSteps.lastIndexOf(stepIdOf(this.runId, event.data.toolId));
        if (index !== -1) this.openSteps.splice(index, 1);
        break;
      }
      case 'tool.call':
        return this.toolCall(event.data);
      case 'approval.request': {
        const { requestId } = event.data;
        // 041: nothing on the bridge needs a person's say — the tools act inside the sandbox.
        if (this.broker !== undefined) {
          await this.respond(requestId, 'deny', 'Approvals are not used on a sandbox run.');
          return undefined;
        }
        if (this.pending.has(requestId)) return undefined;
        const deadline = this.now() + this.timings.approvalTimeoutMs;
        await this.channel.addApproval(this.runId, requestId, deadline);
        this.pending.set(requestId, deadline);
        await this.context.emit({ data: event.data, type: 'approval.request' });
        return undefined;
      }
      case 'terminal': {
        const outcome = terminalOutcome(event.data, this.target.provider);
        // The assistant's words are the conversation of record, so the next turn has them (§ 3.9).
        if (outcome.kind === 'awaiting_input' && this.text.trim() !== '') {
          await this.context.persist({ content: this.text, role: 'assistant', toolCalls: [] });
        }
        // 041: a completed turn on the sandbox is checkpointed, as a cloud run's last turn is.
        if (outcome.kind === 'awaiting_input' && this.deps.sandbox !== undefined) {
          return (await this.deps.sandbox.checkpoint(this.context, this.turn)) ?? outcome;
        }
        return outcome;
      }
      default:
        break;
    }

    const mapped = mapCompanionEvent(this.runId, event, this.openSteps.at(-1));

    if (mapped !== undefined) await this.context.emit(mapped);

    return undefined;
  }

  /**
   * 041: one bridged call, run exactly as the cloud agent runs one (`SandboxTools.call`: schema
   * check, step bound, fenced dispatch, the same milestones), answered to the device. A call the
   * run cannot take — not a sandbox run, or one stopping — is answered as a refusal. The third
   * failed call in a row ends the run in the consumer; the device is told to stop with it.
   */
  private async toolCall(
    data: Extract<CompanionRunEvent, { type: 'tool.call' }>['data'],
  ): Promise<RunOutcome | undefined> {
    const { broker, deps } = this;

    if (broker === undefined || deps.sandbox === undefined || this.interruptedAt !== undefined) {
      const detail =
        broker === undefined ? 'this run does not use the sandbox tools' : 'the run is stopping';
      await this.toolResult(data.callId, { detail, kind: 'not-allowed', ok: false });
      return undefined;
    }

    let result: BrokerResult | 'step-limit';
    try {
      result = await deps.sandbox.call(this.context, broker, data, this.counter);
    } catch (error) {
      // A fence means another attempt holds the run (and the device); anything else ends it here.
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

  private async decide(decision: ApprovalDecision): Promise<void> {
    if (!this.pending.has(decision.requestId)) return;
    if (await this.resolve(decision.requestId, decision.decision, 'user')) {
      await this.respond(decision.requestId, decision.decision, decision.message);
    }
  }

  /**
   * Idempotent per request: emitted and written under the fence first, dropped from Redis after.
   * A stale attempt throws at the write and leaves the request for its successor; an attempt that
   * dies between the write and the drop has its successor resolve it again (the web keeps one).
   */
  private async resolve(
    requestId: string,
    decision: RunApprovalDecision,
    by: 'user' | 'timeout' | 'run-ended',
  ): Promise<boolean> {
    this.pending.delete(requestId);

    if (!(await this.channel.hasApproval(this.runId, requestId))) return false;

    await this.context.emit({ data: { by, decision, requestId }, type: 'approval.resolved' });
    await this.context.flush();
    await this.channel.resolveApproval(this.runId, requestId);

    return true;
  }

  private respond(requestId: string, decision: RunApprovalDecision, message?: string) {
    return this.channel.publish(this.target.deviceId, {
      decision,
      ...(message === undefined ? {} : { message }),
      requestId,
      runId: this.runId,
      type: 'approval.respond',
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
