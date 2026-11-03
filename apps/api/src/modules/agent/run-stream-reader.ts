import { Inject, Injectable, Logger } from '@nestjs/common';
import { DURABLE_RUN_EVENT_TYPES, STREAM_HEARTBEAT, type StreamResetEvent } from '@repo/contracts';
import type { RunEventRow } from '@repo/db';
import type { Redis } from 'ioredis';
import type { ServerResponse } from 'node:http';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { STREAM_REDIS } from '../../common/redis/redis.constants';
import type { TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { toEvent, toResponse } from './run.service';
import { isTerminal } from './run-state-machine';
import { RunStore } from './run-store';
import { STREAM_TIMINGS, type StreamTimings, streamKey } from './stream.constants';

/** What the handler resolved inside the request transaction before it handed the socket over. */
export interface StreamRequest {
  /** `Last-Event-ID`, already bounded to `0 ≤ from ≤ lastSeq`. */
  readonly from: number;
  /** The run's last committed seq at request time. */
  readonly lastSeq: number;
  readonly orgId: string;
  readonly projectId: string;
  /** Headers and `retry:` already written. */
  readonly res: ServerResponse;
  readonly runId: string;
  /** The viewer's socket closed. */
  readonly signal: AbortSignal;
  /** The run had ended at request time: replay what is asked for, then close without blocking. */
  readonly terminal: boolean;
}

interface Deps {
  readonly clock: ClockPort;
  readonly store: RunStore;
  readonly timings: StreamTimings;
  readonly transactions: TenantTransactionRunner;
}

const DURABLE = new Set<string>(DURABLE_RUN_EVENT_TYPES);

/**
 * The read side of `run:{id}:events` (spec 009, research R5): one loop per viewer, detached from
 * the request that opened it. `delivered` — the highest durable seq written to this socket — is
 * what makes exactly-once a local property: an entry at or below it is dropped, an entry that
 * skips past `delivered + 1` is preceded by the rows Postgres has in between, and a run that ends
 * without its terminal `state` reaching the stream is drained from Postgres at the next
 * heartbeat. A seq the stream no longer holds is answered with one `stream.reset` carrying the
 * Postgres snapshot, never a silent gap.
 *
 * Every Postgres read is one short `runInTenantTransaction` under RLS; none is held across an
 * `XREAD`. `serve` never rejects: any failure ends the response and the browser reconnects at its
 * last `id`.
 */
@Injectable()
export class RunStreamReader {
  private readonly logger = new Logger(RunStreamReader.name);

  constructor(
    @Inject(STREAM_REDIS) private readonly redis: Redis,
    @Inject(STREAM_TIMINGS) private readonly timings: StreamTimings,
    @Inject(RunStore) private readonly store: RunStore,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async serve(request: StreamRequest): Promise<void> {
    // ponytail: one duplicated connection per viewer — `XREAD BLOCK` monopolises it (research R3).
    // A per-process multiplexed XREAD fanning out in memory is the upgrade if viewer counts matter.
    const client = this.redis.duplicate();
    const tail = new Tail(request, client, {
      clock: this.clock,
      store: this.store,
      timings: this.timings,
      transactions: this.transactions,
    });
    const onAbort = () => client.disconnect();

    request.signal.addEventListener('abort', onAbort, { once: true });

    try {
      await tail.run();
    } catch (error) {
      if (!request.signal.aborted) {
        this.logger.debug(
          `stream for run ${request.runId} ended: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      request.signal.removeEventListener('abort', onAbort);
      request.res.end();
      client.disconnect();
    }
  }
}

/** The per-connection state of data-model.md § Reader state, and the loop over it. */
class Tail {
  private delivered: number;
  private done = false;
  private position: string;

  constructor(
    private readonly request: StreamRequest,
    private readonly client: Redis,
    private readonly deps: Deps,
  ) {
    this.delivered = request.from;
    this.position = `${request.from}-0`;
  }

  async run(): Promise<void> {
    const { request } = this;
    const { timings } = this.deps;
    const key = streamKey(request.runId);

    await this.locate(key);

    while (!this.done && !request.signal.aborted) {
      const reply = request.terminal
        ? await this.client.xread('COUNT', 256, 'STREAMS', key, this.position)
        : await this.client.xread(
            'COUNT',
            256,
            'BLOCK',
            Math.min(timings.blockMs, timings.heartbeatMs),
            'STREAMS',
            key,
            this.position,
          );

      if (reply === null) {
        if (!request.terminal) {
          this.write(`${STREAM_HEARTBEAT}\n\n`);

          if (!(await this.terminalNow())) {
            continue;
          }
        }

        await this.drain();
        this.done = true;
        break;
      }

      for (const entry of reply[0]?.[1] ?? []) {
        if (request.signal.aborted || this.done) {
          break;
        }

        await this.deliver(entry);
      }
    }
  }

  /** The aged-out rule (research R2): `first.id ≤ (delivered+1)-0`, or an empty stream at the run's end. */
  private async locate(key: string): Promise<void> {
    const [first] = await this.client.xrange(key, '-', '+', 'COUNT', 1);
    const held =
      first === undefined
        ? this.delivered === this.request.lastSeq
        : idAtMost(first[0], this.delivered + 1);

    if (!held) {
      await this.reset();
    }
  }

  /** One `stream.reset`: the run row and every durable event past `delivered`, from Postgres. */
  private async reset(): Promise<void> {
    const { orgId, projectId, runId } = this.request;
    const { clock, store, transactions } = this.deps;
    const snapshot = await transactions.runInTenantTransaction(orgId, async (tx) => ({
      events: await this.pages(tx, this.delivered),
      run: await store.readRun(tx, orgId, projectId, runId),
    }));

    if (snapshot.run === undefined) {
      this.done = true;

      return;
    }

    const seq = snapshot.events.at(-1)?.seq ?? this.delivered;
    const envelope: StreamResetEvent = {
      at: clock.now().toISOString(),
      data: { events: snapshot.events.map(toEvent), run: toResponse(snapshot.run) },
      run: runId,
      seq,
      type: 'stream.reset',
    };

    this.write(frame('stream.reset', JSON.stringify(envelope), seq));
    this.advance(seq, `${seq}-0`);

    if (snapshot.events.some(endsRun)) {
      this.done = true;
    }
  }

  private async deliver([id, fields]: [id: string, fields: string[]]): Promise<void> {
    const entry = fieldsOf(fields);
    const seq = Number(entry.seq);
    const type = entry.type ?? '';
    const event = entry.event ?? '';

    if (!DURABLE.has(type)) {
      this.write(frame(type, event));
      this.position = id;

      return;
    }

    if (seq <= this.delivered) {
      this.position = id;

      return;
    }

    if (seq > this.delivered + 1) {
      await this.fill(seq);
    }

    this.write(frame(type, event, seq));
    this.advance(seq, id);

    if (type === 'state' && isTerminalTransition(JSON.parse(event) as { data?: { to?: string } })) {
      this.done = true;
    }
  }

  /** The rows in `(delivered, before)` the stream skipped — the fan-out that has not landed yet. */
  private async fill(before: number): Promise<void> {
    await this.fromPostgres((row) => row.seq < before);
  }

  /** Everything past `delivered` — the run ended without its terminal `state` on the stream. */
  private async drain(): Promise<void> {
    await this.fromPostgres(() => true);
  }

  private async fromPostgres(take: (row: RunEventRow) => boolean): Promise<void> {
    const { orgId } = this.request;
    const { transactions } = this.deps;
    const rows = await transactions.runInTenantTransaction(orgId, (tx) =>
      this.pages(tx, this.delivered),
    );

    for (const row of rows) {
      if (!take(row) || this.request.signal.aborted) {
        break;
      }

      this.write(frame(row.type, JSON.stringify(toEvent(row)), row.seq));
      this.advance(row.seq, `${row.seq}-0`);

      if (endsRun(row)) {
        this.done = true;
      }
    }
  }

  /** `run_events` with `seq > after`, every page, ascending. */
  private async pages(tx: TenantTransaction, after: number): Promise<RunEventRow[]> {
    const { orgId, runId } = this.request;
    const { store, timings } = this.deps;
    const rows: RunEventRow[] = [];
    let cursor = after;

    for (;;) {
      const page = await store.readEvents(tx, orgId, runId, cursor, timings.pageSize);

      rows.push(...page);

      if (page.length < timings.pageSize) {
        return rows;
      }

      cursor = page.at(-1)!.seq;
    }
  }

  private async terminalNow(): Promise<boolean> {
    const { orgId, projectId, runId } = this.request;
    const { store, transactions } = this.deps;
    const row = await transactions.runInTenantTransaction(orgId, (tx) =>
      store.readRun(tx, orgId, projectId, runId),
    );

    return row === undefined || isTerminal(row.status);
  }

  private advance(seq: number, position: string): void {
    this.delivered = seq;
    this.position = position;
  }

  private write(chunk: string): void {
    if (!this.request.signal.aborted) {
      this.request.res.write(chunk);
    }
  }
}

function frame(type: string, data: string, id?: number): string {
  return `event: ${type}\n${id === undefined ? '' : `id: ${id}\n`}data: ${data}\n\n`;
}

function fieldsOf(fields: string[]): Record<string, string> {
  const record: Record<string, string> = {};

  for (let index = 0; index + 1 < fields.length; index += 2) {
    record[fields[index]!] = fields[index + 1]!;
  }

  return record;
}

/** `a ≤ b-0` for stream ids `ms-seq`. */
function idAtMost(id: string, ms: number): boolean {
  const [left, right] = id.split('-').map(Number);

  return left! < ms || (left === ms && right === 0);
}

function isTerminalTransition(event: { data?: { to?: string } }): boolean {
  const to = event.data?.to;

  return typeof to === 'string' && isTerminal(to as Parameters<typeof isTerminal>[0]);
}

function endsRun(row: { data: Record<string, unknown>; type: string }): boolean {
  return row.type === 'state' && isTerminalTransition(row);
}
