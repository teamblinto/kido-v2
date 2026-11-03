import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DURABLE_RUN_EVENT_TYPES,
  type RunEvent,
  type RunFailureClass,
  type RunStatus,
} from '@repo/contracts';
import { sql } from 'drizzle-orm';
import { hostname } from 'node:os';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import type { TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { EventConsumer } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import { SANDBOX_LIFECYCLE, type SandboxLifecycle } from '../sandbox/sandbox-lifecycle';
import { AGENT_QUEUE, AGENT_TIMINGS, type AgentTimings, RUN_EXECUTOR } from './agent.constants';
import { EventBatcherFactory } from './event-batcher';
import { RunControl } from './run-control';
import { RunExecutorRegistry } from './run-executor-registry';
import type {
  EmittedEvent,
  ExecutionContext,
  RunExecutor,
  RunOutcome,
  RunSnapshot,
} from './run-executor.port';
import { type Claim, type ClaimResult, FencedError, RunStore } from './run-store';
import { RunStreamPublisher } from './run-stream-publisher';
import { TRANSITIONS } from './run-state-machine';

const DURABLE = new Set<string>(DURABLE_RUN_EVENT_TYPES);
/** FR-008: the third failed `tool.end` in a row ends the run as `failed` / `tool_error`. */
const TOOL_ERROR_BOUND = 3;
const BOUND_REASON = 'three consecutive tool failures';

/**
 * The worker side of a run (spec 008 research R1/R5). `handle` is the claim — one fenced
 * compare-and-set on the base's transaction, `queued → starting` included — and `effect` runs
 * the executor holding no connection: every write it makes goes through `RunStore` under the
 * claim's epoch, in a tenant transaction of its own. The processed row lands only after `effect`
 * returns, so a run that stalls is re-delivered and claims again with `epoch + 1`.
 *
 * The queue and the lease are two clocks: BullMQ may re-deliver a stalled run before the lease
 * its dead worker held has run out. `claim` answers `{ heldUntil }` then, and `effect` waits it
 * out — at most one lease — and claims again, so the delivery is not spent on a no-op.
 *
 * A `FencedError` from `emit` or a transition propagates: the base classifies it terminal and the
 * fenced attempt dead-letters with the epoch in the log line — the audit of the fence firing.
 *
 * Cancel is cooperative (FR-022): `cancelled()` asks the control channel first and the row second,
 * and is asked before the run starts and by the executor at every boundary; the answer `stopped`
 * is committed as `cancelled` after the batch is flushed, so no milestone lands after that event.
 * A failed `tool.end` is `running → tool_error` and the next milestone `tool_error → running`
 * (FR-008); the third failure in a row ends the run as `failed` / `tool_error` and aborts the
 * executor through the signal.
 *
 * The stream (009, research R1/R6): the claim and every transition are followed by
 * `publisher.sync`, which puts the `state` event the store wrote on the stream under its seq and
 * tells the batcher what the next non-durable event follows. Non-durable events go through the
 * batcher like the rest — it keeps their order against the milestones — except that a fenced
 * attempt refuses them here: nothing else stands between a dead worker's `token` and the stream.
 */
@Injectable()
export class AgentRunConsumer extends EventConsumer<
  'agent-run.requested',
  ClaimResult | undefined
> {
  readonly attempts = 3;
  override readonly concurrency = 4;
  override readonly maxStalledCount = 2;
  readonly name = 'agent-run';
  override readonly profile = 'agent' as const;
  readonly queue = AGENT_QUEUE;
  readonly types = ['agent-run.requested'] as const;

  private readonly logger = new Logger(AgentRunConsumer.name);
  private readonly owner = `${hostname()}:${process.pid}:agent-run`;

  constructor(
    @Inject(RunStore) private readonly store: RunStore,
    @Inject(EventBatcherFactory) private readonly batchers: EventBatcherFactory,
    @Inject(RUN_EXECUTOR) private readonly executor: RunExecutor,
    @Inject(RunControl) private readonly control: RunControl,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(AGENT_TIMINGS) private readonly timings: AgentTimings,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(RunStreamPublisher) private readonly publisher: RunStreamPublisher,
    @Inject(SANDBOX_LIFECYCLE) private readonly lifecycle: SandboxLifecycle,
    // 040: a run created with a local target goes to the executor registered for it.
    @Inject(RunExecutorRegistry)
    private readonly executors: RunExecutorRegistry,
  ) {
    super();
  }

  async handle(
    event: Envelope<'agent-run.requested'>,
    tx: TenantTransaction,
  ): Promise<ClaimResult | undefined> {
    const { orgId, runId } = event.payload;

    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);

    return this.claim(tx, orgId, runId);
  }

  override async effect(
    event: Envelope<'agent-run.requested'>,
    result: ClaimResult | undefined,
  ): Promise<void> {
    const { orgId, runId } = event.payload;
    const inTx = <T>(fn: (tx: TenantTransaction) => Promise<T>) =>
      this.transactions.runInTenantTransaction(orgId, fn);
    let claim = result;

    // A live holder renews the lease, so a second `heldUntil` that moved forward means the run is
    // in good hands and this delivery is spare. One that did not move is a dead holder met on
    // its lease's last millisecond — the timer resolved with the wall clock still on it, and the
    // store reads `lease_until >= now` as held — and giving up there orphans a `running` run
    // until the reaper fails it. Claim once more after the millisecond has passed.
    while (claim !== undefined && 'heldUntil' in claim) {
      const seen = claim.heldUntil.getTime();
      const wait = seen - this.clock.now().getTime();

      await sleep(Math.min(Math.max(wait, 1), this.timings.leaseTtlMs));
      claim = await inTx((tx) => this.claim(tx, orgId, runId));

      if (claim !== undefined && 'heldUntil' in claim && claim.heldUntil.getTime() > seen) {
        return;
      }
    }

    // Terminal, or waiting on a person: nothing to do here.
    if (claim === undefined) {
      return;
    }

    await this.run(claim, inTx);
  }

  private claim(tx: TenantTransaction, orgId: string, runId: string) {
    return this.store.claim(tx, {
      leaseTtlMs: this.timings.leaseTtlMs,
      orgId,
      owner: this.owner,
      runId,
    });
  }

  private async run(
    claim: Claim,
    inTx: <T>(fn: (tx: TenantTransaction) => Promise<T>) => Promise<T>,
  ): Promise<void> {
    const { epoch, model, orgId, projectId, runId } = claim;
    const fence = { epoch, orgId, runId };
    const batcher = this.batchers.create(fence);
    const controller = new AbortController();
    // 040: a local run on its own workspace has no sandbox — it is neither required nor touched
    // (spec 040 § 3). 041: one on the sandbox tool bridge uses the project's sandbox as a cloud run.
    const local = await inTx((tx) => this.executors.select(tx, orgId, runId));
    const executor = local ?? this.executor;
    const touches =
      local === undefined ||
      (await inTx((tx) => this.executors.toolMode(tx, orgId, runId))) === 'sandbox';

    batcher.follow(await this.publisher.sync(orgId, runId));
    // Three beats per lease (R5): one that fails for the database's reasons is not a stall, but a
    // fenced one means another worker holds the run, and this attempt stops where it stands. The
    // beat is also the sandbox's sign of use (014 R8, FR-005): a run in flight is what keeps its
    // sandbox from idling. The lease is the fence and the touch a courtesy — one that fails is
    // logged, and the next beat touches again.
    const heartbeat = setInterval(() => {
      void inTx(async (tx) => {
        await this.store.heartbeat(tx, fence, this.timings.leaseTtlMs);
        if (!touches) return;
        await this.lifecycle.touch(tx, { orgId, projectId }).catch((error: unknown) => {
          this.logger.warn(
            `sandbox touch failed: run=${runId} ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }).catch((error: unknown) => {
        if (error instanceof FencedError) {
          controller.abort(error);
        }
      });
    }, this.timings.heartbeatMs);

    const cancelled = async () =>
      this.control.seen(runId) || inTx((tx) => this.store.cancelRequested(tx, orgId, runId));

    // 011 research R4: the heartbeat is the fence. Fence and insert commit together, so a stale
    // worker's message never lands, and the lease renewal is one the worker wanted anyway. The
    // batch flushes first, so no row outlives the events (`usage`, `tool.end`) that describe it.
    const persist: ExecutionContext['persist'] = async (message) => {
      await batcher.flush();
      await inTx(async (tx) => {
        await this.store.heartbeat(tx, fence, this.timings.leaseTtlMs);
        await this.store.insertMessage(tx, { ...message, orgId, runId });
      });
    };

    // 011 research R5: a tenant *scope*, not a bare transaction — the sandbox port resolves its
    // row through the ALS context — and the fence is checked in that same transaction, so a fenced
    // worker throws before any Daytona request is built.
    // ponytail: the transaction stays open for the tool's duration (≤ 120 s for exec) — one pooled
    // connection per in-flight tool; 014 caches the resolution so the check can close before the call.
    const dispatch: ExecutionContext['dispatch'] = (fn) =>
      this.transactions.runInTenantScope({ orgId, userId: null }, async (tx) => {
        await this.store.heartbeat(tx, fence, this.timings.leaseTtlMs);

        return fn();
      });

    // The status this attempt holds the run in. Every transition flushes first, so the batch is on
    // disk before the state event that follows it and the state event is the last seq written.
    let status: RunStatus = claim.status;
    let failures = 0;
    const move = async (change: {
      failureClass?: RunFailureClass;
      localAgentFailure?: LocalAgentFailure;
      reason?: string;
      resetsAt?: Date;
      to: RunStatus;
    }) => {
      await batcher.flush();
      await inTx((tx) => this.store.transition(tx, { ...fence, from: status, ...change }));
      status = change.to;
      batcher.follow(await this.publisher.sync(orgId, runId));
    };

    // FR-008's self-heal: a failed tool.end is `running → tool_error`; the next durable milestone
    // is `tool_error → running`; the third failure in a row ends the run and the executor with it.
    const write = async (event: EmittedEvent) => {
      if (!DURABLE.has(event.type) && controller.signal.aborted) {
        throw controller.signal.reason as Error;
      }

      if (event.type === 'tool.end' && !event.data.ok) {
        await batcher.push(event);
        await move({ reason: event.data.error, to: 'tool_error' });

        if ((failures += 1) === TOOL_ERROR_BOUND) {
          const bound = new Error(`Run ${runId}: ${BOUND_REASON}.`);

          await move({ failureClass: 'tool_error', reason: BOUND_REASON, to: 'failed' });
          controller.abort(bound);

          throw bound;
        }

        return;
      }

      if (event.type === 'tool.end') {
        failures = 0;
      }

      if (status === 'tool_error' && DURABLE.has(event.type)) {
        await move({ to: 'running' });
      }

      await batcher.push(event);
    };

    // A fence heard here — a push or a transition refused — ends the attempt as a fenced heartbeat
    // does, so the stream-only events after it stop at the check above (009 US3, SC-007).
    const emit = (event: EmittedEvent) =>
      write(event).catch((error: unknown) => {
        if (error instanceof FencedError) {
          controller.abort(error);
        }

        throw error;
      });

    try {
      if (status === 'starting') {
        if (await cancelled()) {
          await move({ reason: 'cancel requested', to: 'cancelled' });

          return;
        }

        await move({ to: 'running' });
      }

      const rows = await inTx((tx) => this.store.snapshot(tx, orgId, runId));
      const run: RunSnapshot = {
        committed: rows.committed,
        credentialChoice: claim.credentialChoice,
        epoch,
        id: runId,
        lastSeq: rows.lastSeq,
        messages: rows.messages,
        model,
        orgId,
        projectId,
        status: claim.status,
        userId: claim.userId,
      };
      const context: ExecutionContext = {
        cancelled,
        dispatch,
        emit,
        flush: () =>
          batcher.flush().catch((error: unknown) => {
            if (error instanceof FencedError) controller.abort(error);
            throw error;
          }),
        persist,
        run,
        signal: controller.signal,
      };
      const outcome = await executor.execute(context).catch((error: unknown) => {
        // The bound was reached inside emit: the run is failed already, and this is its echo.
        if (status === 'failed') {
          return undefined;
        }

        throw error;
      });

      if (outcome === undefined || status === 'failed') {
        return;
      }

      const end = ending(outcome);

      if (status === 'tool_error' && !TRANSITIONS.tool_error.includes(end.to)) {
        await move({ to: 'running' });
      }

      await move(end);
    } finally {
      clearInterval(heartbeat);
      this.control.forget(runId);
      await batcher.close();
    }
  }
}

type LocalAgentFailure = NonNullable<
  Extract<RunEvent, { type: 'state' }>['data']['localAgentFailure']
>;

/** The outcome's transition. Every one of these releases the lease through the state machine. */
function ending(outcome: RunOutcome): {
  failureClass?: RunFailureClass;
  localAgentFailure?: LocalAgentFailure;
  reason?: string;
  resetsAt?: Date;
  to: RunStatus;
} {
  switch (outcome.kind) {
    case 'succeeded':
      return { to: 'succeeded' };
    case 'awaiting_input':
      return { to: 'awaiting_input' };
    case 'paused':
      return { reason: outcome.reason, to: 'paused' };
    case 'failed':
      return {
        failureClass: outcome.failureClass,
        reason: outcome.reason,
        ...(outcome.resetsAt === undefined ? {} : { resetsAt: outcome.resetsAt }),
        ...(outcome.localAgentFailure === undefined
          ? {}
          : { localAgentFailure: outcome.localAgentFailure }),
        to: 'failed',
      };
    case 'stopped':
      return { reason: 'cancel requested', to: 'cancelled' };
  }
}

/** The global timer rather than `timers/promises`, so a suite's fake clock can drive the wait. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
