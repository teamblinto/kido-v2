import type { CompanionRunEvent } from '@repo/contracts';

import { DeviceRevokedError, HttpError } from './http.ts';
import { Uplink } from './uplink.ts';

const RUN = '6a1f8d1e-4a7b-4c3e-9a55-0b9c2a0f4d11';

function recorder() {
  const posts: CompanionRunEvent[][] = [];
  const turns: number[] = [];
  const attempts = { count: 0 };
  let failures: Error[] = [];
  const post = (_runId: string, turn: number, events: CompanionRunEvent[]) => {
    attempts.count += 1;
    const failure = failures.shift();
    if (failure) return Promise.reject(failure);
    turns.push(turn);
    posts.push(events.map((event) => structuredClone(event)));
    return Promise.resolve();
  };
  return { attempts, fail: (...errors: Error[]) => (failures = errors), post, posts, turns };
}

const text = (value: string) => ({ data: { text: value }, type: 'text.delta' }) as const;
const completed = { data: { status: 'completed' }, type: 'terminal' } as const;

describe('Uplink', () => {
  it('numbers events from 1, coalesces adjacent deltas and flushes a terminal at once', async () => {
    const { post, posts } = recorder();
    const uplink = new Uplink(post, { flushMs: 10_000 });
    uplink.push(RUN, 1, { data: { providerSessionId: 's1' }, type: 'session' });
    uplink.push(RUN, 1, text('Hel'));
    uplink.push(RUN, 1, text('lo'));
    uplink.push(RUN, 1, { data: { text: 'hmm' }, type: 'reasoning.delta' });
    uplink.push(RUN, 1, completed);
    expect(await uplink.drain(2_000)).toBe(true);
    expect(posts.flat()).toEqual([
      { data: { providerSessionId: 's1' }, seq: 1, type: 'session' },
      { data: { text: 'Hello' }, seq: 2, type: 'text.delta' },
      { data: { text: 'hmm' }, seq: 3, type: 'reasoning.delta' },
      { data: { status: 'completed' }, seq: 4, type: 'terminal' },
    ]);
  });

  it('sends at most maxBatch events per request', async () => {
    const { post, posts } = recorder();
    const uplink = new Uplink(post, { flushMs: 5, maxBatch: 3 });
    for (let i = 0; i < 7; i++) {
      uplink.push(RUN, 1, { data: { ok: true, summary: null, toolId: `t${i}` }, type: 'tool.end' });
    }
    uplink.push(RUN, 1, completed);
    expect(await uplink.drain(2_000)).toBe(true);
    expect(posts.map((batch) => batch.length)).toEqual([3, 3, 2]);
    expect(posts.flat().map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('retries a failed batch with the same seqs, so the server can dedupe', async () => {
    const { fail, post, posts } = recorder();
    fail(new TypeError('fetch failed'), new HttpError(503, '503 Service Unavailable'));
    const uplink = new Uplink(post, { flushMs: 1 });
    uplink.push(RUN, 1, text('a'));
    uplink.push(RUN, 1, completed);
    await vi.waitFor(() => expect(posts).toHaveLength(1), { interval: 50, timeout: 8_000 });
    expect(posts[0]?.map((event) => event.seq)).toEqual([1, 2]);
  });

  it('drops a batch the server refuses for good, and stops on a revoked device', async () => {
    const { attempts, fail, post, posts } = recorder();
    const onRevoked = vi.fn();
    const uplink = new Uplink(post, { flushMs: 1, onRevoked });
    fail(new HttpError(422, '422 Invalid'));
    uplink.push(RUN, 1, text('x'));
    await vi.waitFor(() => expect(attempts.count).toBe(1));
    expect(posts).toEqual([]);
    uplink.push(RUN, 1, text('y'));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual([{ data: { text: 'y' }, seq: 2, type: 'text.delta' }]);
    fail(new DeviceRevokedError());
    uplink.push(RUN, 1, completed);
    await vi.waitFor(() => expect(onRevoked).toHaveBeenCalledOnce());
  });

  it('bounds memory by dropping unsent deltas before structural events', async () => {
    const { fail, post, posts } = recorder();
    fail(...Array.from({ length: 50 }, () => new TypeError('offline')));
    const uplink = new Uplink(post, { flushMs: 60_000, maxBufferedChars: 3_000 });
    uplink.push(RUN, 1, { data: { input: {}, name: 'Bash', toolId: 't1' }, type: 'tool.start' });
    for (let i = 0; i < 5; i++) {
      uplink.push(RUN, 1, text('z'.repeat(1_000)));
      uplink.push(RUN, 1, { data: { ok: true, summary: null, toolId: `t${i}` }, type: 'tool.end' });
    }
    fail();
    uplink.push(RUN, 1, completed);
    expect(await uplink.drain(5_000)).toBe(true);
    const sent = posts.flat();
    expect(sent.filter((event) => event.type === 'tool.end')).toHaveLength(5);
    expect(sent.filter((event) => event.type === 'text.delta').length).toBeLessThan(5);
    expect(sent.at(-1)?.type).toBe('terminal');
  });

  it('splits an oversized delta into contract-sized chunks and drops invalid events', async () => {
    const { post, posts } = recorder();
    const uplink = new Uplink(post, { flushMs: 1 });
    uplink.push(RUN, 1, { data: { input: {}, name: '', toolId: 't1' }, type: 'tool.start' });
    uplink.push(RUN, 1, text('q'.repeat(70_000)));
    uplink.push(RUN, 1, completed);
    expect(await uplink.drain(2_000)).toBe(true);
    const sent = posts.flat();
    expect(sent.some((event) => event.type === 'tool.start')).toBe(false);
    expect(sent.filter((event) => event.type === 'text.delta').map((event) => event.seq)).toEqual([
      1, 2,
    ]);
  });

  it('keeps each turn apart: its own seqs from 1, and a late retry of turn 1 never joins turn 2', async () => {
    const { fail, post, posts, turns } = recorder();
    fail(new TypeError('fetch failed'));
    const uplink = new Uplink(post, { flushMs: 1 });
    uplink.push(RUN, 1, text('one'));
    uplink.push(RUN, 1, completed);
    uplink.push(RUN, 2, text('two'));
    uplink.push(RUN, 2, completed);
    await vi.waitFor(() => expect(posts).toHaveLength(2), { interval: 50, timeout: 8_000 });
    const byTurn = new Map(turns.map((turn, index) => [turn, posts[index]]));
    expect(byTurn.get(1)).toEqual([
      { data: { text: 'one' }, seq: 1, type: 'text.delta' },
      { data: { status: 'completed' }, seq: 2, type: 'terminal' },
    ]);
    expect(byTurn.get(2)).toEqual([
      { data: { text: 'two' }, seq: 1, type: 'text.delta' },
      { data: { status: 'completed' }, seq: 2, type: 'terminal' },
    ]);
  });
});
