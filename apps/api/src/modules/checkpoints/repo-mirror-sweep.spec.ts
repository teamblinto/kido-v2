import type { Checkpoint } from '@repo/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeClock } from '../../common/clock/fake-clock';
import { RetryableFailure } from '../outbox/consumer';
import { MIRROR_SWEEP_BATCH, MIRROR_SWEEP_GRACE_MS, RepoMirrorSweep } from './repo-mirror-sweep';

const NOW = new Date('2026-11-06T12:00:00.000Z');
const OLD = new Date(NOW.getTime() - MIRROR_SWEEP_GRACE_MS - 1);

const head = (id: string, values: Partial<Checkpoint> = {}): Checkpoint =>
  ({
    createdAt: OLD,
    gitSha: `sha-${id}`,
    id,
    mirroredAt: null,
    orgId: 'org',
    projectId: `project-${id}`,
    ...values,
  }) as Checkpoint;

/** The reads stubbed at the shape the sweep issues them: every head, then the bundleable projects. */
function sweepOver(heads: readonly Checkpoint[], live = heads.map((row) => row.projectId)) {
  const tx = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => Promise.resolve(live.map((id) => ({ id }))),
        }),
      }),
    }),
    selectDistinctOn: () => ({
      from: () => ({ where: () => ({ orderBy: () => Promise.resolve(heads) }) }),
    }),
  };
  const db = {
    select: () => ({ from: () => ({ where: () => Promise.resolve([{ id: 'org' }]) }) }),
  };
  const transactions = {
    runInTenantTransaction: (_org: string, fn: (handle: typeof tx) => unknown) => fn(tx),
  };
  const guards = new Set<string>();
  const redis = {
    del: vi.fn((key: string) => Promise.resolve(guards.delete(key) ? 1 : 0)),
    set: vi.fn((key: string) => {
      if (guards.has(key)) return Promise.resolve(null);
      guards.add(key);
      return Promise.resolve('OK');
    }),
  };
  const mirrors = { mirror: vi.fn((_job: unknown) => Promise.resolve()) };
  const service = new RepoMirrorSweep(
    db as never,
    transactions as never,
    redis as never,
    mirrors as never,
    new FakeClock(NOW),
  );

  return { guards, mirrors, redis, service };
}

describe('RepoMirrorSweep', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('mirrors an old unmirrored head under its own sha', async () => {
    const row = head('a');
    const { mirrors, service } = sweepOver([row]);

    expect(await service.sweep()).toEqual({ failed: 0, mirrored: 1, waking: 0 });
    expect(mirrors.mirror).toHaveBeenCalledWith({ head: 'sha-a', row });
  });

  it('leaves a mirrored head, one its own event is still on, and a project with no live sandbox', async () => {
    const { mirrors, service } = sweepOver(
      [head('a', { mirroredAt: NOW }), head('b', { createdAt: NOW }), head('c')],
      ['project-a', 'project-b'],
    );

    await service.sweep();

    expect(mirrors.mirror).not.toHaveBeenCalled();
  });

  it('wakes no more than a batch of sandboxes in one tick', async () => {
    const heads = Array.from({ length: MIRROR_SWEEP_BATCH + 3 }, (_, index) => head(String(index)));
    const { mirrors, service } = sweepOver(heads);

    await service.sweep();

    expect(mirrors.mirror).toHaveBeenCalledTimes(MIRROR_SWEEP_BATCH);
  });

  it('retries a sandbox still waking on the next tick', async () => {
    const { guards, mirrors, service } = sweepOver([head('a')]);
    mirrors.mirror.mockRejectedValueOnce(new RetryableFailure('timeout', new Error('resuming')));

    expect(await service.sweep()).toMatchObject({ waking: 1 });
    expect(guards.size).toBe(0);

    expect(await service.sweep()).toMatchObject({ mirrored: 1 });
  });

  it('holds back a head that failed, so it cannot keep its sandbox awake', async () => {
    const { mirrors, service } = sweepOver([head('a')]);
    mirrors.mirror.mockRejectedValueOnce(new Error('git failed'));

    expect(await service.sweep()).toMatchObject({ failed: 1 });
    expect(await service.sweep()).toEqual({ failed: 0, mirrored: 0, waking: 0 });
    expect(mirrors.mirror).toHaveBeenCalledTimes(1);
  });
});
