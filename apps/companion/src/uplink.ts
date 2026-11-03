import { type CompanionRunEvent, companionRunEventSchema } from '@repo/contracts';

import { DeviceRevokedError, HttpError } from './http.ts';
import { log } from './log.ts';
import type { RunEventBody } from './providers/types.ts';
import { backoffDelay } from './util.ts';

/**
 * Run events up to BAIOS (spec 040 § 6): numbered per run turn from 1, batched (≤ `maxBatch` events or
 * `flushMs`), adjacent deltas coalesced, retried with backoff while the server is unreachable.
 * The server drops any `seq` it already holds, so resending a batch is harmless. Memory is bounded:
 * past `maxBufferedChars`, unsent deltas are dropped (oldest first) before any structural event.
 */

export type PostEvents = (
  runId: string,
  turn: number,
  events: CompanionRunEvent[],
) => Promise<void>;

export interface UplinkOptions {
  flushMs?: number;
  maxBatch?: number;
  maxBufferedChars?: number;
  onRevoked?: () => void;
}

const MAX_CHUNK = 65_536;
const DELTA_TYPES = new Set(['reasoning.delta', 'text.delta', 'tool.output']);
const EVENT_OVERHEAD = 200;

interface Entry {
  event: CompanionRunEvent;
  size: number;
}

/** One turn of one run: a later turn has its own buffer, so a late retry never joins it. */
interface RunBuffer {
  attempt: number;
  closed: boolean;
  droppedWarned: boolean;
  entries: Entry[];
  inFlight: number;
  nextSeq: number;
  size: number;
  timer: NodeJS.Timeout | null;
  readonly runId: string;
  readonly turn: number;
}

function deltaText(event: CompanionRunEvent): string | null {
  if (event.type === 'text.delta' || event.type === 'reasoning.delta') return event.data.text;
  if (event.type === 'tool.output') return event.data.chunk;
  return null;
}

/** Splits an oversized delta into chunks the contract accepts. */
function splitDelta(body: RunEventBody): RunEventBody[] {
  if (body.type === 'text.delta' || body.type === 'reasoning.delta') {
    if (body.data.text.length <= MAX_CHUNK) return [body];
    const parts: RunEventBody[] = [];
    for (let i = 0; i < body.data.text.length; i += MAX_CHUNK) {
      parts.push({ ...body, data: { text: body.data.text.slice(i, i + MAX_CHUNK) } });
    }
    return parts;
  }
  if (body.type === 'tool.output' && body.data.chunk.length > MAX_CHUNK) {
    const parts: RunEventBody[] = [];
    for (let i = 0; i < body.data.chunk.length; i += MAX_CHUNK) {
      const chunk = body.data.chunk.slice(i, i + MAX_CHUNK);
      parts.push({ ...body, data: { ...body.data, chunk } });
    }
    return parts;
  }
  return [body];
}

export class Uplink {
  private readonly runs = new Map<string, RunBuffer>();
  private readonly drained = new Set<() => void>();
  private readonly flushMs: number;
  private readonly maxBatch: number;
  private readonly maxBufferedChars: number;
  private readonly onRevoked: (() => void) | undefined;
  private readonly post: PostEvents;
  private stopped = false;

  constructor(post: PostEvents, options: UplinkOptions = {}) {
    this.post = post;
    this.flushMs = options.flushMs ?? 100;
    this.maxBatch = options.maxBatch ?? 50;
    this.maxBufferedChars = options.maxBufferedChars ?? 4_000_000;
    this.onRevoked = options.onRevoked;
  }

  /** Queues an event; a `terminal` closes the run's stream and flushes at once. */
  push(runId: string, turn: number, body: RunEventBody): void {
    if (this.stopped) return;
    const key = `${runId}:${String(turn)}`;
    let run = this.runs.get(key);
    if (!run) {
      run = {
        attempt: 0,
        closed: false,
        droppedWarned: false,
        entries: [],
        inFlight: 0,
        nextSeq: 1,
        runId,
        size: 0,
        timer: null,
        turn,
      };
      this.runs.set(key, run);
    }
    if (run.closed) return;
    for (const part of splitDelta(body)) this.append(run, part);
    if (body.type === 'terminal') run.closed = true;
    this.trim(run);
    const pending = run.entries.length - run.inFlight;
    if (body.type === 'terminal' || pending >= this.maxBatch) this.schedule(key, run, 0);
    else this.schedule(key, run, this.flushMs);
  }

  private append(run: RunBuffer, body: RunEventBody): void {
    const text = deltaText(body as CompanionRunEvent);
    const last = run.entries.at(-1);
    // Coalesce into the newest unsent delta of the same kind (and tool).
    if (
      last &&
      text !== null &&
      run.entries.length > run.inFlight &&
      last.event.type === body.type
    ) {
      const lastText = deltaText(last.event) ?? '';
      if (lastText.length + text.length <= MAX_CHUNK) {
        if (last.event.type === 'tool.output' && body.type === 'tool.output') {
          if (last.event.data.toolId === body.data.toolId) {
            last.event.data.chunk += text;
            last.size += text.length;
            run.size += text.length;
            return;
          }
        } else if (last.event.type === 'text.delta' || last.event.type === 'reasoning.delta') {
          last.event.data.text += text;
          last.size += text.length;
          run.size += text.length;
          return;
        }
      }
    }
    const parsed = companionRunEventSchema.safeParse({ ...body, seq: run.nextSeq });
    if (!parsed.success) {
      log.warn(`Dropped an invalid ${body.type} event: ${parsed.error.issues[0]?.message}`);
      if (body.type !== 'terminal') return;
      // A run must still end: fall back to a terminal the contract always accepts.
      const fallback = companionRunEventSchema.parse({
        data: {
          failure: { class: 'crash', message: 'The run ended with an unreportable error.' },
          status: 'failed',
        },
        seq: run.nextSeq,
        type: 'terminal',
      });
      run.entries.push({ event: fallback, size: EVENT_OVERHEAD });
      run.nextSeq += 1;
      return;
    }
    const size = EVENT_OVERHEAD + (text?.length ?? JSON.stringify(parsed.data.data).length);
    run.entries.push({ event: parsed.data, size });
    run.size += size;
    run.nextSeq += 1;
  }

  private trim(run: RunBuffer): void {
    if (run.size <= this.maxBufferedChars) return;
    let dropped = 0;
    for (let i = run.inFlight; i < run.entries.length && run.size > this.maxBufferedChars;) {
      const entry = run.entries[i];
      if (entry && DELTA_TYPES.has(entry.event.type)) {
        run.entries.splice(i, 1);
        run.size -= entry.size;
        dropped += 1;
      } else {
        i += 1;
      }
    }
    if (dropped && !run.droppedWarned) {
      run.droppedWarned = true;
      log.warn(
        'BAIOS is unreachable and the run is busy; dropping buffered output to save memory.',
      );
    }
  }

  private schedule(key: string, run: RunBuffer, delayMs: number): void {
    if (run.inFlight > 0) return; // the send in progress reschedules when it settles
    if (run.timer) {
      if (delayMs > 0) return;
      clearTimeout(run.timer);
    }
    run.timer = setTimeout(() => {
      run.timer = null;
      void this.send(key, run);
    }, delayMs);
  }

  private async send(key: string, run: RunBuffer): Promise<void> {
    if (this.stopped || run.entries.length === 0) return this.settle(key, run);
    const batch = run.entries.slice(0, this.maxBatch);
    run.inFlight = batch.length;
    let retryIn: number | null = null;
    try {
      await this.post(
        run.runId,
        run.turn,
        batch.map((entry) => entry.event),
      );
      run.attempt = 0;
      this.drop(run, batch.length);
    } catch (error) {
      if (error instanceof DeviceRevokedError) {
        run.inFlight = 0;
        this.stop();
        this.onRevoked?.();
        return;
      }
      if (error instanceof HttpError && !error.retryable) {
        // The server will refuse this batch every time (run gone, not ours, invalid); give it up.
        log.warn(`BAIOS refused run events (${error.message}); dropping ${batch.length}.`);
        this.drop(run, batch.length);
      } else {
        run.attempt += 1;
        retryIn = backoffDelay(run.attempt);
        log.debug(`Run events not delivered (${String(error)}); retrying in ${retryIn} ms.`);
      }
    }
    run.inFlight = 0;
    if (retryIn !== null) this.schedule(key, run, retryIn);
    else if (run.entries.length > 0) this.schedule(key, run, 0);
    else this.settle(key, run);
  }

  private drop(run: RunBuffer, count: number): void {
    for (const entry of run.entries.splice(0, count)) run.size -= entry.size;
  }

  private settle(key: string, run: RunBuffer): void {
    if (run.closed && run.entries.length === 0) this.runs.delete(key);
    if (this.stopped || [...this.runs.values()].every((other) => other.entries.length === 0)) {
      for (const done of this.drained) done();
      this.drained.clear();
    }
  }

  /** Resolves true once every buffered event is delivered, false after `timeoutMs`. */
  drain(timeoutMs: number): Promise<boolean> {
    const busy = [...this.runs.values()].some((run) => run.entries.length > 0);
    if (!busy || this.stopped) return Promise.resolve(!busy);
    for (const [key, run] of this.runs) {
      if (run.entries.length) {
        run.attempt = 0;
        this.schedule(key, run, 0);
      }
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.drained.delete(done);
        resolve(false);
      }, timeoutMs);
      this.drained.add(done);
    });
  }

  stop(): void {
    this.stopped = true;
    for (const run of this.runs.values()) if (run.timer) clearTimeout(run.timer);
    for (const done of this.drained) done();
    this.drained.clear();
  }
}
