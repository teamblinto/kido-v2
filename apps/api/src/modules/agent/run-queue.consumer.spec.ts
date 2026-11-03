import { describe, expect, it, vi } from 'vitest';

import { FakeClock } from '../../common/clock/fake-clock';
import type { ForgeDatabase, TenantTransaction } from '../../database/database.types';
import type { CheckpointService } from '../checkpoints/checkpoint.service';
import { ConsumerBase, type ConsumerJob } from '../outbox/consumer-base';
import type { Envelope } from '../outbox/envelope';
import { RunQueueConsumer } from './run-queue.consumer';
import type { RunStore } from './run-store';

const ORG = 'c3100000-0000-4000-8000-000000000001';
const PROJECT = 'c3100000-0000-4000-8000-000000000002';
const HEAD = 'c3100000-0000-4000-8000-000000000003';
const DONE = 'c3100000-0000-4000-8000-000000000004';

function finished(eventId = 'e1'): Envelope<'agent-run.finished'> {
  return {
    aggregate: 'agent-run',
    aggregateId: DONE,
    eventId,
    occurredAt: '2026-09-23T10:00:00.000Z',
    orgId: ORG,
    payload: { orgId: ORG, outcome: 'succeeded', projectId: PROJECT, runId: DONE },
    traceId: null,
    type: 'agent-run.finished',
  } as unknown as Envelope<'agent-run.finished'>;
}

function setup(state: { holder?: { id: string }; line?: { id: string }[] } = {}) {
  const trace: string[] = [];
  const tx = {
    execute: vi.fn(() => Promise.resolve({ rows: [] })),
  } as unknown as TenantTransaction;
  const store = {
    dispatch: vi.fn(() => {
      trace.push('dispatch');
      return Promise.resolve();
    }),
    holder: vi.fn(() => {
      trace.push('holder');
      return Promise.resolve(state.holder);
    }),
    line: vi.fn(() => {
      trace.push('line');
      return Promise.resolve(state.line ?? [{ id: HEAD }]);
    }),
  };
  const checkpoints = {
    lockProject: vi.fn(() => {
      trace.push('lock:project');
      return Promise.resolve();
    }),
  };
  const consumer = new RunQueueConsumer(
    store as unknown as RunStore,
    checkpoints as unknown as CheckpointService,
  );

  return { checkpoints, consumer, store, trace, tx };
}

/** Spec 031 research R2: releasing a project is dispatching the head of its line. */
describe('RunQueueConsumer', () => {
  it('dispatches the head of an unheld line on agent-run.finished', async () => {
    const { consumer, store, trace, tx } = setup();

    await consumer.handle(finished(), tx);

    expect(consumer.types).toEqual(['agent-run.finished']);
    expect(consumer.profile).toBe('agent');
    expect(trace[0]).toBe('lock:project');
    expect(store.dispatch).toHaveBeenCalledTimes(1);
    expect(store.dispatch).toHaveBeenCalledWith(tx, {
      orgId: ORG,
      projectId: PROJECT,
      runId: HEAD,
    });
  });

  it('dispatches nothing while the project is held', async () => {
    const { consumer, store, tx } = setup({ holder: { id: DONE } });

    await consumer.handle(finished(), tx);

    expect(store.dispatch).not.toHaveBeenCalled();
  });

  it('dispatches nothing for an empty line', async () => {
    const { consumer, store, tx } = setup({ line: [] });

    await consumer.handle(finished(), tx);

    expect(store.dispatch).not.toHaveBeenCalled();
  });

  it('a duplicate delivery dispatches at most once per head (idempotent on the processed row)', async () => {
    const { consumer, store, tx } = setup();
    const seen = new Set<string>();
    const db = {
      transaction: (fn: (t: unknown) => Promise<unknown>) =>
        fn({
          ...tx,
          insert: () => ({
            values: (key: { consumer: string; eventId: string }) => ({
              onConflictDoNothing: () => ({
                returning: () => {
                  const id = `${key.consumer}/${key.eventId}`;
                  const fresh = !seen.has(id);

                  seen.add(id);
                  return Promise.resolve(fresh ? [{ eventId: key.eventId }] : []);
                },
              }),
            }),
          }),
        }),
    } as unknown as ForgeDatabase;
    const base = new ConsumerBase(db, new FakeClock('2026-09-23T10:00:00.000Z'));
    const job = {
      attemptsMade: 0,
      data: finished('dup'),
      id: 'dup',
      name: 'agent-run.finished',
      opts: { attempts: 3 },
    } as unknown as ConsumerJob<'agent-run.finished'>;

    await base.processJob(consumer, job);
    await base.processJob(consumer, job);

    expect(store.dispatch).toHaveBeenCalledTimes(1);
  });
});
