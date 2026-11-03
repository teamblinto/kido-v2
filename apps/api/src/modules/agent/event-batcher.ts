import { Inject, Injectable } from '@nestjs/common';
import { DURABLE_RUN_EVENT_TYPES } from '@repo/contracts';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { AGENT_TIMINGS, type AgentTimings } from './agent.constants';
import type { EmittedEvent } from './run-executor.port';
import { type RunEventInput, type RunFence, RunStore } from './run-store';
import { RunStreamPublisher, type StreamRow } from './run-stream-publisher';

/** A timer the spec can drive by hand; `schedule` returns the cancel. */
export interface BatcherTimer {
  schedule(fn: () => void, ms: number): () => void;
}

/** A `state` event from the executor: transitions belong to the consumer (contracts/executor-port.md). */
export class IllegalEventError extends Error {
  constructor(type: string) {
    super(`An executor may not emit "${type}"; the consumer owns transitions.`);
    this.name = 'IllegalEventError';
  }
}

export interface BatcherDependencies {
  readonly clock: ClockPort;
  /** Hears of every flush once it is committed (009); never throws. */
  readonly publisher: Pick<RunStreamPublisher, 'append'>;
  readonly store: RunStore;
  readonly timer: BatcherTimer;
  readonly timings: Pick<AgentTimings, 'batchMs' | 'batchSize'>;
  readonly transactions: Pick<TenantTransactionRunner, 'runInTenantTransaction'>;
}

const DURABLE = new Set<string>(DURABLE_RUN_EVENT_TYPES);

/**
 * The per-run milestone buffer (spec 008 research R9): flushed at `batchSize` pending, at
 * `batchMs` from the first push, and on `flush()` — which every transition calls first, so `seq`
 * stays contiguous and the `state` event lands last. A flush is one transaction: `n` seqs, `n`
 * rows, and the `usage` roll-up. Flushes are serialised, so two triggers cannot interleave.
 *
 * A timer-driven flush has nobody awaiting it; its failure is kept and rethrown by the next
 * `push`/`flush`, which is where the executor is listening for a fence.
 *
 * The stream (009): a batch reaches `run:{id}:events` once its transaction has committed, under
 * the seqs it got. A non-durable event (`token`, `thought`, `tool.delta`) writes no row and does
 * not wait: with nothing pending it goes to the stream at once, stamped with the last durable
 * seq; with a milestone pending it rides in the buffer in emission order and is appended in the
 * same pipeline as that batch, stamped with the durable seq before it — so a delta never
 * precedes its `tool.start` on the stream, and the batch window is what 008 made it (FR-004/006).
 */
export class EventBatcher {
  private buffer: EmittedEvent[] = [];
  private cancelTimer: (() => void) | undefined;
  private inflight: Promise<void> = Promise.resolve();
  private failure: unknown;
  /** The last durable seq known to be on the stream: what a lone non-durable event follows. */
  private published = 0;

  constructor(
    private readonly deps: BatcherDependencies,
    private readonly fence: RunFence,
  ) {}

  async push(event: EmittedEvent): Promise<void> {
    this.rethrow();

    if (event.type === 'state') {
      throw new IllegalEventError(event.type);
    }

    // token, thought, tool.delta: stream-only. Behind a pending milestone they queue in order and
    // go out with its batch; otherwise straight to the stream, after any write still in flight.
    if (!DURABLE.has(event.type)) {
      if (this.buffer.length > 0) {
        this.buffer.push(event);

        return;
      }

      await this.inflight.catch(() => undefined);
      await this.publish([
        { at: this.deps.clock.now(), data: event.data, seq: this.published, type: event.type },
      ]);

      return;
    }

    this.buffer.push(event);

    if (this.buffer.length >= this.deps.timings.batchSize) {
      await this.flush();
    } else {
      this.cancelTimer ??= this.deps.timer.schedule(() => {
        void this.flush().catch((error: unknown) => {
          this.failure = error;
        });
      }, this.deps.timings.batchMs);
    }
  }

  /** How many events wait for a flush. */
  get pending(): number {
    return this.buffer.length;
  }

  /** The last durable seq the stream holds, as far as this batcher knows. */
  get lastSeq(): number {
    return this.published;
  }

  /** A seq that reached the stream by another hand — the consumer's `sync` after a transition. */
  follow(seq: number): void {
    this.published = Math.max(this.published, seq);
  }

  flush(): Promise<void> {
    // A failed flush is the caller's to hear about, not a reason the next one cannot run.
    this.inflight = this.inflight.catch(() => undefined).then(() => this.write());

    return this.inflight;
  }

  async close(): Promise<void> {
    await this.flush();
  }

  private async write(): Promise<void> {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.rethrow();

    const batch = this.buffer;

    if (batch.length === 0) {
      return;
    }

    this.buffer = [];

    const durable = batch.filter((event) => DURABLE.has(event.type));
    const rows = await this.deps.transactions.runInTenantTransaction(
      this.fence.orgId,
      async (tx) => {
        const first = await this.deps.store.allocateSeq(tx, this.fence, durable.length);
        const at = this.deps.clock.now();
        let seq = first - 1;
        const rows: StreamRow[] = batch.map((event) => ({
          at,
          data: event.data,
          // A non-durable event follows the durable one before it in the batch.
          seq: DURABLE.has(event.type) ? (seq += 1) : seq,
          type: event.type,
        }));

        await this.deps.store.appendEvents(
          tx,
          this.fence,
          rows.filter((row): row is RunEventInput => DURABLE.has(row.type)),
        );

        const usage = durable.filter((event) => event.type === 'usage');

        if (usage.length > 0) {
          await this.deps.store.addUsage(tx, this.fence, {
            cacheReadTokens: usage.reduce(
              (sum, event) => sum + (event.data.cacheReadTokens ?? 0),
              0,
            ),
            cacheWriteTokens: usage.reduce(
              (sum, event) => sum + (event.data.cacheWriteTokens ?? 0),
              0,
            ),
            costMicros: usage.reduce((sum, event) => sum + event.data.costMicros, 0),
            inputTokens: usage.reduce((sum, event) => sum + event.data.inputTokens, 0),
            outputTokens: usage.reduce((sum, event) => sum + event.data.outputTokens, 0),
          });
        }

        return rows;
      },
    );

    // Committed: the stream may hear of it. The publisher never throws, so this cannot fail a flush.
    await this.publish(rows);
  }

  private async publish(rows: readonly StreamRow[]): Promise<void> {
    this.published = Math.max(
      this.published,
      await this.deps.publisher.append(this.fence.orgId, this.fence.runId, rows),
    );
  }

  private rethrow(): void {
    if (this.failure !== undefined) {
      const failure = this.failure;

      this.failure = undefined;

      throw failure instanceof Error
        ? failure
        : new Error('batch flush failed', { cause: failure });
    }
  }
}

const realTimer: BatcherTimer = {
  schedule(fn, ms) {
    const handle = setTimeout(fn, ms);

    return () => clearTimeout(handle);
  },
};

@Injectable()
export class EventBatcherFactory {
  constructor(
    private readonly store: RunStore,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(AGENT_TIMINGS) private readonly timings: AgentTimings,
    private readonly transactions: TenantTransactionRunner,
    private readonly publisher: RunStreamPublisher,
  ) {}

  create(fence: RunFence): EventBatcher {
    return new EventBatcher(
      {
        clock: this.clock,
        publisher: this.publisher,
        store: this.store,
        timer: realTimer,
        timings: this.timings,
        transactions: this.transactions,
      },
      fence,
    );
  }
}
