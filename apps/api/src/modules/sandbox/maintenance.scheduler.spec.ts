import { outbox, schema } from '@repo/db';
import { and, eq, like } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { openPool } from '../../../test/support/integration-database';
import { holdOutboxSuiteLock } from '../../../test/support/outbox-suite-lock';
import { FakeClock } from '../../common/clock/fake-clock';
import type { RunProfile } from '../../config/run-profiles';
import type { ForgeDatabase } from '../../database/database.types';
import { OutboxWriter } from '../outbox/outbox-writer';
import { MaintenanceScheduler } from './maintenance.scheduler';
import {
  DEFAULT_SANDBOX_TIMINGS,
  MAINTENANCE_JOBS,
  MAINTENANCE_LOCK,
  type MaintenanceJob,
} from './sandbox.constants';

/** Probed once per run by `test/global-setup.ts`, which also owns the CI-must-not-skip rule. */
const reachable = inject('postgresReachable');
/** Two: the tick's transaction and the rival process. */
const pool = reachable ? openPool(process.env.DATABASE_URL ?? '', 2) : undefined;

const LONGEST_PERIOD_MS = Math.max(...MAINTENANCE_JOBS.map(({ periodMs }) => periodMs));
/**
 * `outbox` rows are never deleted (0009's grants), so every run of this suite works in periods no
 * earlier run touched: each wall-clock second since 2026 becomes 6 000 s of fake time (past this
 * suite's periods), from 2100 on a `reconcile` boundary, plus 17 s so `floor` has something to do.
 */
const BASE = new Date(
  Math.floor(
    (Date.UTC(2100, 0, 1) + (Date.now() - Date.UTC(2026, 0, 1)) * 6_000) / LONGEST_PERIOD_MS,
  ) *
    LONGEST_PERIOD_MS +
    17_000,
);
/** Waiting on the outbox suite lock, which another relay suite may hold for minutes. */
const LOCKED_BOOT_TIMEOUT_MS = 600_000;

/**
 * Spec 014 US5, research R7, SC-010/011: the `cron` process ticks under `MAINTENANCE_LOCK` and
 * appends one `maintenance.due` per catalogue job per period. The dedupe is the outbox row, not
 * process memory — a scheduler that has never ticked before appends nothing for a period another
 * one already covered, which is the handover inside a period.
 */
describe.skipIf(!reachable)('MaintenanceScheduler', () => {
  const db: ForgeDatabase = drizzle(pool!, { schema });
  let clock: FakeClock;
  let suiteLock: { release: () => Promise<void> } | undefined;
  let build: (profiles?: readonly RunProfile[]) => MaintenanceScheduler;

  beforeAll(async () => {
    // The relay suites drain the outbox rows this suite appends: one outbox-writing suite at a time.
    suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
  }, LOCKED_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await pool?.end();
    await suiteLock?.release();
  });

  beforeEach(() => {
    // Each case starts in periods the previous case never reached.
    clock = new FakeClock(new Date(BASE));
    BASE.setTime(BASE.getTime() + 2 * LONGEST_PERIOD_MS);
    build = (profiles = ['cron']) =>
      new MaintenanceScheduler(
        db,
        new OutboxWriter(clock),
        clock,
        DEFAULT_SANDBOX_TIMINGS,
        new Set(profiles),
      );
  });

  const periodStart = (job: MaintenanceJob, at: Date): string => {
    const { periodMs } = MAINTENANCE_JOBS.find((entry) => entry.job === job)!;

    return new Date(Math.floor(at.getTime() / periodMs) * periodMs).toISOString();
  };

  /** The `maintenance.due` rows for `job` since `BASE`'s century, by aggregate id. */
  const dueRows = (job: MaintenanceJob) =>
    db
      .select({ aggregateId: outbox.aggregateId, payload: outbox.payload })
      .from(outbox)
      .where(and(eq(outbox.type, 'maintenance.due'), like(outbox.aggregateId, `${job}:%`)));

  const dueFor = async (job: MaintenanceJob, at: Date) =>
    (await dueRows(job)).filter((row) => row.aggregateId === `${job}:${periodStart(job, at)}`);

  it('appends one maintenance.due per catalogue job per period, keyed by job and period start', async () => {
    expect(await build().tick()).toBe(MAINTENANCE_JOBS.length);

    for (const { job } of MAINTENANCE_JOBS) {
      const rows = await dueFor(job, clock.now());

      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload).toEqual({ job, periodStart: periodStart(job, clock.now()) });
    }

    // `floor`, not the tick's own time: 17 s into the period, the key is the period's start.
    expect(periodStart('sandbox.sweep', clock.now())).not.toBe(clock.now().toISOString());
  });

  it('appends nothing on a second tick in the same period', async () => {
    const scheduler = build();

    await scheduler.tick();
    clock.advance(DEFAULT_SANDBOX_TIMINGS.schedulerTickMs);

    expect(await scheduler.tick()).toBe(0);
    expect(await dueFor('sandbox.sweep', clock.now())).toHaveLength(1);
  });

  /** Research R7, SC-011: the handover — the new leader has no memory, the outbox row is the memory. */
  it('appends nothing from a fresh scheduler instance in a period another instance covered', async () => {
    await build().tick();
    clock.advance(DEFAULT_SANDBOX_TIMINGS.schedulerTickMs);

    expect(await build().tick()).toBe(0);

    for (const { job } of MAINTENANCE_JOBS) {
      expect(await dueFor(job, clock.now())).toHaveLength(1);
    }
  });

  it('appends again once a job’s period has turned, and only for the jobs whose period did', async () => {
    const scheduler = build();
    const first = clock.now();

    await scheduler.tick();
    // One 60 s period on: sweep, refill, the domain check and the webhook redelivery turn; the
    // 300 s reconcile and the daily verify do not.
    clock.advance(60_000);

    expect(await scheduler.tick()).toBe(4);
    expect(await dueFor('webhook.redeliver', clock.now())).toHaveLength(1);
    expect(periodStart('webhook.redeliver', clock.now())).not.toBe(
      periodStart('webhook.redeliver', first),
    );
    expect(await dueFor('webhook.redeliver', first)).toHaveLength(1);
    expect(await dueFor('domain.check', clock.now())).toHaveLength(1);
    expect(periodStart('domain.check', clock.now())).not.toBe(periodStart('domain.check', first));
    expect(await dueFor('domain.check', first)).toHaveLength(1);
    expect(await dueFor('connector.verify', clock.now())).toHaveLength(1);
    expect(periodStart('connector.verify', clock.now())).toBe(
      periodStart('connector.verify', first),
    );
    expect(await dueFor('sandbox.sweep', clock.now())).toHaveLength(1);
    expect(await dueFor('sandbox.refill', clock.now())).toHaveLength(1);
    expect(periodStart('sandbox.reconcile', clock.now())).toBe(
      periodStart('sandbox.reconcile', first),
    );
    expect(await dueFor('sandbox.reconcile', clock.now())).toHaveLength(1);
  });

  /** Spec 013 R4's election with its own key: a second connection stands in for the other cron replica. */
  /** Spec 018 R9: the connector health sweep is a catalogue entry, once a day. */
  it('lists connector.verify once a day', () => {
    expect(MAINTENANCE_JOBS).toContainEqual({ job: 'connector.verify', periodMs: 86_400_000 });
    expect(MAINTENANCE_JOBS).toContainEqual({ job: 'connector.ops-timeout', periodMs: 300_000 });
  });

  /** Spec 020 US4: the provider-key health sweep is a catalogue entry, once a day. */
  it('lists byok.verify once a day', () => {
    expect(MAINTENANCE_JOBS).toContainEqual({ job: 'byok.verify', periodMs: 86_400_000 });
  });

  it('lists byos.verify once a day (032 T042)', () => {
    expect(MAINTENANCE_JOBS).toContainEqual({ job: 'byos.verify', periodMs: 86_400_000 });
  });

  /** Spec 027 R8: the stuck-deployment sweep is a catalogue entry, every 300 s. */
  it('lists deploy.sweep every 300 s', () => {
    expect(MAINTENANCE_JOBS).toContainEqual({ job: 'deploy.sweep', periodMs: 300_000 });
  });

  /** Spec 028: the domain check routine is a catalogue entry, every 60 s. */
  it('lists domain.check every 60 s', () => {
    expect(MAINTENANCE_JOBS).toContainEqual({ job: 'domain.check', periodMs: 60_000 });
  });

  /** Spec 029 R6: the outbound redelivery sweep is a catalogue entry, every 60 s. */
  it('lists webhook.redeliver every 60 s', () => {
    expect(MAINTENANCE_JOBS).toContainEqual({ job: 'webhook.redeliver', periodMs: 60_000 });
  });

  it('skips the tick while another process holds the maintenance lock', async () => {
    const rival = await pool!.connect();

    try {
      await rival.query('begin');
      await rival.query('select pg_advisory_xact_lock($1::bigint)', [MAINTENANCE_LOCK.toString()]);

      expect(await build().tick()).toBe(0);
      expect(await dueFor('sandbox.sweep', clock.now())).toHaveLength(0);
    } finally {
      await rival.query('rollback');
      rival.release();
    }
  });

  it('releases the lock with the transaction', async () => {
    await build().tick();

    const { rows } = await pool!.query<{ locked: boolean }>(
      'select pg_try_advisory_xact_lock($1::bigint) as locked',
      [MAINTENANCE_LOCK.toString()],
    );

    expect(rows[0]?.locked).toBe(true);
  });

  it('ticks on schedulerTickMs once bootstrapped, and stops on shutdown', async () => {
    vi.useFakeTimers();

    try {
      const scheduler = build();
      const tick = vi.spyOn(scheduler, 'tick').mockResolvedValue(0);

      scheduler.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(DEFAULT_SANDBOX_TIMINGS.schedulerTickMs * 2);

      expect(tick).toHaveBeenCalledTimes(2);

      await scheduler.onApplicationShutdown();
      await vi.advanceTimersByTimeAsync(DEFAULT_SANDBOX_TIMINGS.schedulerTickMs * 2);

      expect(tick).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([['api'], ['events'], ['agent']] as const)(
    'does not start its interval without the cron profile (%s)',
    async (profile) => {
      vi.useFakeTimers();

      try {
        const scheduler = build([profile]);
        const tick = vi.spyOn(scheduler, 'tick').mockResolvedValue(0);

        scheduler.onApplicationBootstrap();

        expect(vi.getTimerCount()).toBe(0);

        await vi.advanceTimersByTimeAsync(DEFAULT_SANDBOX_TIMINGS.schedulerTickMs * 2);

        expect(tick).not.toHaveBeenCalled();
        await scheduler.onApplicationShutdown();
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
