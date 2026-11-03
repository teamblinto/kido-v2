import { Inject, Injectable, Logger } from '@nestjs/common';
import { DURABLE_RUN_EVENT_TYPES, type RunEventType } from '@repo/contracts';
import type { Redis } from 'ioredis';

import { STREAM_REDIS } from '../../common/redis/redis.constants';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { RunStore } from './run-store';
import { STREAM_TIMINGS, type StreamTimings, streamKey } from './stream.constants';

/** One event as the stream files it; `seq` on a non-durable row is the durable seq it follows. */
export interface StreamRow {
  readonly at: Date;
  readonly data: Record<string, unknown>;
  readonly seq: number;
  readonly type: RunEventType;
}

const DURABLE = new Set<string>(DURABLE_RUN_EVENT_TYPES);

/** Redis's answer to an explicit id at or below the top: the row is already there (research R2). */
const ALREADY_THERE = 'equal or smaller than the target stream top item';

/**
 * The write side of `run:{id}:events` (spec 009, contracts/stream-publisher.md).
 *
 * It never throws (FR-005): a run's events are durable in Postgres before anything here runs,
 * and a stream that lost a row is repaired by the next `sync` on the same run, so a Redis that is
 * down costs live tails and nothing else — one warning per failed pipeline, never a failed run.
 *
 * `sync` exists because the `state` events are written where no caller knows their `seq`
 * (research R1): `RunStore.transition` and `claim` allocate one inside a transaction that has no
 * after-commit hook and return nothing. Reading Postgres past the stream's top entry and
 * appending what is missing needs no return value from the frozen store and heals every gap the
 * same way.
 */
@Injectable()
export class RunStreamPublisher {
  private readonly logger = new Logger(RunStreamPublisher.name);

  constructor(
    @Inject(STREAM_REDIS) private readonly redis: Redis,
    @Inject(STREAM_TIMINGS) private readonly timings: StreamTimings,
    @Inject(RunStore) private readonly store: RunStore,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
  ) {}

  /**
   * One pipeline: `XADD … MAXLEN ~ maxLen S-0|S-*` per row, then `EXPIRE`. Resolves to the highest
   * `seq` among the rows — the seq the next non-durable event follows — whether or not Redis took
   * them: Postgres has them, and the stream catches up on the next `sync`.
   */
  async append(orgId: string, runId: string, rows: readonly StreamRow[]): Promise<number> {
    if (rows.length === 0) {
      return 0;
    }

    const key = streamKey(runId);
    const pipeline = this.redis.pipeline();

    for (const row of rows) {
      const event = {
        at: row.at.toISOString(),
        data: row.data,
        run: runId,
        seq: row.seq,
        type: row.type,
      };

      pipeline.xadd(
        key,
        'MAXLEN',
        '~',
        this.timings.maxLen,
        `${row.seq}-${DURABLE.has(row.type) ? '0' : '*'}`,
        'seq',
        row.seq,
        'type',
        row.type,
        'event',
        JSON.stringify(event),
      );
    }

    pipeline.expire(key, this.timings.ttlSeconds);

    try {
      const results = (await pipeline.exec()) ?? [];
      const failure = results
        .map(([error]) => error)
        .find((error) => error && !error.message.includes(ALREADY_THERE));

      if (failure) {
        throw failure;
      }
    } catch (error) {
      this.warn('append', runId, `${rows[0]!.seq}..${rows.at(-1)!.seq}`, error);
    }

    return Math.max(...rows.map((row) => row.seq));
  }

  /**
   * The stream's top seq, then `run_events` past it from Postgres in pages, appended in order.
   * Resolves to the highest seq now on the stream — the top when nothing was missing.
   */
  async sync(orgId: string, runId: string): Promise<number> {
    let top: number;

    try {
      const [entry] = await this.redis.xrevrange(streamKey(runId), '+', '-', 'COUNT', 1);

      top = entry === undefined ? 0 : Number(entry[0].split('-')[0]);
    } catch (error) {
      this.warn('sync', runId, 'top', error);

      return 0;
    }

    // ponytail: a primary-key-prefix read per transition (≤ 8 per run); return the seq from
    // `transition` / `claim` when 011 next opens run-store.ts and drop this read (research R1).
    let last = top;

    try {
      for (;;) {
        const rows = await this.transactions.runInTenantTransaction(orgId, (tx) =>
          this.store.readEvents(tx, orgId, runId, last, this.timings.pageSize),
        );

        if (rows.length === 0) {
          break;
        }

        // The store is the only writer and writes contract types, so the row's `type` is one.
        last = await this.append(orgId, runId, rows as readonly StreamRow[]);
      }
    } catch (error) {
      this.warn('sync', runId, `> ${last}`, error);
    }

    return last;
  }

  private warn(operation: string, runId: string, range: string, error: unknown): void {
    this.logger.warn(
      `${operation} dropped for run ${runId} seq ${range}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
