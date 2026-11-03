import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EventConsumer } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import { MaintenanceConsumer } from './maintenance.consumer';
import type { PoolRefill } from './pool-refill';
import { MAINTENANCE_QUEUE, type MaintenanceJob } from './sandbox.constants';
import type { SandboxReconciler } from './sandbox-reconciler';
import type { SandboxSweep } from './sandbox-sweep';

const PERIOD_START = '2026-09-14T10:05:00.000Z';

function due(job: MaintenanceJob): Envelope<'maintenance.due'> {
  return {
    aggregate: 'maintenance',
    aggregateId: `${job}:${PERIOD_START}`,
    eventId: 'c1000000-0000-4000-8000-000000000001',
    occurredAt: PERIOD_START,
    orgId: null,
    payload: { job, periodStart: PERIOD_START },
    traceId: null,
    type: 'maintenance.due',
  };
}

/**
 * Spec 014 US5, contract § 4: the `maintenance` queue's one consumer dispatches each `due` to the
 * job's callable — the sweep, the refill, the reconciler — in `effect`, with no transaction held,
 * since each drives Daytona. The three are idempotent for their period by construction, so a
 * retry re-runs them whole.
 */
describe('MaintenanceConsumer', () => {
  let sweep: { sweep: ReturnType<typeof vi.fn> };
  let refill: { refill: ReturnType<typeof vi.fn> };
  let reconciler: { reconcile: ReturnType<typeof vi.fn> };
  let consumer: MaintenanceConsumer;

  beforeEach(() => {
    sweep = { sweep: vi.fn(() => Promise.resolve({})) };
    refill = { refill: vi.fn(() => Promise.resolve()) };
    reconciler = { reconcile: vi.fn(() => Promise.resolve({})) };
    consumer = new MaintenanceConsumer(
      sweep as unknown as SandboxSweep,
      refill as unknown as PoolRefill,
      reconciler as unknown as SandboxReconciler,
    );
  });

  /** data-model.md § Queues: `maintenance`, `cron`, 2 / 3. */
  it('is an EventConsumer on the maintenance queue for the cron profile, concurrency 2, attempts 3', () => {
    expect(consumer).toBeInstanceOf(EventConsumer);
    expect(consumer).toMatchObject({
      attempts: 3,
      concurrency: 2,
      profile: 'cron',
      queue: MAINTENANCE_QUEUE,
      types: ['maintenance.due'],
    });
    expect(MAINTENANCE_QUEUE).toBe('maintenance');
  });

  /** BullMQ refuses a custom id with `:` (as `mailJobId` found) and the ISO period start has two; the outbox key keeps its colon. */
  it('keys the job by job and period start, colon-free, one id per job per period', () => {
    expect(consumer.jobId(due('sandbox.sweep'))).toBe(`sandbox.sweep.${Date.parse(PERIOD_START)}`);
    expect(consumer.jobId(due('sandbox.reconcile'))).not.toContain(':');
  });

  it.each([
    ['sandbox.sweep', () => sweep.sweep, () => [refill.refill, reconciler.reconcile]],
    ['sandbox.refill', () => refill.refill, () => [sweep.sweep, reconciler.reconcile]],
    ['sandbox.reconcile', () => reconciler.reconcile, () => [sweep.sweep, refill.refill]],
  ] as const)(
    'dispatches %s to its callable in effect, and to no other',
    async (job, ran, idle) => {
      const event = due(job);
      const prepared = await consumer.handle(event);

      expect(ran()).not.toHaveBeenCalled();

      await consumer.effect(event, prepared);

      expect(ran()).toHaveBeenCalledTimes(1);

      for (const other of idle()) {
        expect(other).not.toHaveBeenCalled();
      }
    },
  );

  /**
   * The jobs another module's consumer takes on its own queue — spec 018 R9, 020 US4, 026 R15 and
   * 027's sweep and 028's domain check — are a no-op here: no Daytona call, and no error to retry.
   */
  it.each([
    'connector.verify',
    'connector.ops-timeout',
    'byok.verify',
    'byos.verify',
    'webhook.retention',
    'deploy.sweep',
    'domain.check',
  ] as const)('leaves %s to its own consumer, calling nothing', async (job) => {
    const event = due(job);

    await expect(consumer.effect(event, await consumer.handle(event))).resolves.toBeUndefined();

    expect(sweep.sweep).not.toHaveBeenCalled();
    expect(refill.refill).not.toHaveBeenCalled();
    expect(reconciler.reconcile).not.toHaveBeenCalled();
  });

  /** An error is the job's to retry through the registry; the consumer classifies nothing. */
  it('lets a failing job propagate', async () => {
    refill.refill.mockRejectedValueOnce(new Error('daytona down'));
    const event = due('sandbox.refill');

    await expect(consumer.effect(event, await consumer.handle(event))).rejects.toThrow(
      'daytona down',
    );
  });
});
