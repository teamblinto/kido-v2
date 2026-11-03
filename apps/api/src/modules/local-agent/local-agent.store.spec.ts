import type { CompanionRunEvent } from '@repo/contracts';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';

import { DEFAULT_LOCAL_AGENT_TIMINGS } from './local-agent.constants';
import { LocalAgentStore, orderedBySeq } from './local-agent.store';

const RUN = 'b0400000-0000-4000-8000-000000000001';

function text(seq: number, value = `t${String(seq)}`): CompanionRunEvent {
  return { data: { text: value }, seq, type: 'text.delta' };
}

/**
 * Redis's own rule for an explicit stream id, in memory: an id at or below the stream's top is
 * refused with the error Redis gives. That rule *is* the dedupe, so the fake keeps exactly it.
 * Hashes and counters only as far as the active-turn marker and the byte budget need them.
 */
function fakeRedis() {
  const streams = new Map<string, { id: number; value: string }[]>();
  const hashes = new Map<string, Record<string, string>>();
  const counters = new Map<string, number>();
  const pipeline = () => {
    const ops: (() => [Error | null, unknown])[] = [];
    const chain = {
      del: (...names: string[]) => {
        ops.push(() => {
          for (const name of names) {
            streams.delete(name);
            hashes.delete(name);
            counters.delete(name);
          }
          return [null, names.length];
        });
        return chain;
      },
      exec: () => Promise.resolve(ops.map((op) => op())),
      expire: () => {
        ops.push(() => [null, 1]);
        return chain;
      },
      hset: (key: string, fields: Record<string, string>) => {
        ops.push(() => {
          hashes.set(key, { ...hashes.get(key), ...fields });
          return [null, 1];
        });
        return chain;
      },
      incrby: (key: string, by: number) => {
        ops.push(() => {
          counters.set(key, (counters.get(key) ?? 0) + by);
          return [null, counters.get(key)];
        });
        return chain;
      },
      xadd: (key: string, ...args: (string | number)[]) => {
        const id = Number(String(args[3]).split('-')[0]);
        ops.push(() => {
          const stream = streams.get(key) ?? [];
          if (stream.length > 0 && id <= stream.at(-1)!.id) {
            return [
              new Error(
                'ERR The ID specified in XADD is equal or smaller than the target stream top item',
              ),
              null,
            ];
          }
          stream.push({ id, value: String(args.at(-1)) });
          streams.set(key, stream);
          return [null, `${String(id)}-0`];
        });
        return chain;
      },
    };
    return chain;
  };
  const redis = {
    del: (name: string) => Promise.resolve(Number(hashes.delete(name))),
    hgetall: (key: string) => Promise.resolve(hashes.get(key) ?? {}),
    multi: pipeline,
    pipeline,
  };

  return { redis: redis as unknown as Redis, streams };
}

describe('orderedBySeq', () => {
  it('sorts a batch by seq and keeps the first of a repeated seq', () => {
    expect(orderedBySeq([text(3), text(1), text(2), text(1, 'again')])).toEqual([
      text(1),
      text(2),
      text(3),
    ]);
  });
});

describe('LocalAgentStore.appendRunEvents', () => {
  it('appends each seq once, so a retried or overlapping batch is idempotent', async () => {
    const { redis, streams } = fakeRedis();
    const store = new LocalAgentStore(redis, DEFAULT_LOCAL_AGENT_TIMINGS);
    await store.beginTurn(RUN, 1, 0);

    const appended = (accepted: number) => ({ accepted, kind: 'appended' });
    await expect(store.appendRunEvents(RUN, 1, [text(1), text(2)])).resolves.toEqual(appended(2));
    await expect(store.appendRunEvents(RUN, 1, [text(1), text(2)])).resolves.toEqual(appended(0));
    await expect(store.appendRunEvents(RUN, 1, [text(3), text(2), text(4)])).resolves.toEqual(
      appended(2),
    );

    const stored = streams.get(`local-agent:run:${RUN}:events:1`)!;
    expect(stored.map((entry) => entry.id)).toEqual([1, 2, 3, 4]);
    expect(JSON.parse(stored[0]!.value)).toEqual(text(1));
  });

  it('takes events only for the active turn: none before a turn, a stale one or after it ends', async () => {
    const { redis, streams } = fakeRedis();
    const store = new LocalAgentStore(redis, DEFAULT_LOCAL_AGENT_TIMINGS);

    await expect(store.appendRunEvents(RUN, 1, [text(1)])).resolves.toEqual({
      kind: 'not-active',
    });

    await store.beginTurn(RUN, 2, 0);
    // A late retry of turn 1 neither lands in turn 2 nor spends its seqs.
    await expect(store.appendRunEvents(RUN, 1, [text(1)])).resolves.toEqual({
      kind: 'not-active',
    });
    await expect(store.appendRunEvents(RUN, 2, [text(1)])).resolves.toEqual({
      accepted: 1,
      kind: 'appended',
    });
    expect(streams.has(`local-agent:run:${RUN}:events:1`)).toBe(false);

    await store.endTurn(RUN);
    await expect(store.appendRunEvents(RUN, 2, [text(2)])).resolves.toEqual({
      kind: 'not-active',
    });
  });

  it('refuses a batch past the turn’s byte budget, and a fresh turn starts a fresh budget', async () => {
    const { redis } = fakeRedis();
    const store = new LocalAgentStore(redis, {
      ...DEFAULT_LOCAL_AGENT_TIMINGS,
      runEventBudgetBytes: 200,
    });
    await store.beginTurn(RUN, 1, 0);

    await expect(store.appendRunEvents(RUN, 1, [text(1)])).resolves.toMatchObject({
      kind: 'appended',
    });
    await expect(store.appendRunEvents(RUN, 1, [text(2, 'x'.repeat(200))])).resolves.toEqual({
      kind: 'over-budget',
    });

    await store.beginTurn(RUN, 2, 0);
    await expect(store.appendRunEvents(RUN, 2, [text(1)])).resolves.toMatchObject({
      kind: 'appended',
    });
  });

  it('rethrows a Redis failure that is not a duplicate', async () => {
    const { redis } = fakeRedis();
    const store = new LocalAgentStore(redis, DEFAULT_LOCAL_AGENT_TIMINGS);
    await store.beginTurn(RUN, 1, 0);
    const failing = {
      exec: () =>
        Promise.resolve([
          [new Error('OOM'), null],
          [null, 1],
        ]),
      expire: () => failing,
      xadd: () => failing,
    };
    (redis as unknown as { pipeline: () => unknown }).pipeline = () => failing;

    await expect(store.appendRunEvents(RUN, 1, [text(1)])).rejects.toThrow('OOM');
  });
});
