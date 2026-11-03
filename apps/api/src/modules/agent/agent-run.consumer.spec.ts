import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeClock } from '../../common/clock/fake-clock';
import type { TenantTransaction } from '../../database/database.types';
import type { TenantTransactionRunner } from '../../database/tenant-transaction';
import type { Envelope } from '../outbox/envelope';
import type { SandboxLifecycle } from '../sandbox/sandbox-lifecycle';
import { AGENT_QUEUE, DEFAULT_AGENT_TIMINGS } from './agent.constants';
import { AgentRunConsumer } from './agent-run.consumer';
import type { EventBatcher, EventBatcherFactory } from './event-batcher';
import type { RunControl } from './run-control';
import { RunExecutorRegistry } from './run-executor-registry';
import type { ExecutionContext, RunExecutor, RunOutcome } from './run-executor.port';
import { type Claim, FencedError, type RunStore } from './run-store';
import type { RunStreamPublisher } from './run-stream-publisher';

const ORG = 'b1000000-0000-4000-8000-000000000001';
const PROJECT = 'b1000000-0000-4000-8000-000000000002';
const RUN = 'b1000000-0000-4000-8000-000000000003';
const USER_ID = 'b1000000-0000-4000-8000-000000000004';

const execute = vi.fn(() => Promise.resolve({ rows: [] }));
const tx = { execute } as unknown as TenantTransaction;
/** What `runInTenantScope` hands out — distinct from `tx`, so a statement's transaction names its wrapper. */
const scopeTx = { execute: vi.fn() } as unknown as TenantTransaction;

function envelope(): Envelope<'agent-run.requested'> {
  return {
    aggregate: 'agent-run',
    aggregateId: RUN,
    eventId: 'e1',
    occurredAt: '2026-09-14T10:00:00.000Z',
    orgId: ORG,
    payload: { orgId: ORG, projectId: PROJECT, runId: RUN },
    traceId: null,
    type: 'agent-run.requested',
  };
}

function claimOf(status: Claim['status'] = 'starting'): Claim {
  return {
    credentialChoice: null,
    epoch: 1,
    model: 'fake',
    orgId: ORG,
    projectId: PROJECT,
    runId: RUN,
    status,
    userId: USER_ID,
  };
}

describe('AgentRunConsumer', () => {
  let store: {
    cancelRequested: ReturnType<typeof vi.fn>;
    claim: ReturnType<typeof vi.fn>;
    heartbeat: ReturnType<typeof vi.fn>;
    insertMessage: ReturnType<typeof vi.fn>;
    snapshot: ReturnType<typeof vi.fn>;
    transition: ReturnType<typeof vi.fn>;
  };
  let batcher: {
    close: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
    follow: ReturnType<typeof vi.fn>;
    push: ReturnType<typeof vi.fn>;
  };
  let publisher: { append: ReturnType<typeof vi.fn>; sync: ReturnType<typeof vi.fn> };
  let executor: { execute: ReturnType<typeof vi.fn> };
  let control: { forget: ReturnType<typeof vi.fn>; seen: ReturnType<typeof vi.fn> };
  let transactions: {
    runInTenantScope: ReturnType<typeof vi.fn>;
    runInTenantTransaction: ReturnType<typeof vi.fn>;
  };
  /** True while a `runInTenantScope` callback is running: what `dispatch`'s `fn` must see. */
  let inScope: boolean;
  let lifecycle: { touch: ReturnType<typeof vi.fn> };
  let consumer: AgentRunConsumer;
  let clock: FakeClock;

  beforeEach(() => {
    clock = new FakeClock('2026-09-14T10:00:00.000Z');
    store = {
      cancelRequested: vi.fn(() => Promise.resolve(false)),
      claim: vi.fn(() => Promise.resolve(claimOf())),
      heartbeat: vi.fn(() => Promise.resolve()),
      insertMessage: vi.fn(() => Promise.resolve({ id: 'm1' })),
      snapshot: vi.fn(() =>
        Promise.resolve({
          committed: { openStepId: null, pauses: 0, toolEnds: 0 },
          lastSeq: 3,
          messages: [],
        }),
      ),
      transition: vi.fn(() => Promise.resolve()),
    };
    batcher = {
      close: vi.fn(() => Promise.resolve()),
      flush: vi.fn(() => Promise.resolve()),
      follow: vi.fn(),
      push: vi.fn(() => Promise.resolve()),
    };
    publisher = { append: vi.fn(() => Promise.resolve(0)), sync: vi.fn(() => Promise.resolve(2)) };
    executor = {
      execute: vi.fn((): Promise<RunOutcome> => Promise.resolve({ kind: 'succeeded' })),
    };

    control = { forget: vi.fn(), seen: vi.fn(() => false) };
    lifecycle = { touch: vi.fn(() => Promise.resolve()) };

    const batchers = { create: vi.fn(() => batcher as unknown as EventBatcher) };
    inScope = false;
    transactions = {
      runInTenantScope: vi.fn(
        async (_scope: unknown, fn: (tx: TenantTransaction) => Promise<unknown>) => {
          inScope = true;

          try {
            return await fn(scopeTx);
          } finally {
            inScope = false;
          }
        },
      ),
      runInTenantTransaction: vi.fn(
        (_orgId: string, fn: (tx: TenantTransaction) => Promise<unknown>) => fn(tx),
      ),
    };

    consumer = new AgentRunConsumer(
      store as unknown as RunStore,
      batchers as unknown as EventBatcherFactory,
      executor as unknown as RunExecutor,
      control as unknown as RunControl,
      transactions as unknown as TenantTransactionRunner,
      DEFAULT_AGENT_TIMINGS,
      clock,
      publisher as unknown as RunStreamPublisher,
      lifecycle as unknown as SandboxLifecycle,
      cloudOnlyRegistry(),
    );
  });

  it('drains agent.run with four in flight, three attempts and two stalls (R5/R6)', () => {
    expect(consumer).toMatchObject({
      attempts: 3,
      concurrency: 4,
      maxStalledCount: 2,
      name: 'agent-run',
      queue: AGENT_QUEUE,
      types: ['agent-run.requested'],
    });
  });

  describe('handle', () => {
    it('sets the tenant on the transaction, then claims with the lease TTL', async () => {
      const claim = await consumer.handle(envelope(), tx);

      expect(claim).toEqual(claimOf());
      expect(execute).toHaveBeenCalledWith(sql`select set_config('app.org_id', ${ORG}, true)`);
      expect(store.claim).toHaveBeenCalledWith(tx, {
        leaseTtlMs: DEFAULT_AGENT_TIMINGS.leaseTtlMs,
        orgId: ORG,
        owner: expect.stringMatching(/:agent-run$/) as string,
        runId: RUN,
      });
    });

    it('returns undefined when nothing was claimed', async () => {
      store.claim.mockResolvedValueOnce(undefined);

      expect(await consumer.handle(envelope(), tx)).toBeUndefined();
    });
  });

  describe('effect', () => {
    it('does nothing without a claim', async () => {
      await consumer.effect(envelope(), undefined);

      expect(executor.execute).not.toHaveBeenCalled();
      expect(store.transition).not.toHaveBeenCalled();
    });

    it('moves starting → running, runs the executor on the snapshot, flushes, then ends the run', async () => {
      await consumer.effect(envelope(), claimOf());

      expect(store.transition.mock.calls.map((call) => call[1] as unknown)).toEqual([
        { epoch: 1, from: 'starting', orgId: ORG, runId: RUN, to: 'running' },
        { epoch: 1, from: 'running', orgId: ORG, runId: RUN, to: 'succeeded' },
      ]);

      const context = executor.execute.mock.calls[0]![0] as ExecutionContext;

      expect(context.run).toEqual({
        committed: { openStepId: null, pauses: 0, toolEnds: 0 },
        credentialChoice: null,
        epoch: 1,
        id: RUN,
        lastSeq: 3,
        messages: [],
        model: 'fake',
        orgId: ORG,
        projectId: PROJECT,
        status: 'starting',
        userId: USER_ID,
      });
      expect(context.signal.aborted).toBe(false);

      // A flush precedes every transition, and close follows the last.
      const order = [
        ...batcher.flush.mock.invocationCallOrder.map((n) => ['flush', n] as const),
        ...batcher.close.mock.invocationCallOrder.map((n) => ['close', n] as const),
        ...store.transition.mock.invocationCallOrder.map((n) => ['transition', n] as const),
      ].sort((left, right) => left[1] - right[1]);

      expect(order.map(([name]) => name)).toEqual([
        'flush',
        'transition',
        'flush',
        'transition',
        'close',
      ]);
    });

    it('skips starting → running when the run was claimed mid-flight', async () => {
      await consumer.effect(envelope(), claimOf('running'));

      expect(store.transition).toHaveBeenCalledTimes(1);
      expect(store.transition.mock.calls[0]![1]).toMatchObject({
        from: 'running',
        to: 'succeeded',
      });
    });

    it('routes emit through the batcher and cancelled() through the row flag', async () => {
      store.cancelRequested.mockResolvedValueOnce(true);
      executor.execute.mockImplementationOnce(async (context: ExecutionContext) => {
        await context.emit({ data: { checkpointId: 'c' }, type: 'checkpoint' });

        return (await context.cancelled()) ? { kind: 'stopped' } : { kind: 'succeeded' };
      });

      // Claimed mid-flight: the pre-start check is skipped, so the flag is read at the boundary.
      await consumer.effect(envelope(), claimOf('running'));

      expect(batcher.push).toHaveBeenCalledWith({
        data: { checkpointId: 'c' },
        type: 'checkpoint',
      });
      expect(store.cancelRequested).toHaveBeenCalledWith(tx, ORG, RUN);
      expect(store.transition.mock.calls[0]![1]).toMatchObject({
        from: 'running',
        reason: 'cancel requested',
        to: 'cancelled',
      });
    });

    /** FR-022 / research R7: the channel is the fast path, the row the truth. */
    describe('cancel (US3)', () => {
      it('answers cancelled() from the channel without reading the row', async () => {
        control.seen.mockReturnValue(true);
        executor.execute.mockImplementationOnce(async (context: ExecutionContext) =>
          (await context.cancelled()) ? { kind: 'stopped' } : { kind: 'succeeded' },
        );

        await consumer.effect(envelope(), claimOf('running'));

        expect(control.seen).toHaveBeenCalledWith(RUN);
        expect(store.cancelRequested).not.toHaveBeenCalled();
        expect(store.transition).toHaveBeenCalledWith(tx, {
          epoch: 1,
          from: 'running',
          orgId: ORG,
          reason: 'cancel requested',
          runId: RUN,
          to: 'cancelled',
        });
      });

      it('moves a fresh claim straight to cancelled when the flag is already set, and never runs the executor', async () => {
        store.cancelRequested.mockResolvedValueOnce(true);

        await consumer.effect(envelope(), claimOf());

        expect(executor.execute).not.toHaveBeenCalled();
        expect(store.transition).toHaveBeenCalledTimes(1);
        expect(store.transition).toHaveBeenCalledWith(tx, {
          epoch: 1,
          from: 'starting',
          orgId: ORG,
          reason: 'cancel requested',
          runId: RUN,
          to: 'cancelled',
        });
      });

      it('forgets the run on the channel once the attempt is over, whichever way it ended', async () => {
        await consumer.effect(envelope(), claimOf());

        expect(control.forget).toHaveBeenCalledWith(RUN);

        executor.execute.mockRejectedValueOnce(new Error('boom'));
        await consumer.effect(envelope(), claimOf()).catch(() => undefined);

        expect(control.forget).toHaveBeenCalledTimes(2);
      });
    });

    it.each([
      [{ kind: 'awaiting_input' }, { to: 'awaiting_input' }],
      [
        { kind: 'paused', reason: 'quota' },
        { reason: 'quota', to: 'paused' },
      ],
      [
        { failureClass: 'executor', kind: 'failed', reason: 'boom' },
        { failureClass: 'executor', reason: 'boom', to: 'failed' },
      ],
      [
        // 032 T046: a subscription's reset rides to the `state` event.
        {
          failureClass: 'credential',
          kind: 'failed',
          reason: 'limited',
          resetsAt: new Date('2026-09-24T09:22:00.000Z'),
        },
        {
          failureClass: 'credential',
          reason: 'limited',
          resetsAt: new Date('2026-09-24T09:22:00.000Z'),
          to: 'failed',
        },
      ],
    ] as [RunOutcome, Record<string, unknown>][])(
      'applies the transition of %o',
      async (outcome, expected) => {
        executor.execute.mockResolvedValueOnce(outcome);

        await consumer.effect(envelope(), claimOf());

        expect(store.transition.mock.calls[1]![1]).toEqual({
          epoch: 1,
          from: 'running',
          orgId: ORG,
          runId: RUN,
          ...expected,
        });
      },
    );

    /** FR-008's self-heal: `running → tool_error` on a failed `tool.end`, back on the next milestone. */
    describe('tool_error (US4)', () => {
      const toolEnd = (ok: boolean, step = 0): Parameters<ExecutionContext['emit']>[0] =>
        ok
          ? { data: { ok, stepId: `${RUN}/${step}` }, type: 'tool.end' }
          : { data: { error: `boom ${step}`, ok, stepId: `${RUN}/${step}` }, type: 'tool.end' };
      const toolStart = (step: number): Parameters<ExecutionContext['emit']>[0] => ({
        data: { input: {}, stepId: `${RUN}/${step}`, tool: 't' },
        type: 'tool.start',
      });

      function transitions(): unknown[] {
        return store.transition.mock.calls.map((call) => {
          const { from, to, ...rest } = call[1] as Record<string, unknown>;

          return [from, to, rest.reason, rest.failureClass];
        });
      }

      it('moves running → tool_error after flushing the failed tool.end, and heals on the next durable event', async () => {
        executor.execute.mockImplementationOnce(async (context: ExecutionContext) => {
          await context.emit(toolEnd(false));
          await context.emit({ data: { chunk: 'x', stepId: `${RUN}/1` }, type: 'tool.delta' });
          await context.emit(toolStart(1));
          await context.emit(toolEnd(true, 1));

          return { kind: 'succeeded' };
        });

        await consumer.effect(envelope(), claimOf('running'));

        expect(transitions()).toEqual([
          ['running', 'tool_error', 'boom 0', undefined],
          ['tool_error', 'running', undefined, undefined],
          ['running', 'succeeded', undefined, undefined],
        ]);

        // The failed tool.end is on disk before the state event that answers it.
        const pushed = batcher.push.mock.invocationCallOrder[0]!;
        const flushed = batcher.flush.mock.invocationCallOrder[0]!;
        const moved = store.transition.mock.invocationCallOrder[0]!;

        expect(pushed).toBeLessThan(flushed);
        expect(flushed).toBeLessThan(moved);
        expect(batcher.push).toHaveBeenCalledTimes(4);
      });

      it('heals before an outcome that tool_error cannot reach directly', async () => {
        executor.execute.mockImplementationOnce(async (context: ExecutionContext) => {
          await context.emit(toolEnd(false));

          return { kind: 'awaiting_input' };
        });

        await consumer.effect(envelope(), claimOf('running'));

        expect(transitions()).toEqual([
          ['running', 'tool_error', 'boom 0', undefined],
          ['tool_error', 'running', undefined, undefined],
          ['running', 'awaiting_input', undefined, undefined],
        ]);
      });

      it.each<[RunOutcome, string]>([
        [{ failureClass: 'executor', kind: 'failed', reason: 'gave up' }, 'failed'],
        [{ kind: 'stopped' }, 'cancelled'],
      ])('ends from tool_error directly on %o', async (outcome, to) => {
        executor.execute.mockImplementationOnce(async (context: ExecutionContext) => {
          await context.emit(toolEnd(false));

          return outcome;
        });

        await consumer.effect(envelope(), claimOf('running'));

        expect(transitions().map((entry) => (entry as string[]).slice(0, 2))).toEqual([
          ['running', 'tool_error'],
          ['tool_error', to],
        ]);
      });

      it('fails the run with class tool_error on the third consecutive failure and aborts the executor', async () => {
        let aborted = false;
        const failure = executor.execute.mockImplementationOnce(
          async (context: ExecutionContext) => {
            context.signal.addEventListener('abort', () => {
              aborted = true;
            });

            for (let step = 0; step < 5; step += 1) {
              await context.emit(toolStart(step));
              await context.emit(toolEnd(false, step));
            }

            return { kind: 'succeeded' };
          },
        );

        await consumer.effect(envelope(), claimOf('running'));

        expect(aborted).toBe(true);
        expect(transitions()).toEqual([
          ['running', 'tool_error', 'boom 0', undefined],
          ['tool_error', 'running', undefined, undefined],
          ['running', 'tool_error', 'boom 1', undefined],
          ['tool_error', 'running', undefined, undefined],
          ['running', 'tool_error', 'boom 2', undefined],
          ['tool_error', 'failed', 'three consecutive tool failures', 'tool_error'],
        ]);
        // The third failure is refused at emit: nothing of steps 3 and 4 was pushed.
        expect(batcher.push).toHaveBeenCalledTimes(6);
        expect(batcher.close).toHaveBeenCalledTimes(1);
        await expect(failure.mock.results[0]!.value).rejects.toThrow('three consecutive');
      });

      it('counts only consecutive failures: a tool.end that succeeds resets the bound', async () => {
        executor.execute.mockImplementationOnce(async (context: ExecutionContext) => {
          // fail, fail, ok, fail, fail, ok: four failures, never three in a row.
          for (let step = 0; step < 6; step += 1) {
            await context.emit(toolStart(step));
            await context.emit(toolEnd(step % 3 === 2, step));
          }

          return { kind: 'succeeded' };
        });

        await consumer.effect(envelope(), claimOf('running'));

        expect(transitions().at(-1)).toEqual(['running', 'succeeded', undefined, undefined]);
        expect(
          transitions().filter((entry) => (entry as string[])[1] === 'tool_error'),
        ).toHaveLength(4);
      });
    });

    describe('a delivery that meets a live lease (US2)', () => {
      const HELD_MS = 12_000;

      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('waits until the lease runs out, claims again, and runs the resumed attempt', async () => {
        const heldUntil = new Date(clock.now().getTime() + HELD_MS);

        store.claim.mockResolvedValueOnce({ ...claimOf('running'), epoch: 2 });

        const running = consumer.effect(envelope(), { heldUntil });

        await vi.advanceTimersByTimeAsync(HELD_MS - 1);

        expect(store.claim).not.toHaveBeenCalled();

        clock.advance(HELD_MS);
        await vi.advanceTimersByTimeAsync(1);
        await running;

        expect(store.claim).toHaveBeenCalledTimes(1);
        expect(executor.execute).toHaveBeenCalledTimes(1);
        expect(store.transition).toHaveBeenCalledWith(tx, {
          epoch: 2,
          from: 'running',
          orgId: ORG,
          runId: RUN,
          to: 'succeeded',
        });
      });

      it('gives the delivery up when the lease was renewed meanwhile: the holder is alive', async () => {
        const heldUntil = new Date(clock.now().getTime() + HELD_MS);

        store.claim.mockResolvedValueOnce({ heldUntil: new Date(heldUntil.getTime() + HELD_MS) });

        const running = consumer.effect(envelope(), { heldUntil });

        clock.advance(HELD_MS);
        await vi.advanceTimersByTimeAsync(HELD_MS);
        await running;

        expect(store.claim).toHaveBeenCalledTimes(1);
        expect(executor.execute).not.toHaveBeenCalled();
      });

      it('claims again when the row still says the same heldUntil: the holder is dead and the wait ended on its last millisecond', async () => {
        const heldUntil = new Date(clock.now().getTime() + HELD_MS);

        // The timer fired with the wall clock still on heldUntil's millisecond, so the row is
        // "held" by a lease nobody renewed. A live holder would have moved heldUntil forward.
        store.claim
          .mockResolvedValueOnce({ heldUntil })
          .mockResolvedValueOnce({ ...claimOf('running'), epoch: 2 });

        const running = consumer.effect(envelope(), { heldUntil });

        clock.advance(HELD_MS);
        await vi.advanceTimersByTimeAsync(HELD_MS);
        clock.advance(1);
        await vi.advanceTimersByTimeAsync(1);
        await running;

        expect(store.claim).toHaveBeenCalledTimes(2);
        expect(executor.execute).toHaveBeenCalledTimes(1);
      });

      it('never waits longer than one lease, whatever the row says', async () => {
        const heldUntil = new Date(clock.now().getTime() + DEFAULT_AGENT_TIMINGS.leaseTtlMs * 10);

        store.claim.mockResolvedValueOnce(undefined);

        const running = consumer.effect(envelope(), { heldUntil });

        await vi.advanceTimersByTimeAsync(DEFAULT_AGENT_TIMINGS.leaseTtlMs);
        await running;

        expect(store.claim).toHaveBeenCalledTimes(1);
      });
    });

    describe('the heartbeat (US2)', () => {
      /** A run whose executor waits until the spec lets it go, so the interval has time to fire. */
      function longRun(): { finish: (outcome: RunOutcome) => void } {
        let finish!: (outcome: RunOutcome) => void;

        executor.execute.mockImplementationOnce(
          () =>
            new Promise<RunOutcome>((resolve) => {
              finish = resolve;
            }),
        );

        return { finish: (outcome) => finish(outcome) };
      }

      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('renews the lease every heartbeatMs while the executor runs, and stops after', async () => {
        const { finish } = longRun();
        const running = consumer.effect(envelope(), claimOf());

        await vi.advanceTimersByTimeAsync(DEFAULT_AGENT_TIMINGS.heartbeatMs * 3);

        expect(store.heartbeat).toHaveBeenCalledTimes(3);
        expect(store.heartbeat).toHaveBeenCalledWith(
          tx,
          { epoch: 1, orgId: ORG, runId: RUN },
          DEFAULT_AGENT_TIMINGS.leaseTtlMs,
        );

        finish({ kind: 'succeeded' });
        await running;
        await vi.advanceTimersByTimeAsync(DEFAULT_AGENT_TIMINGS.heartbeatMs * 3);

        expect(store.heartbeat).toHaveBeenCalledTimes(3);
      });

      /** Spec 014 research R8 / FR-005: a run in flight is what keeps its sandbox from idling. */
      it("touches the project's sandbox on every heartbeat's tenant transaction", async () => {
        const { finish } = longRun();
        const running = consumer.effect(envelope(), claimOf());

        await vi.advanceTimersByTimeAsync(DEFAULT_AGENT_TIMINGS.heartbeatMs * 2);

        expect(lifecycle.touch).toHaveBeenCalledTimes(2);
        expect(lifecycle.touch).toHaveBeenCalledWith(tx, { orgId: ORG, projectId: PROJECT });

        finish({ kind: 'succeeded' });
        await running;
      });

      /** Spec 040: a run the registry routes to the local agent neither uses nor touches a sandbox. */
      it('hands a local run to the registered executor and never touches the sandbox', async () => {
        let finish!: (outcome: RunOutcome) => void;
        const local = {
          admit: vi.fn(),
          admitSubscription: vi.fn(),
          release: vi.fn(),
          execute: vi.fn(
            () =>
              new Promise<RunOutcome>((resolve) => {
                finish = resolve;
              }),
          ),
        };
        const registry = new RunExecutorRegistry();
        const isLocal = vi.spyOn(registry, 'isLocal').mockResolvedValue(true);
        vi.spyOn(registry, 'toolMode').mockResolvedValue('workspace');
        registry.register(local);
        const routed = new AgentRunConsumer(
          store as unknown as RunStore,
          { create: () => batcher as unknown as EventBatcher } as unknown as EventBatcherFactory,
          executor as unknown as RunExecutor,
          control as unknown as RunControl,
          transactions as unknown as TenantTransactionRunner,
          DEFAULT_AGENT_TIMINGS,
          clock,
          publisher as unknown as RunStreamPublisher,
          lifecycle as unknown as SandboxLifecycle,
          registry,
        );
        const running = routed.effect(envelope(), claimOf());

        await vi.advanceTimersByTimeAsync(DEFAULT_AGENT_TIMINGS.heartbeatMs * 2);

        expect(isLocal).toHaveBeenCalledWith(tx, ORG, RUN);
        expect(local.execute).toHaveBeenCalledTimes(1);
        expect(executor.execute).not.toHaveBeenCalled();
        expect(store.heartbeat).toHaveBeenCalledTimes(2);
        expect(lifecycle.touch).not.toHaveBeenCalled();

        finish({ kind: 'awaiting_input' });
        await running;
      });

      /** Spec 041: a local run on the sandbox tool bridge keeps its sandbox awake as a cloud run. */
      it('touches the sandbox for a local run in the sandbox tool mode', async () => {
        let finish!: (outcome: RunOutcome) => void;
        const local = {
          admit: vi.fn(),
          admitSubscription: vi.fn(),
          release: vi.fn(),
          execute: vi.fn(
            () =>
              new Promise<RunOutcome>((resolve) => {
                finish = resolve;
              }),
          ),
        };
        const registry = new RunExecutorRegistry();
        vi.spyOn(registry, 'isLocal').mockResolvedValue(true);
        vi.spyOn(registry, 'toolMode').mockResolvedValue('sandbox');
        registry.register(local);
        const routed = new AgentRunConsumer(
          store as unknown as RunStore,
          { create: () => batcher as unknown as EventBatcher } as unknown as EventBatcherFactory,
          executor as unknown as RunExecutor,
          control as unknown as RunControl,
          transactions as unknown as TenantTransactionRunner,
          DEFAULT_AGENT_TIMINGS,
          clock,
          publisher as unknown as RunStreamPublisher,
          lifecycle as unknown as SandboxLifecycle,
          registry,
        );
        const running = routed.effect(envelope(), claimOf());

        await vi.advanceTimersByTimeAsync(DEFAULT_AGENT_TIMINGS.heartbeatMs * 2);

        expect(local.execute).toHaveBeenCalledTimes(1);
        expect(lifecycle.touch).toHaveBeenCalledTimes(2);

        finish({ kind: 'awaiting_input' });
        await running;
      });

      /** Spec 040: local agents switched off after the run was created — it fails, never the cloud. */
      it('fails a local run when no local executor is registered, never using the default one', async () => {
        const registry = new RunExecutorRegistry();
        vi.spyOn(registry, 'isLocal').mockResolvedValue(true);
        vi.spyOn(registry, 'toolMode').mockResolvedValue('workspace');
        const routed = new AgentRunConsumer(
          store as unknown as RunStore,
          { create: () => batcher as unknown as EventBatcher } as unknown as EventBatcherFactory,
          executor as unknown as RunExecutor,
          control as unknown as RunControl,
          transactions as unknown as TenantTransactionRunner,
          DEFAULT_AGENT_TIMINGS,
          clock,
          publisher as unknown as RunStreamPublisher,
          lifecycle as unknown as SandboxLifecycle,
          registry,
        );

        await routed.effect(envelope(), claimOf());

        expect(executor.execute).not.toHaveBeenCalled();
        expect(store.transition).toHaveBeenLastCalledWith(
          tx,
          expect.objectContaining({
            failureClass: 'executor',
            reason: expect.stringContaining('local-agent disabled') as string,
            to: 'failed',
          }),
        );
      });

      it('logs a touch that throws and keeps the heartbeat, the lease being the fence', async () => {
        lifecycle.touch.mockRejectedValueOnce(new Error('sandbox table is away'));
        const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

        const { finish } = longRun();
        const running = consumer.effect(envelope(), claimOf());

        await vi.advanceTimersByTimeAsync(DEFAULT_AGENT_TIMINGS.heartbeatMs * 2);

        const context = executor.execute.mock.calls[0]![0] as ExecutionContext;

        expect(context.signal.aborted).toBe(false);
        expect(store.heartbeat).toHaveBeenCalledTimes(2);
        expect(lifecycle.touch).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('sandbox table is away'));

        finish({ kind: 'succeeded' });
        await running;
        warn.mockRestore();
      });

      it('aborts the executor through the signal when a heartbeat is fenced', async () => {
        const fenced = new FencedError(RUN, 'heartbeat', 1);

        store.heartbeat.mockRejectedValueOnce(fenced);
        executor.execute.mockImplementationOnce(
          (context: ExecutionContext) =>
            new Promise<RunOutcome>((_resolve, reject) => {
              context.signal.addEventListener('abort', () =>
                reject(context.signal.reason as Error),
              );
            }),
        );

        const failure = consumer.effect(envelope(), claimOf()).then(
          () => 'resolved',
          (error: unknown) => error,
        );

        await vi.advanceTimersByTimeAsync(DEFAULT_AGENT_TIMINGS.heartbeatMs);

        expect(await failure).toBe(fenced);
        expect(store.transition).toHaveBeenCalledTimes(1);
      });

      it('keeps going through a heartbeat that failed for any other reason', async () => {
        store.heartbeat.mockRejectedValueOnce(new Error('connection reset'));

        const { finish } = longRun();
        const running = consumer.effect(envelope(), claimOf());

        await vi.advanceTimersByTimeAsync(DEFAULT_AGENT_TIMINGS.heartbeatMs * 2);

        const context = executor.execute.mock.calls[0]![0] as ExecutionContext;

        expect(context.signal.aborted).toBe(false);
        expect(store.heartbeat).toHaveBeenCalledTimes(2);

        finish({ kind: 'succeeded' });
        await running;
      });
    });

    /** Spec 009 research R1/R6: the stream hears every state event; a fenced attempt emits no token. */
    describe('the stream (009)', () => {
      const token = (text: string): Parameters<ExecutionContext['emit']>[0] => ({
        data: { text },
        type: 'token',
      });

      it('syncs after the claim and after every transition, and tells the batcher the seq it answers', async () => {
        publisher.sync.mockResolvedValueOnce(2).mockResolvedValueOnce(3).mockResolvedValueOnce(9);

        await consumer.effect(envelope(), claimOf());

        expect(publisher.sync.mock.calls).toEqual([
          [ORG, RUN],
          [ORG, RUN],
          [ORG, RUN],
        ]);

        const [claimed, moved, ended] = publisher.sync.mock.invocationCallOrder;
        const [first, last] = store.transition.mock.invocationCallOrder;

        expect(claimed).toBeLessThan(first!);
        expect(moved).toBeGreaterThan(first!);
        expect(moved).toBeLessThan(last!);
        expect(ended).toBeGreaterThan(last!);
        expect(batcher.follow.mock.calls).toEqual([[2], [3], [9]]);
      });

      it('syncs after the transitions emit makes, too', async () => {
        executor.execute.mockImplementationOnce(async (context: ExecutionContext) => {
          await context.emit({ data: { error: 'boom', ok: false, stepId: 's' }, type: 'tool.end' });
          await context.emit({ data: { checkpointId: 'c' }, type: 'checkpoint' });

          return { kind: 'succeeded' };
        });

        await consumer.effect(envelope(), claimOf('running'));

        // claim, then tool_error, running, succeeded
        expect(publisher.sync).toHaveBeenCalledTimes(4);
        expect(store.transition).toHaveBeenCalledTimes(3);
      });

      it('routes a non-durable event through the batcher like any other', async () => {
        executor.execute.mockImplementationOnce(async (context: ExecutionContext) => {
          await context.emit(token('a'));

          return { kind: 'succeeded' };
        });

        await consumer.effect(envelope(), claimOf('running'));

        expect(batcher.push).toHaveBeenCalledWith({ data: { text: 'a' }, type: 'token' });
      });

      it('refuses a non-durable event once the attempt is aborted, and pushes nothing', async () => {
        const fenced = new FencedError(RUN, 'heartbeat', 1);

        executor.execute.mockImplementationOnce(async (context: ExecutionContext) => {
          await context.emit(token('a'));

          return new Promise<RunOutcome>((resolve, reject) => {
            context.signal.addEventListener('abort', () => {
              context.emit(token('late')).then(
                () => resolve({ kind: 'succeeded' }),
                (error: unknown) => reject(error as Error),
              );
            });
          });
        });
        vi.useFakeTimers();

        try {
          store.heartbeat.mockRejectedValueOnce(fenced);

          const failure = consumer.effect(envelope(), claimOf('running')).then(
            () => 'resolved',
            (error: unknown) => error,
          );

          await vi.advanceTimersByTimeAsync(DEFAULT_AGENT_TIMINGS.heartbeatMs);

          expect(await failure).toBe(fenced);
          expect(batcher.push).toHaveBeenCalledTimes(1);
        } finally {
          vi.useRealTimers();
        }
      });

      it('treats a fenced push as the fence: the next non-durable emit throws it and pushes nothing', async () => {
        const fenced = new FencedError(RUN, 'allocateSeq', 1);
        let late: unknown;

        batcher.push.mockRejectedValueOnce(fenced);
        executor.execute.mockImplementationOnce(async (context: ExecutionContext) => {
          await context
            .emit({ data: { checkpointId: 'c' }, type: 'checkpoint' })
            .catch(() => undefined);
          late = await context.emit(token('late')).then(
            () => 'resolved',
            (error: unknown) => error,
          );

          return { kind: 'succeeded' };
        });

        await consumer.effect(envelope(), claimOf('running'));

        expect(late).toBe(fenced);
        expect(batcher.push).toHaveBeenCalledTimes(1);
      });
    });

    /** Spec 011 research R4/R5: the heartbeat is the fence for a message row and for a tool call. */
    describe('persist and dispatch (011)', () => {
      const fence = { epoch: 1, orgId: ORG, runId: RUN };
      const message = { content: 'done', role: 'assistant' as const, toolCalls: [{ id: 'c1' }] };

      it('persist writes the message under the live epoch and renews the lease', async () => {
        executor.execute.mockImplementationOnce(async (context: ExecutionContext) => {
          await context.persist(message);

          return { kind: 'succeeded' };
        });

        await consumer.effect(envelope(), claimOf('running'));

        expect(store.heartbeat).toHaveBeenCalledWith(tx, fence, DEFAULT_AGENT_TIMINGS.leaseTtlMs);
        expect(store.insertMessage).toHaveBeenCalledWith(tx, {
          ...message,
          orgId: ORG,
          runId: RUN,
        });
        expect(store.heartbeat.mock.invocationCallOrder[0]).toBeLessThan(
          store.insertMessage.mock.invocationCallOrder[0]!,
        );
      });

      it('persist flushes pending events before the row lands', async () => {
        executor.execute.mockImplementationOnce(async (context: ExecutionContext) => {
          await context.emit({
            data: { costMicros: 0, inputTokens: 1, outputTokens: 1 },
            type: 'usage',
          });
          await context.persist(message);

          return { kind: 'succeeded' };
        });

        await consumer.effect(envelope(), claimOf('running'));

        // The `usage` that describes the row is on disk before the row is: no row outlives its events.
        expect(batcher.flush).toHaveBeenCalled();
        expect(Math.min(...batcher.flush.mock.invocationCallOrder)).toBeLessThan(
          store.insertMessage.mock.invocationCallOrder[0]!,
        );
      });

      it('persist under a stale epoch throws FencedError and inserts nothing', async () => {
        const fenced = new FencedError(RUN, 'heartbeat', 1);
        let caught: unknown;

        store.heartbeat.mockRejectedValueOnce(fenced);
        executor.execute.mockImplementationOnce(async (context: ExecutionContext) => {
          caught = await context.persist(message).then(
            () => 'resolved',
            (error: unknown) => error,
          );

          return { kind: 'succeeded' };
        });

        await consumer.effect(envelope(), claimOf('running'));

        expect(caught).toBe(fenced);
        expect(store.insertMessage).not.toHaveBeenCalled();
      });

      it('dispatch runs fn inside a tenant scope after a fenced heartbeat', async () => {
        const fn = vi.fn(() => Promise.resolve(inScope));
        let answer: unknown;

        executor.execute.mockImplementationOnce(async (context: ExecutionContext) => {
          answer = await context.dispatch(fn);

          return { kind: 'succeeded' };
        });

        await consumer.effect(envelope(), claimOf('running'));

        // The scope, not the bare transaction: the sandbox port reads the ALS context (R5).
        expect(answer).toBe(true);
        expect(transactions.runInTenantScope).toHaveBeenCalledWith(
          { orgId: ORG, userId: null },
          expect.any(Function),
        );
        expect(store.heartbeat).toHaveBeenCalledWith(
          scopeTx,
          fence,
          DEFAULT_AGENT_TIMINGS.leaseTtlMs,
        );
        expect(store.heartbeat.mock.invocationCallOrder[0]).toBeLessThan(
          fn.mock.invocationCallOrder[0]!,
        );
      });

      it('dispatch under a stale epoch throws FencedError before fn runs', async () => {
        const fenced = new FencedError(RUN, 'heartbeat', 1);
        const fn = vi.fn(() => Promise.resolve('never'));
        let caught: unknown;

        store.heartbeat.mockRejectedValueOnce(fenced);
        executor.execute.mockImplementationOnce(async (context: ExecutionContext) => {
          caught = await context.dispatch(fn).then(
            () => 'resolved',
            (error: unknown) => error,
          );

          return { kind: 'succeeded' };
        });

        await consumer.effect(envelope(), claimOf('running'));

        expect(caught).toBe(fenced);
        expect(fn).not.toHaveBeenCalled();
      });
    });

    it('lets an executor failure propagate after closing the batcher', async () => {
      executor.execute.mockRejectedValueOnce(new Error('fenced'));

      await expect(consumer.effect(envelope(), claimOf())).rejects.toThrow('fenced');

      expect(batcher.close).toHaveBeenCalledTimes(1);
      expect(store.transition).toHaveBeenCalledTimes(1);
    });
  });
});

/** The default: no run is local, so every run goes to the cloud executor under test. */
function cloudOnlyRegistry(): RunExecutorRegistry {
  const registry = new RunExecutorRegistry();
  vi.spyOn(registry, 'isLocal').mockResolvedValue(false);

  return registry;
}
