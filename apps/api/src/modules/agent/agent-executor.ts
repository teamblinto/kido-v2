import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { TenantContext } from '../../database/tenant-context';
import { CheckpointService } from '../checkpoints/checkpoint.service';
import { SANDBOX_LIFECYCLE, type SandboxLifecycle } from '../sandbox/sandbox-lifecycle';
import { SANDBOX_TIMINGS, type SandboxTimings } from '../sandbox/sandbox.constants';
import { SANDBOX_PORT, type SandboxPort, type SandboxRef } from '../sandbox/sandbox.port';
import {
  AGENT_ALLOWED_TOOLS,
  AGENT_TIMINGS,
  type AgentTimings,
  REFRESH_FLOOR_MS,
} from './agent.constants';
import { credentialFailed } from './byok/credential-failure';
import { CredentialResolver } from './byok/credential-resolver';
import { ProviderKeyService } from './byok/provider-key.service';
import { ByosTokenService } from './byos/byos-token.service';
import { SubscriptionFailure } from './byos/subscription-client.port';
import { type AttemptScope, ContextAssembler } from './context/context-assembler';
import {
  type ConversationMessage,
  type CredentialContext,
  type Delta,
  LLM_PROVIDER,
  type LlmClient,
  type LlmProvider,
  type ModelRequest,
  type ModelTurn,
} from './llm-provider.port';
import { resumeBoundary, SYSTEM_PROMPT_VERSION, toMessages } from './prompt';
import { ProviderError } from './provider-error';
import type { ExecutionContext, RunExecutor, RunOutcome } from './run-executor.port';
import { RunStore } from './run-store';
import { ALL_TOOLS, failed, SandboxTools, sleep, toolContent } from './sandbox-tools';
import type { ToolName } from './tools';

interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/**
 * 032 R10: what one attempt is paying with, and the client built on it. A BYOS token is refreshed
 * between turns, so both are replaced in place; everything that calls the model (the loop and the
 * 021 summariser through the scope) reads this holder, never a copy.
 */
interface AttemptCredential {
  current: CredentialContext;
  client: LlmClient;
  /** 032 T046: set once this attempt has cleared the account's recorded limit. */
  limitCleared?: boolean;
}

/** The reason a model call's signal carries when `cancelled()` said stop mid-stream (R9). */
class CancelledError extends Error {
  constructor() {
    super('run cancelled');
    this.name = 'CancelledError';
  }
}

/**
 * The real `RUN_EXECUTOR` (spec 011, data-model.md § executor, research R4/R5/R8): one client per
 * run from the credential the resolver answers (020 R6), the conversation rebuilt from
 * `run_messages`, and the loop
 * call → store the turn → dispatch its tools through the broker → store the results → call again,
 * until the model ends its turn, the step ceiling is hit, or `cancelled()` says stop. The consumer
 * owns every transition; this only emits milestones and says how it ended.
 */
@Injectable()
export class AgentExecutor implements RunExecutor {
  private readonly logger = new Logger(AgentExecutor.name);
  /** The sandbox half (pre-flight, tool calls, checkpoints), shared with the local bridge. */
  private readonly sandbox: SandboxTools;

  constructor(
    @Inject(LLM_PROVIDER) private readonly provider: LlmProvider,
    @Inject(SANDBOX_PORT) private readonly port: SandboxPort,
    // 014: readiness before the first tool call; `tenant.tx` is the scope `dispatch` opens.
    @Inject(SANDBOX_LIFECYCLE) private readonly lifecycle: SandboxLifecycle,
    @Inject(TenantContext) private readonly tenant: TenantContext,
    // 020 R6: the credential per attempt — the org's key or the starter's subscription — and the
    // row stamp.
    @Inject(CredentialResolver) private readonly resolver: CredentialResolver,
    @Inject(RunStore) private readonly store: RunStore,
    // 020 R7: a provider 401 on the org's key marks it `needs_reauth` in the same dispatch.
    @Inject(ProviderKeyService) private readonly keys: ProviderKeyService,
    // T034 (retry backoff) and T038 (cancel poll) drive these.
    @Inject(AGENT_TIMINGS) private readonly timings: AgentTimings,
    @Inject(SANDBOX_TIMINGS) private readonly sandboxTimings: SandboxTimings,
    @Inject(CLOCK) private readonly clock: ClockPort,
    // 016: the turn-end commit, in the same dispatch scope as the tools.
    @Inject(CheckpointService) private readonly checkpoints: CheckpointService,
    // 021 T011: the context seam — map, excerpts and the conversation to send, per call.
    @Inject(ContextAssembler) private readonly assembler: ContextAssembler,
    // 032 R10: a fresh subscription token between turns.
    @Inject(ByosTokenService) private readonly byosTokens: ByosTokenService,
    // T030: narrows the tools offered/dispatched for a run; T031's e2e overrides this token.
    @Optional()
    @Inject(AGENT_ALLOWED_TOOLS)
    private readonly allowed: ReadonlySet<ToolName> = ALL_TOOLS,
  ) {
    this.sandbox = new SandboxTools({
      allowed: this.allowed,
      checkpoints: this.checkpoints,
      clock: this.clock,
      lifecycle: this.lifecycle,
      port: this.port,
      sandboxTimings: this.sandboxTimings,
      tenant: this.tenant,
    });
  }

  async execute(context: ExecutionContext): Promise<RunOutcome> {
    const { run } = context;
    const counter = { steps: run.committed.toolEnds };
    const started = this.clock.now().getTime();
    const outcome = await this.run(context, counter);

    this.logger.log(
      `run ended: run=${run.id} model=${run.model} prompt.version=${SYSTEM_PROMPT_VERSION} ` +
        `steps=${String(counter.steps)} outcome=${outcome.kind} ` +
        `ms=${String(this.clock.now().getTime() - started)}`,
    );

    return outcome;
  }

  private async run(context: ExecutionContext, counter: { steps: number }): Promise<RunOutcome> {
    const { run } = context;
    const resolution = await context.dispatch(() =>
      this.resolver.forModel(
        this.tenant.tx,
        run.orgId,
        run.userId,
        run.model,
        run.credentialChoice === 'organisation' ? { credential: 'organisation' } : {},
      ),
    );
    // 032 R7: the starter's own subscription refuses rather than falling through, without a call.
    if (resolution.kind === 'subscription-needs-reauth') {
      return credentialFailed('unauthorised', { ...resolution, mode: 'BYOS' });
    }
    if (resolution.kind === 'subscription-limited') {
      return credentialFailed(
        'rate-limited',
        { ...resolution, mode: 'BYOS' },
        { resetsAt: resolution.resetsAt },
      );
    }
    if (resolution.kind === 'needs_reauth') {
      // 020 US3: the create refused it; an attempt that still reaches here (the key rejected
      // mid-flight, then resumed) fails the same way, without a provider call.
      return credentialFailed('unauthorised', {
        keyLastFour: resolution.lastFour,
        provider: resolution.provider,
      });
    }
    if (resolution.kind !== 'byok' && resolution.kind !== 'byos') {
      return failed('no-credential');
    }
    const { credential } = resolution;
    await context.dispatch(() =>
      this.store.setCredentialMode(
        this.tenant.tx,
        { epoch: run.epoch, orgId: run.orgId, runId: run.id },
        credential.mode,
      ),
    );

    const ref: SandboxRef = { orgId: run.orgId, projectId: run.projectId };
    // Pre-flight (014 readiness, the probe, the 016 baseline): `SandboxTools.prepare`.
    const prepared = await this.sandbox.prepare(context);
    if (prepared !== undefined) return prepared;

    const broker = this.sandbox.broker(run);
    const holder: AttemptCredential = {
      client: this.provider.client(credential, run.model),
      current: credential,
    };
    // 021: the seam sees what the attempt holds; `prepare` once the baseline exists (R2). The
    // getters read the holder, so a refreshed BYOS token reaches the summariser too (032 R10).
    const scope: AttemptScope = {
      get client() {
        return holder.client;
      },
      get credential() {
        return holder.current;
      },
      dispatch: (fn) => context.dispatch(fn),
      emit: (event) => context.emit(event),
      fence: { epoch: run.epoch, orgId: run.orgId, runId: run.id },
      ref,
      run,
      // Lazy: `TenantContext.tx` throws outside a tenant scope, so it is read inside `dispatch`.
      tenantTx: () => this.tenant.tx,
    };
    await this.assembler.prepare(scope);
    const conversation: ConversationMessage[] = toMessages(run.messages);
    let turns = run.messages.filter((message) => message.role === 'assistant').length;
    const boundary = resumeBoundary(run.messages);
    let pending: readonly ToolCall[] | undefined =
      boundary === 'dispatch' ? (run.messages.at(-1)?.toolCalls as ToolCall[]) : undefined;
    // R8 / spec US4 scenario 2: a resumed attempt at a `call` boundary cannot know whether the dead
    // one issued that call or died just before it, so it over-marks: the first `usage` names the
    // turn the call would be — the honest side of at-least-once. The signal is the status the run
    // was claimed in: `running` / `tool_error` means an executor was mid-flight; `starting` means
    // none ran yet (a fresh run, or a worker dead before the loop), whatever the epoch says.
    let duplicateOf =
      boundary === 'call' && (run.status === 'running' || run.status === 'tool_error')
        ? `${run.id}/turn-${String(turns + 1)}`
        : undefined;

    for (;;) {
      if (pending === undefined) {
        const refreshed = await this.refreshIfDue(run, holder);
        if (refreshed !== undefined) return refreshed;
        // Once per turn, not per retry: `attempt` re-sends this same request object.
        const assembled = await this.assembler.request(scope, conversation);
        const turn = await this.attempt(context, holder, {
          context: assembled.context,
          messages: assembled.messages,
          system: assembled.system,
          tools: broker.definitions(),
        });
        if ('kind' in turn) return turn;
        turns += 1;
        // ponytail: costMicros 0 — 019 prices the roll-up. The spread carries `cacheReadTokens` /
        // `cacheWriteTokens` (021 R6) to the event; `EventBatcher.flush` sums them onto the row.
        const usage = { costMicros: 0, ...turn.usage };
        await context.emit({
          data: duplicateOf === undefined ? usage : { ...usage, duplicateOf },
          type: 'usage',
        });
        duplicateOf = undefined;

        if (turn.stop === 'max_tokens' && turn.toolCalls.length > 0) return failed('rejected');

        if (turn.toolCalls.length === 0) {
          if (turn.text !== '') {
            await context.persist({ content: turn.text, role: 'assistant', toolCalls: [] });
          }
          // 016 FR-006/FR-007: the turn-end commit and its `checkpoint` milestone.
          return (await this.sandbox.checkpoint(context, turns)) ?? { kind: 'succeeded' };
        }

        const toolCalls = [...turn.toolCalls];
        await context.persist({ content: turn.text, role: 'assistant', toolCalls });
        conversation.push(
          turn.text === ''
            ? { role: 'assistant', toolCalls }
            : { role: 'assistant', text: turn.text, toolCalls },
        );
        pending = toolCalls;
      }

      const results: { toolUseId: string; content: string; isError: boolean }[] = [];
      let stopped = false;
      // ponytail: sequential — reads could fan out, but one open tenant transaction per call is
      // the ceiling R5 names, and the model reads results in order anyway.
      // ponytail: resume granularity is the turn, not the step — one `tool` row per turn (R7), so
      // a worker dying after tool k of n has k results nowhere durable and the resumed attempt
      // re-dispatches all n under new step ids (exec re-runs, whole-file edits are idempotent,
      // anchored edits fail the second time and the model learns that); 017's sandbox-side
      // operation ids are the upgrade.
      for (const call of pending) {
        // A cancel lands between calls: the running tool finishes and its result is stored (R9).
        stopped = await context.cancelled();
        if (stopped) break;
        const result = await this.sandbox.call(context, broker, call, counter);
        if (result === 'step-limit') return failed('step-limit');
        results.push({
          content: toolContent(result),
          isError: !result.ok,
          toolUseId: call.id,
        });
      }

      if (results.length > 0) {
        await context.persist({ content: JSON.stringify(results), role: 'tool' });
        conversation.push({ results, role: 'tool' });
      }
      if (stopped || (await context.cancelled())) return { kind: 'stopped' };
      await this.assembler.afterTools(
        scope,
        pending.map((call) => call.name as ToolName),
      );
      pending = undefined;
    }
  }

  /**
   * 032 R10: before a turn, a BYOS token with less than `REFRESH_FLOOR_MS` left is exchanged for a
   * fresh one — the starter's, never anyone else's — and the client rebuilt through the unchanged
   * port call. A refresh the provider rejects ends the attempt as a credential failure.
   */
  private async refreshIfDue(
    run: ExecutionContext['run'],
    holder: AttemptCredential,
  ): Promise<RunOutcome | undefined> {
    const { current } = holder;
    if (current.mode !== 'BYOS' || current.expiresAt === undefined) return undefined;
    if (current.expiresAt.getTime() - this.clock.now().getTime() >= REFRESH_FLOOR_MS) {
      return undefined;
    }
    try {
      holder.current = await this.byosTokens.current(run.userId, current.provider);
    } catch (error) {
      if (error instanceof SubscriptionFailure) return credentialFailed('unauthorised', current);
      if (error instanceof ProviderError) return failed(error.class);
      throw error;
    }
    holder.client = this.provider.client(holder.current, run.model);
    return undefined;
  }

  /**
   * 032 T041: a subscription's 401 — the token may have been revoked or rotated under us — earns
   * one forced refresh. A refresh the provider rejects has already marked the account and queued
   * its one mail; the attempt ends as a credential failure with no further model call.
   */
  private async forceRefresh(
    run: ExecutionContext['run'],
    holder: AttemptCredential,
  ): Promise<RunOutcome | undefined> {
    const { current } = holder;
    try {
      holder.current = await this.byosTokens.current(run.userId, current.provider, {
        force: true,
      });
    } catch (error) {
      if (error instanceof SubscriptionFailure) return credentialFailed('unauthorised', current);
      if (error instanceof ProviderError) return failed(error.class);
      throw error;
    }
    holder.client = this.provider.client(holder.current, run.model);
    return undefined;
  }

  /**
   * 032 T046 (R11): a subscription's limit is the person's, and waiting it out is not this run's
   * to do. A reset longer than the retry budget allows — or any limit once the budget is spent —
   * ends the attempt now; a given reset is recorded on the account (health untouched) and rides
   * to the `state` event as `resetsAt`. A short wait with attempts left is retried as before.
   */
  private async subscriptionLimit(
    context: ExecutionContext,
    credential: CredentialContext,
    error: ProviderError,
    attempt: number,
    attempts: number,
  ): Promise<RunOutcome | undefined> {
    const spent = attempt >= attempts;
    const tooLong =
      error.retryAfterMs !== undefined && error.retryAfterMs > this.timings.providerBackoffCapMs;
    if (!spent && !tooLong) return undefined;
    if (error.retryAfterMs === undefined) return credentialFailed('rate-limited', credential);
    const resetsAt = new Date(this.clock.now().getTime() + error.retryAfterMs);
    await this.byosTokens.setLimitedUntil(context.run.userId, credential.provider, resetsAt);
    return credentialFailed('rate-limited', credential, { resetsAt });
  }

  /**
   * One model call with R3's retry (FR-020..023): a transient class is re-issued with the identical
   * request up to `providerAttempts` (a malformed response once), the wait full-jitter
   * `min(cap, base · 2^n)` or the service's `retry-after`, capped, cut short by the consumer's
   * signal, and `cancelled()` asked after it, before each retry. Any
   * other class, or the last attempt, ends the run `failed` / `executor` / the class. The log line
   * carries the class, the attempt and the request id — never the message or a body byte.
   * On the organisation's own key (020 R7) `unauthorised` marks the key `needs_reauth` and an
   * exhausted `rate-limited` names the key's quota — both the `credential` class, its sentence.
   * ponytail: a rate limit fails the run here; 019 maps `rate-limited` → `paused`.
   *
   * Cancellation (R9, FR-020): one signal per call, fired by the consumer's `signal` (its reason
   * forwarded) or by a `cancelled()` poll — at a delta boundary, at most every `cancelPollMs` on
   * the clock, and every `cancelPollMs` on a timer while the stream is idle. An aborted call
   * resolves nothing, so nothing partial is ever stored.
   */
  private async attempt(
    context: ExecutionContext,
    holder: AttemptCredential,
    request: ModelRequest,
  ): Promise<ModelTurn | RunOutcome> {
    const { cancelPollMs, providerAttempts, providerBackoffBaseMs, providerBackoffCapMs } =
      this.timings;
    // 032 T041: one forced refresh per turn on a subscription's 401.
    let forced = false;
    for (let attempt = 1; ; attempt += 1) {
      const { client, current: credential } = holder;
      const controller = new AbortController();
      const signal = AbortSignal.any([context.signal, controller.signal]);
      let polledAt = this.clock.now().getTime();
      // Single-flight: a slow row read never stacks a second poll behind it.
      let polling = false;
      const poll = () => {
        if (polling) return;
        polledAt = this.clock.now().getTime();
        polling = true;
        void context
          .cancelled()
          .then((cancelled) => cancelled && controller.abort(new CancelledError()))
          .catch((error: unknown) => {
            // The heartbeat fences a dead store; until then the stream runs on, diagnosably.
            this.logger.debug(
              `cancel poll failed: run=${context.run.id} ` +
                `error=${error instanceof Error ? error.name : 'unknown'}`,
            );
          })
          .finally(() => {
            polling = false;
          });
      };
      // A stream that goes quiet (socket open, no chunk) would never reach the delta poll; the
      // global timer, as `sleep` uses, so a suite's fake clock can drive it.
      const idle = setInterval(poll, cancelPollMs);
      try {
        const turn = await client
          .complete(request, {
            onDelta: (delta) => {
              this.stream(context, delta);
              if (this.clock.now().getTime() - polledAt >= cancelPollMs) poll();
            },
            signal,
          })
          .finally(() => {
            clearInterval(idle);
          });
        // 032 T046: the first successful call on a subscription clears a recorded limit.
        if (credential.mode === 'BYOS' && holder.limitCleared !== true) {
          holder.limitCleared = true;
          await this.byosTokens.clearLimit(context.run.userId, credential.provider);
        }
        return turn;
      } catch (error) {
        if (signal.reason instanceof CancelledError) return { kind: 'stopped' };
        // The consumer's signal: its reason (fence, shutdown) is what it expects back.
        if (context.signal.aborted) throw context.signal.reason;
        if (!(error instanceof ProviderError)) throw error;
        this.logger.warn(
          `provider failed: run=${context.run.id} class=${error.class} ` +
            `attempt=${String(attempt)} requestId=${error.requestId ?? '-'}`,
        );
        const attempts = error.class === 'malformed-response' ? 2 : providerAttempts;
        const byok = credential.mode === 'BYOK';
        if (byok && error.class === 'unauthorised') {
          await context.dispatch(() =>
            this.keys.markRejected(this.tenant.tx, context.run.orgId, credential.provider, {
              runId: context.run.id,
            }),
          );
          return credentialFailed('unauthorised', credential);
        }
        if (credential.mode === 'BYOS' && error.class === 'unauthorised') {
          // A second 401 after a refresh that worked is the provider saying no (T041).
          if (forced) {
            await this.byosTokens.markRejected(context.run.userId, credential.provider);
            return credentialFailed('unauthorised', credential);
          }
          forced = true;
          const refreshed = await this.forceRefresh(context.run, holder);
          if (refreshed !== undefined) return refreshed;
          attempt -= 1;
          continue;
        }
        if (credential.mode === 'BYOS' && error.class === 'rate-limited') {
          const limited = await this.subscriptionLimit(
            context,
            credential,
            error,
            attempt,
            attempts,
          );
          if (limited !== undefined) return limited;
        }
        if (!error.transient || attempt >= attempts) {
          return byok && error.class === 'rate-limited'
            ? credentialFailed('rate-limited', credential)
            : failed(error.class);
        }
        const backoff =
          Math.random() *
          Math.min(providerBackoffCapMs, providerBackoffBaseMs * 2 ** (attempt - 1));
        // The wait ends early on the consumer's signal (fence, shutdown) and is followed by the
        // cancel check, so a cancel landing during it costs no further request.
        await sleep(Math.min(providerBackoffCapMs, error.retryAfterMs ?? backoff), context.signal);
        if (context.signal.aborted) throw context.signal.reason;
        if (await context.cancelled()) return { kind: 'stopped' };
      }
    }
  }

  /** A text delta is a `token`, a thinking delta a `thought`; a refused stream-only emit is the
   *  signal's business, which `complete` reports. */
  private stream(context: ExecutionContext, delta: Delta): void {
    void context
      .emit({ data: { text: delta.text }, type: delta.kind === 'text' ? 'token' : 'thought' })
      .catch(() => undefined);
  }
}
