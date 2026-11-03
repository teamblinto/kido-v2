import { Logger } from '@nestjs/common';
import type { RunEventRow } from '@repo/db';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from 'vitest';

import type { TenantTransaction } from '../../database/database.types';
import type { TenantTransactionRunner } from '../../database/tenant-transaction';
import type { RunStore } from './run-store';
import { RunStreamPublisher, type StreamRow } from './run-stream-publisher';
import { DEFAULT_STREAM_TIMINGS, streamKey } from './stream.constants';

const reachable = inject('redisReachable');
const ORG = 'd1000000-0000-4000-8000-000000000001';
const AT = new Date('2026-09-14T10:00:00.000Z');
const tx = { tag: 'tx' } as unknown as TenantTransaction;

/** Built as `RedisModule.client` builds the stream role: lazy, one retry, errors logged not thrown. */
function client(url = process.env.REDIS_STREAM_URL!): Redis {
  const redis = new Redis(url, {
    connectTimeout: 2_000,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });

  redis.on('error', () => undefined);

  return redis;
}

function durable(seq: number, type: StreamRow['type'] = 'tool.start'): StreamRow {
  return { at: AT, data: { input: {}, stepId: `s/${seq}`, tool: 't' }, seq, type };
}

function delta(seq: number, chunk = 'x'): StreamRow {
  return { at: AT, data: { chunk, stepId: `s/${seq}` }, seq, type: 'tool.delta' };
}

/** `run_events` as the store reads them: `seq > after`, ascending, at most `limit`. */
function fakeStore(rows: readonly StreamRow[], runId: string) {
  return {
    readEvents: vi.fn(
      (_tx: unknown, _orgId: string, _runId: string, after: number, limit: number) =>
        Promise.resolve(
          rows
            .filter((row) => row.seq > after)
            .slice(0, limit)
            .map((row): RunEventRow => ({ ...row, orgId: ORG, runId }) as RunEventRow),
        ),
    ),
  };
}

const transactions = {
  runInTenantTransaction: (_orgId: string, fn: (tx: TenantTransaction) => Promise<unknown>) =>
    fn(tx),
} as unknown as TenantTransactionRunner;

describe.skipIf(!reachable)('RunStreamPublisher', () => {
  let redis: Redis;
  let runId: string;
  let key: string;
  let warn: ReturnType<typeof vi.fn<(message: string) => void>>;

  beforeAll(async () => {
    redis = client();
    await redis.connect();
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(() => {
    runId = randomUUID();
    key = streamKey(runId);
    warn = vi.fn<(message: string) => void>();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: string) => {
      warn(message);
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await redis.del(key);
  });

  function publisher(rows: readonly StreamRow[] = [], timings = DEFAULT_STREAM_TIMINGS) {
    const store = fakeStore(rows, runId);

    return {
      publisher: new RunStreamPublisher(redis, timings, store as unknown as RunStore, transactions),
      store,
    };
  }

  describe('append', () => {
    it('writes durable rows at S-0 and non-durable at S-*, in order, with seq / type / event fields', async () => {
      const { publisher: sut } = publisher();

      expect(await sut.append(ORG, runId, [durable(3), delta(3, 'a'), delta(3, 'b')])).toBe(3);
      expect(await sut.append(ORG, runId, [durable(4, 'tool.end')])).toBe(4);

      const entries = await redis.xrange(key, '-', '+');

      expect(entries.map(([id]) => id)).toEqual(['3-0', '3-1', '3-2', '4-0']);
      expect(entries[0]![1]).toEqual([
        'seq',
        '3',
        'type',
        'tool.start',
        'event',
        JSON.stringify({
          at: AT.toISOString(),
          data: { input: {}, stepId: 's/3', tool: 't' },
          run: runId,
          seq: 3,
          type: 'tool.start',
        }),
      ]);
      expect(entries[1]![1]).toContain('tool.delta');
    });

    it('sets the TTL on the key and caps the stream', async () => {
      const { publisher: sut } = publisher([], { ...DEFAULT_STREAM_TIMINGS, maxLen: 2 });

      for (let seq = 1; seq <= 400; seq += 1) {
        await sut.append(ORG, runId, [durable(seq)]);
      }

      const ttl = await redis.ttl(key);

      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(DEFAULT_STREAM_TIMINGS.ttlSeconds);
      // `~` trims at node boundaries, so the cap is approximate — but it is a cap.
      expect(await redis.xlen(key)).toBeLessThan(400);
    });

    it('swallows an id at or below the top: the row is already there', async () => {
      const { publisher: sut } = publisher();

      await sut.append(ORG, runId, [durable(5)]);

      expect(await sut.append(ORG, runId, [durable(4), durable(5), delta(4)])).toBe(5);
      expect((await redis.xrange(key, '-', '+')).map(([id]) => id)).toEqual(['5-0']);
      expect(warn).not.toHaveBeenCalled();
    });

    it('logs once with the run and the seq range when the instance is unreachable, and resolves', async () => {
      const dead = client('redis://127.0.0.1:1');
      const sut = new RunStreamPublisher(
        dead,
        DEFAULT_STREAM_TIMINGS,
        fakeStore([], runId) as unknown as RunStore,
        transactions,
      );

      try {
        expect(await sut.append(ORG, runId, [durable(2), delta(2), durable(3)])).toBe(3);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]![0]).toMatch(new RegExp(`${runId}.*2\\.\\.3`));
      } finally {
        dead.disconnect();
      }
    });

    it('does nothing for no rows', async () => {
      const { publisher: sut } = publisher();

      expect(await sut.append(ORG, runId, [])).toBe(0);
      expect(await redis.exists(key)).toBe(0);
    });
  });

  describe('sync', () => {
    const history = [durable(1, 'state'), durable(2, 'state'), durable(3), durable(4, 'tool.end')];

    it('appends every Postgres row on an empty stream', async () => {
      const { publisher: sut, store } = publisher(history);

      expect(await sut.sync(ORG, runId)).toBe(4);
      expect((await redis.xrange(key, '-', '+')).map(([id]) => id)).toEqual([
        '1-0',
        '2-0',
        '3-0',
        '4-0',
      ]);
      expect(store.readEvents).toHaveBeenCalledWith(
        tx,
        ORG,
        runId,
        0,
        DEFAULT_STREAM_TIMINGS.pageSize,
      );
    });

    it('appends exactly the rows past the top entry, through the deltas that follow it', async () => {
      const { publisher: sut } = publisher(history);

      await sut.append(ORG, runId, [durable(1, 'state'), durable(2, 'state'), delta(2)]);

      expect(await sut.sync(ORG, runId)).toBe(4);
      expect((await redis.xrange(key, '-', '+')).map(([id]) => id)).toEqual([
        '1-0',
        '2-0',
        '2-1',
        '3-0',
        '4-0',
      ]);
    });

    it('reads nothing more and answers the top when the stream is caught up', async () => {
      const { publisher: sut, store } = publisher(history);

      await sut.sync(ORG, runId);
      store.readEvents.mockClear();

      expect(await sut.sync(ORG, runId)).toBe(4);
      expect(store.readEvents).toHaveBeenCalledTimes(1);
      expect(store.readEvents.mock.calls[0]![3]).toBe(4);
      expect(await redis.xlen(key)).toBe(4);
    });

    it('pages through Postgres', async () => {
      const many = Array.from({ length: 7 }, (_unused, index) => durable(index + 1));
      const { publisher: sut, store } = publisher(many, { ...DEFAULT_STREAM_TIMINGS, pageSize: 3 });

      expect(await sut.sync(ORG, runId)).toBe(7);
      expect(store.readEvents.mock.calls.map((call) => call[3])).toEqual([0, 3, 6, 7]);
      expect(await redis.xlen(key)).toBe(7);
    });

    it('logs once and resolves when the instance is unreachable', async () => {
      const dead = client('redis://127.0.0.1:1');
      const sut = new RunStreamPublisher(
        dead,
        DEFAULT_STREAM_TIMINGS,
        fakeStore(history, runId) as unknown as RunStore,
        transactions,
      );

      try {
        expect(await sut.sync(ORG, runId)).toBe(0);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]![0]).toContain(runId);
      } finally {
        dead.disconnect();
      }
    });
  });
});
