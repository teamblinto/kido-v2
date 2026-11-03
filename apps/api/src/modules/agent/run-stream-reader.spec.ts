import type { AgentRun, RunEventRow } from '@repo/db';
import type { Redis } from 'ioredis';
import type { ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeClock } from '../../common/clock/fake-clock';
import type { TenantTransaction } from '../../database/database.types';
import type { TenantTransactionRunner } from '../../database/tenant-transaction';
import { RunStreamReader, type StreamRequest } from './run-stream-reader';
import type { RunStore } from './run-store';
import { DEFAULT_STREAM_TIMINGS, streamKey } from './stream.constants';

const ORG = 'c1000000-0000-4000-8000-00000000000a';
const PROJECT = 'c1000000-0000-4000-8000-00000000000b';
const RUN = 'c1000000-0000-4000-8000-000000000001';
const START = '2026-09-14T10:00:00.000Z';
const KEY = streamKey(RUN);

type Entry = [string, string[]];
type Reply = [string, Entry[]][] | null;

/** A stream entry as the publisher files it: `seq` / `type` / `event` fields, id `S-0` or `S-k`. */
function entry(seq: number, type: string, data: Record<string, unknown> = {}, offset = 0): Entry {
  const event = JSON.stringify({ at: START, data, run: RUN, seq, type });

  return [`${seq}-${offset}`, ['seq', String(seq), 'type', type, 'event', event]];
}

function row(seq: number, type: string, data: Record<string, unknown> = {}): RunEventRow {
  return { at: new Date(START), data, orgId: ORG, runId: RUN, seq, type } as RunEventRow;
}

function run(status: AgentRun['status'], nextSeq: number): AgentRun {
  return {
    cancelRequestedAt: null,
    costMicros: 0,
    createdAt: new Date(START),
    endedAt: null,
    failureClass: null,
    id: RUN,
    inputTokens: 0,
    leaseEpoch: 0,
    leaseOwner: null,
    leaseUntil: null,
    model: 'scripted',
    nextSeq,
    orgId: ORG,
    outputTokens: 0,
    projectId: PROJECT,
    startedAt: null,
    status,
    updatedAt: new Date(START),
    userId: 'c1000000-0000-4000-8000-0000000000ff',
  } as AgentRun;
}

/**
 * Spec 009 research R5 / data-model.md § Reader state: the loop over a fake stream and a fake
 * store. What is proved is the cursor — every durable seq past `Last-Event-ID` exactly once, in
 * order, whatever the stream holds — and the four ways the loop leaves it: a terminal `state`
 * frame, a terminal row at heartbeat (drain), an aged-out seq (one `stream.reset`), and the
 * viewer's socket closing.
 */
describe('RunStreamReader', () => {
  let clock: FakeClock;
  let written: string[];
  let ended: boolean;
  let replies: Reply[];
  let reads: string[];
  let pending: { reject: (error: Error) => void } | undefined;
  let first: Entry | undefined;
  let events: RunEventRow[];
  let status: AgentRun['status'];
  let duplicate: {
    disconnect: ReturnType<typeof vi.fn>;
    xrange: ReturnType<typeof vi.fn>;
    xread: ReturnType<typeof vi.fn>;
  };
  let transactions: number;
  let reader: RunStreamReader;
  let controller: AbortController;

  function request(overrides: Partial<StreamRequest> = {}): StreamRequest {
    controller = new AbortController();

    return {
      from: 0,
      lastSeq: 0,
      orgId: ORG,
      projectId: PROJECT,
      res: {
        end: () => {
          ended = true;
        },
        write: (chunk: string) => {
          written.push(chunk);

          return true;
        },
      } as unknown as ServerResponse,
      runId: RUN,
      signal: controller.signal,
      terminal: false,
      ...overrides,
    };
  }

  function frames(): { data?: unknown; event?: string; id?: string; comment?: string }[] {
    return written.map((chunk) => {
      const frame: { data?: unknown; event?: string; id?: string; comment?: string } = {};

      for (const line of chunk.trimEnd().split('\n')) {
        if (line.startsWith(':')) {
          frame.comment = line.slice(1);
        } else if (line.startsWith('event: ')) {
          frame.event = line.slice(7);
        } else if (line.startsWith('id: ')) {
          frame.id = line.slice(4);
        } else if (line.startsWith('data: ')) {
          frame.data = JSON.parse(line.slice(6));
        }
      }

      return frame;
    });
  }

  function durableIds(): number[] {
    return frames()
      .filter((frame) => frame.id !== undefined)
      .map((frame) => Number(frame.id));
  }

  beforeEach(() => {
    clock = new FakeClock(START);
    written = [];
    ended = false;
    replies = [];
    reads = [];
    pending = undefined;
    first = undefined;
    events = [];
    status = 'running';
    transactions = 0;
    duplicate = {
      disconnect: vi.fn(() => {
        pending?.reject(new Error('Connection is closed.'));
      }),
      xrange: vi.fn(() => Promise.resolve(first === undefined ? [] : [first])),
      xread: vi.fn((...args: unknown[]) => {
        reads.push(String(args.at(-1)));

        const next = replies.shift();

        if (next === undefined) {
          // Nothing scripted: block like Redis would, until the socket closes.
          return new Promise((_resolve, reject) => {
            pending = { reject };
          });
        }

        return Promise.resolve(next);
      }),
    };

    const redis = { duplicate: () => duplicate } as unknown as Redis;
    const store = {
      readEvents: vi.fn((_tx: unknown, _org: string, _run: string, after: number, limit: number) =>
        Promise.resolve(events.filter((event) => event.seq > after).slice(0, limit)),
      ),
      readRun: vi.fn(() => Promise.resolve(run(status, (events.at(-1)?.seq ?? 0) + 1))),
    };
    const runner = {
      runInTenantTransaction: (_org: string, fn: (tx: TenantTransaction) => Promise<unknown>) => {
        transactions += 1;

        return fn({} as TenantTransaction);
      },
    };

    reader = new RunStreamReader(
      redis,
      { ...DEFAULT_STREAM_TIMINGS, pageSize: 2 },
      store as unknown as RunStore,
      runner as unknown as TenantTransactionRunner,
      clock,
    );
  });

  it('writes no frame of its own on open — the headers and retry are the handler’s', async () => {
    first = entry(1, 'state', { from: null, to: 'queued' });
    replies = [[[KEY, [entry(1, 'state', { from: null, to: 'queued' })]]]];

    const serving = reader.serve(request({ lastSeq: 1 }));

    await vi.waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]).toMatch(/^event: state\nid: 1\ndata: /);
    controller.abort();
    await serving;
  });

  it('replays every entry past N-0 and ends the response after a terminal state frame', async () => {
    first = entry(1, 'state', { from: null, to: 'queued' });
    replies = [
      [
        [
          KEY,
          [
            entry(3, 'tool.start', { stepId: 's' }),
            entry(3, 'tool.delta', { chunk: 'w', stepId: 's' }, 1),
            entry(4, 'tool.end', { stepId: 's' }),
          ],
        ],
      ],
      [[KEY, [entry(5, 'state', { from: 'running', to: 'succeeded' })]]],
    ];

    await reader.serve(request({ from: 2, lastSeq: 5 }));

    expect(reads[0]).toBe('2-0');
    expect(frames().map((frame) => [frame.event, frame.id])).toEqual([
      ['tool.start', '3'],
      ['tool.delta', undefined],
      ['tool.end', '4'],
      ['state', '5'],
    ]);
    expect(ended).toBe(true);
    expect(duplicate.disconnect).toHaveBeenCalled();
    expect(transactions).toBe(0);
  });

  it('drops a durable entry at or below what it has delivered', async () => {
    first = entry(1, 'state');
    replies = [
      [[KEY, [entry(2, 'tool.start'), entry(3, 'tool.end'), entry(2, 'tool.start')]]],
      [[KEY, [entry(4, 'state', { from: 'running', to: 'succeeded' })]]],
    ];

    await reader.serve(request({ from: 1, lastSeq: 4 }));

    expect(durableIds()).toEqual([2, 3, 4]);
  });

  it('gap-fills from Postgres when an entry skips past delivered + 1', async () => {
    first = entry(1, 'state');
    events = [row(2, 'tool.start'), row(3, 'tool.end'), row(4, 'file.patch'), row(5, 'usage')];
    replies = [
      [[KEY, [entry(5, 'usage'), entry(6, 'state', { from: 'running', to: 'succeeded' })]]],
    ];

    await reader.serve(request({ from: 1, lastSeq: 6 }));

    expect(durableIds()).toEqual([2, 3, 4, 5, 6]);
    expect(transactions).toBe(1);
  });

  it('heartbeats on an XREAD timeout and keeps tailing while the run is live', async () => {
    first = entry(1, 'state');
    replies = [null, null, [[KEY, [entry(2, 'state', { from: 'running', to: 'failed' })]]]];

    await reader.serve(request({ from: 1, lastSeq: 1 }));

    expect(frames().map((frame) => frame.comment ?? frame.id)).toEqual([
      'heartbeat',
      'heartbeat',
      '2',
    ]);
  });

  it('drains from Postgres and closes when the run is terminal at a heartbeat', async () => {
    first = entry(1, 'state');
    events = [row(2, 'usage'), row(3, 'state', { from: 'running', to: 'failed' })];
    status = 'failed';
    replies = [null];

    await reader.serve(request({ from: 1, lastSeq: 1 }));

    expect(frames().map((frame) => frame.comment ?? frame.id)).toEqual(['heartbeat', '2', '3']);
    expect(ended).toBe(true);
  });

  it('replays a finished run without blocking and closes when the stream is caught up', async () => {
    first = entry(1, 'state');
    events = [row(1, 'state'), row(2, 'state', { from: 'running', to: 'succeeded' })];
    status = 'succeeded';
    replies = [[[KEY, [entry(1, 'state')]]], null];

    await reader.serve(request({ from: 0, lastSeq: 2, terminal: true }));

    expect(duplicate.xread).toHaveBeenCalledTimes(2);
    expect(duplicate.xread.mock.calls[0]).not.toContain('BLOCK');
    expect(frames().map((frame) => frame.comment ?? frame.id)).toEqual(['1', '2']);
    expect(ended).toBe(true);
  });

  it('sends one stream.reset with the Postgres snapshot when the requested seq has aged out', async () => {
    first = entry(5, 'tool.start');
    events = [row(4, 'tool.end'), row(5, 'tool.start'), row(6, 'tool.end')];
    replies = [[[KEY, [entry(7, 'state', { from: 'running', to: 'succeeded' })]]]];

    await reader.serve(request({ from: 3, lastSeq: 7 }));

    const [reset, ...rest] = frames();

    expect(reset).toMatchObject({ event: 'stream.reset', id: '6' });
    expect(reset!.data).toMatchObject({
      at: START,
      run: RUN,
      seq: 6,
      type: 'stream.reset',
    });
    expect(
      (reset!.data as { data: { events: { seq: number }[] } }).data.events.map((e) => e.seq),
    ).toEqual([4, 5, 6]);
    expect((reset!.data as { data: { run: { id: string } } }).data.run.id).toBe(RUN);
    expect(reads[0]).toBe('6-0');
    expect(rest.map((frame) => frame.id)).toEqual(['7']);
  });

  it('resets when the key is gone and the requested seq is behind the run', async () => {
    events = [row(1, 'state'), row(2, 'state', { from: 'queued', to: 'cancelled' })];
    status = 'cancelled';

    await reader.serve(request({ from: 0, lastSeq: 2, terminal: true }));

    expect(frames().map((frame) => [frame.event, frame.id])).toEqual([['stream.reset', '2']]);
    expect(reads).toEqual([]);
    expect(ended).toBe(true);
  });

  it('serves an empty key at the run’s last seq from the stream, without a reset', async () => {
    replies = [[[KEY, [entry(2, 'state', { from: 'running', to: 'succeeded' })]]]];

    await reader.serve(request({ from: 1, lastSeq: 1 }));

    expect(frames().map((frame) => frame.event)).toEqual(['state']);
  });

  it('disconnects the duplicate and stops when the viewer’s socket closes', async () => {
    first = entry(1, 'state');

    const serving = reader.serve(request({ from: 1, lastSeq: 1 }));

    await vi.waitFor(() => expect(reads).toHaveLength(1));
    controller.abort();
    await serving;

    expect(duplicate.disconnect).toHaveBeenCalled();
    expect(ended).toBe(true);
    expect(written).toEqual([]);
  });

  it('never rejects: a failing XREAD ends the response', async () => {
    first = entry(1, 'state');
    duplicate.xread.mockImplementation(() => Promise.reject(new Error('boom')));

    await expect(reader.serve(request({ from: 1, lastSeq: 1 }))).resolves.toBeUndefined();
    expect(ended).toBe(true);
    expect(duplicate.disconnect).toHaveBeenCalled();
  });
});
