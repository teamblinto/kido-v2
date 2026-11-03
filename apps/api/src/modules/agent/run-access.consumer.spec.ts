import { describe, expect, it, vi } from 'vitest';

import type { TenantTransaction } from '../../database/database.types';
import type { Envelope } from '../outbox/envelope';
import { RunAccessConsumer } from './run-access.consumer';
import type { RunStore } from './run-store';

const ORG = 'c3200000-0000-4000-8000-000000000001';
const PROJECT = 'c3200000-0000-4000-8000-000000000002';
const USER = 'c3200000-0000-4000-8000-000000000003';
const WAITING = 'c3200000-0000-4000-8000-000000000004';
const STARTED = 'c3200000-0000-4000-8000-000000000005';

function removed(): Envelope<'project.access-removed'> {
  return {
    aggregate: 'project',
    aggregateId: PROJECT,
    eventId: 'e1',
    occurredAt: '2026-09-23T10:00:00.000Z',
    orgId: ORG,
    payload: { orgId: ORG, projectId: PROJECT, userId: USER },
    traceId: null,
    type: 'project.access-removed',
  } as unknown as Envelope<'project.access-removed'>;
}

function setup() {
  const tx = {
    execute: vi.fn(() => Promise.resolve({ rows: [] })),
  } as unknown as TenantTransaction;
  const store = {
    liveRunsOf: vi.fn(() =>
      Promise.resolve([
        { id: WAITING, startedAt: null, status: 'queued' },
        { id: STARTED, startedAt: new Date(), status: 'running' },
      ]),
    ),
    requestCancel: vi.fn(() => Promise.resolve({ first: true, status: 'running' })),
    transition: vi.fn(() => Promise.resolve()),
  };
  const consumer = new RunAccessConsumer(store as unknown as RunStore);

  return { consumer, store, tx };
}

/** Spec 031 FR-019: a user who loses a project loses their runs on it. */
describe('RunAccessConsumer', () => {
  it("cancels the removed user's waiting runs directly", async () => {
    const { consumer, store, tx } = setup();

    await consumer.handle(removed(), tx);

    expect(consumer.types).toEqual(['project.access-removed']);
    expect(consumer.profile).toBe('agent');
    expect(store.transition).toHaveBeenCalledWith(tx, {
      from: 'queued',
      orgId: ORG,
      reason: 'access-lost',
      runId: WAITING,
      to: 'cancelled',
    });
  });

  it("cancels the removed user's started run cooperatively", async () => {
    const { consumer, store, tx } = setup();
    const effects = await consumer.handle(removed(), tx);

    expect(store.requestCancel).toHaveBeenCalledWith(tx, ORG, PROJECT, STARTED);
    expect(store.requestCancel).not.toHaveBeenCalledWith(tx, ORG, PROJECT, WAITING);
    expect(effects).toEqual({ cancelled: [STARTED], waiting: [WAITING] });
  });

  it("leaves other users' runs and other projects' runs alone", async () => {
    const { consumer, store, tx } = setup();

    await consumer.handle(removed(), tx);

    // The read is the filter: this user, this project, non-terminal — nothing else is touched.
    expect(store.liveRunsOf).toHaveBeenCalledWith(tx, {
      orgId: ORG,
      projectId: PROJECT,
      userId: USER,
    });
    expect(store.transition).toHaveBeenCalledTimes(1);
    expect(store.requestCancel).toHaveBeenCalledTimes(1);
  });
});
