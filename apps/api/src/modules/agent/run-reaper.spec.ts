import { schema } from '@repo/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { openPool } from '../../../test/support/integration-database';
import { FakeClock } from '../../common/clock/fake-clock';
import type { RunProfile } from '../../config/run-profiles';
import type { ForgeDatabase, TenantTransaction } from '../../database/database.types';
import type { TenantTransactionRunner } from '../../database/tenant-transaction';
import { DEFAULT_AGENT_TIMINGS, RUN_LINE_SWEEP_AFTER_MS, RUN_REAPER_LOCK } from './agent.constants';
import { RunReaper } from './run-reaper';
import { FencedError, type RunStore, type StaleRun } from './run-store';
import type { RunStreamPublisher } from './run-stream-publisher';

const ORG_A = 'c1000000-0000-4000-8000-00000000000a';
const ORG_B = 'c1000000-0000-4000-8000-00000000000b';
const RUN = 'c1000000-0000-4000-8000-000000000001';
const PROJECT = 'c1000000-0000-4000-8000-000000000002';
const START = '2026-09-14T10:00:00.000Z';

/**
 * Spec 008 research R5, FR-020: a run whose lease is long expired is `failed` / `stalled` through
 * the ordinary transition, under the next epoch, so the worker that stalled is fenced out even if
 * it comes back. Which runs are stale is the store's query; what the reaper adds is the epoch
 * bump, the tenant loop and the daily partition call, and that is what is proved here.
 */
describe('RunReaper', () => {
  let clock: FakeClock;
  let store: {
    dispatch: ReturnType<typeof vi.fn>;
    expireLease: ReturnType<typeof vi.fn>;
    staleHeads: ReturnType<typeof vi.fn>;
    staleRuns: ReturnType<typeof vi.fn>;
    transition: ReturnType<typeof vi.fn>;
  };
  let execute: ReturnType<typeof vi.fn>;
  let publisher: { sync: ReturnType<typeof vi.fn> };
  let tenants: string[];
  let inTransaction: boolean;
  let reaper: RunReaper;
  let build: (profiles: readonly RunProfile[], database?: ForgeDatabase) => RunReaper;

  function stale(runs: Record<string, StaleRun[]>): void {
    store.staleRuns.mockImplementation((given: { org: string }) =>
      Promise.resolve(runs[given.org] ?? []),
    );
  }

  beforeEach(() => {
    clock = new FakeClock(START);
    tenants = [];
    inTransaction = false;
    store = {
      dispatch: vi.fn(() => Promise.resolve()),
      expireLease: vi.fn(() => Promise.resolve()),
      staleHeads: vi.fn(() => Promise.resolve([])),
      staleRuns: vi.fn(() => Promise.resolve([])),
      transition: vi.fn(() => Promise.resolve()),
    };
    execute = vi.fn(() => Promise.resolve({ rows: [] }));
    publisher = { sync: vi.fn(() => Promise.resolve(0)) };

    const db = {
      execute,
      select: () => ({
        from: () => ({ where: () => Promise.resolve([{ id: ORG_A }, { id: ORG_B }]) }),
      }),
      // The sweep's own transaction: here the try-lock always succeeds; the real one is proved below.
      transaction: (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ execute: () => Promise.resolve({ rows: [{ locked: true }] }) }),
    };
    const transactions = {
      runInTenantTransaction: async (
        orgId: string,
        fn: (tx: TenantTransaction) => Promise<unknown>,
      ) => {
        tenants.push(orgId);
        inTransaction = true;

        try {
          return await fn({ org: orgId } as unknown as TenantTransaction);
        } finally {
          inTransaction = false;
        }
      },
    };
    build = (profiles, database = db as unknown as ForgeDatabase) =>
      new RunReaper(
        database,
        store as unknown as RunStore,
        transactions as unknown as TenantTransactionRunner,
        clock,
        { ...DEFAULT_AGENT_TIMINGS, staleAfterMs: 120_000 },
        new Set(profiles),
        publisher as unknown as RunStreamPublisher,
      );
    reaper = build(['cron']);
  });

  it('asks each tenant for runs whose lease is older than staleAfterMs', async () => {
    await reaper.tick();

    expect(tenants).toEqual([ORG_A, ORG_B]);
    expect(store.staleRuns).toHaveBeenCalledTimes(2);
    expect(store.staleRuns.mock.calls[0]![1]).toEqual(new Date('2026-09-14T09:58:00.000Z'));
  });

  /** Spec 031 research R2: the sweep behind the release consumer, for a lost `agent-run.finished`. */
  it('re-dispatches the head of an unheld line older than RUN_LINE_SWEEP_AFTER_MS', async () => {
    store.staleHeads.mockImplementation((given: { org: string }) =>
      Promise.resolve(given.org === ORG_A ? [{ id: RUN, projectId: PROJECT }] : []),
    );

    await reaper.tick();

    expect(store.staleHeads).toHaveBeenCalledTimes(2);
    expect(store.staleHeads.mock.calls[0]![1]).toEqual(
      new Date(new Date(START).getTime() - RUN_LINE_SWEEP_AFTER_MS),
    );
    expect(store.dispatch).toHaveBeenCalledTimes(1);
    expect(store.dispatch).toHaveBeenCalledWith(
      { org: ORG_A },
      { orgId: ORG_A, projectId: PROJECT, runId: RUN },
    );
  });

  it('leaves a younger head and a held project alone', async () => {
    // Which heads qualify (unheld, older than the cut-off) is the store's query, proved in
    // run-store.spec.ts; an empty answer dispatches nothing.
    await reaper.tick();

    expect(store.staleHeads).toHaveBeenCalledTimes(2);
    expect(store.dispatch).not.toHaveBeenCalled();
  });

  it('fails a stale run through transition under the next epoch, with reason stalled', async () => {
    stale({ [ORG_A]: [{ id: RUN, leaseEpoch: 3, status: 'running' }] });

    expect(await reaper.tick()).toBe(1);

    expect(store.expireLease).toHaveBeenCalledWith(
      { org: ORG_A },
      { epoch: 3, orgId: ORG_A, runId: RUN },
    );
    expect(store.transition).toHaveBeenCalledWith(
      { org: ORG_A },
      {
        epoch: 4,
        failureClass: 'stalled',
        from: 'running',
        orgId: ORG_A,
        reason: 'stalled',
        runId: RUN,
        to: 'failed',
      },
    );
  });

  /** Spec 009 R1: the `failed` state event reaches the stream once the sweep's transaction is committed. */
  it('syncs the stream for every run it failed, after the tenant transaction, and for no other', async () => {
    stale({
      [ORG_A]: [
        { id: RUN, leaseEpoch: 1, status: 'running' },
        { id: ORG_B, leaseEpoch: 2, status: 'running' },
      ],
    });
    store.expireLease.mockRejectedValueOnce(new FencedError(RUN, 'expireLease', 1));
    publisher.sync.mockImplementation(() => {
      expect(inTransaction, 'sync ran inside the sweep transaction').toBe(false);

      return Promise.resolve(0);
    });

    await reaper.tick();

    expect(publisher.sync.mock.calls).toEqual([[ORG_A, ORG_B]]);
  });

  it.each(['starting', 'tool_error'] as const)(
    'fails a run stalled in %s from that state',
    async (status) => {
      stale({ [ORG_B]: [{ id: RUN, leaseEpoch: 1, status }] });

      await reaper.tick();

      expect(store.transition.mock.calls[0]![1]).toMatchObject({ from: status, to: 'failed' });
    },
  );

  it('leaves a run alone when a worker re-claimed it between the read and the write', async () => {
    stale({
      [ORG_A]: [
        { id: RUN, leaseEpoch: 1, status: 'running' },
        { id: ORG_B, leaseEpoch: 2, status: 'running' },
      ],
    });
    store.expireLease.mockRejectedValueOnce(new FencedError(RUN, 'expireLease', 1));

    expect(await reaper.tick()).toBe(1);

    expect(store.transition).toHaveBeenCalledTimes(1);
    expect(store.transition.mock.calls[0]![1]).toMatchObject({ epoch: 3, runId: ORG_B });
  });

  it('is idempotent across two ticks: a run failed on the first is not stale on the second', async () => {
    stale({ [ORG_A]: [{ id: RUN, leaseEpoch: 1, status: 'running' }] });

    expect(await reaper.tick()).toBe(1);

    stale({});

    expect(await reaper.tick()).toBe(0);
    expect(store.transition).toHaveBeenCalledTimes(1);
  });

  it('creates next month’s run_events partition once a day, on the first tick of the day', async () => {
    await reaper.tick();
    await reaper.tick();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      sql`select create_run_events_partition((${'2026-09-14'}::date + interval '1 month')::date)`,
    );

    clock.advance(24 * 60 * 60 * 1000);
    await reaper.tick();

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('ticks on the interval once bootstrapped, and stops on shutdown', async () => {
    vi.useFakeTimers();

    try {
      const tick = vi.spyOn(reaper, 'tick').mockResolvedValue(0);

      reaper.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(DEFAULT_AGENT_TIMINGS.reaperMs * 2);

      expect(tick).toHaveBeenCalledTimes(2);

      await reaper.onApplicationShutdown();
      await vi.advanceTimersByTimeAsync(DEFAULT_AGENT_TIMINGS.reaperMs * 2);

      expect(tick).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start its interval without the cron profile', async () => {
    vi.useFakeTimers();

    try {
      const agentOnly = build(['agent']);
      const tick = vi.spyOn(agentOnly, 'tick').mockResolvedValue(0);

      agentOnly.onApplicationBootstrap();

      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(DEFAULT_AGENT_TIMINGS.reaperMs * 2);

      expect(tick).not.toHaveBeenCalled();
      await agentOnly.onApplicationShutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never ticks in a process where the outbox is off, like the relay', async () => {
    vi.useFakeTimers();

    try {
      const off = build(['api']);
      const tick = vi.spyOn(off, 'tick').mockResolvedValue(0);

      off.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(DEFAULT_AGENT_TIMINGS.reaperMs * 2);

      expect(tick).not.toHaveBeenCalled();
      await off.onApplicationShutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Spec 013 R4, FR-013/FR-014: one reaper per tick, elected by a transaction-scoped advisory lock
   * on the application pool — the relay's shape with its own key. A second connection stands in
   * for the other cron replica.
   */
  describe('the reaper lock', () => {
    const reachable = inject('postgresReachable');
    /** Three: the sweep's transaction, its partition/tenant reads, and the rival process. */
    const pool = reachable ? openPool(process.env.DATABASE_URL ?? '', 3) : undefined;

    afterAll(async () => {
      await pool?.end();
    });

    it.skipIf(!reachable)('skips the tick when another process holds the reaper lock', async () => {
      const rival = await pool!.connect();

      try {
        await rival.query('begin');
        await rival.query('select pg_advisory_xact_lock($1::bigint)', [RUN_REAPER_LOCK.toString()]);

        expect(await build(['cron'], drizzle(pool!, { schema })).tick()).toBe(0);
        expect(store.staleRuns).not.toHaveBeenCalled();
      } finally {
        await rival.query('rollback');
        rival.release();
      }
    });

    it.skipIf(!reachable)(
      'sweeps under the reaper lock and releases it with the transaction',
      async () => {
        await build(['cron'], drizzle(pool!, { schema })).tick();

        const { rows } = await pool!.query<{ locked: boolean }>(
          'select pg_try_advisory_xact_lock($1::bigint) as locked',
          [RUN_REAPER_LOCK.toString()],
        );

        expect(rows[0]?.locked).toBe(true);
      },
    );
  });
});
