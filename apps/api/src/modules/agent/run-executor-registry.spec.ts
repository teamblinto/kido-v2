import { describe, expect, it, vi } from 'vitest';

import type { TenantTransaction } from '../../database/database.types';
import { LOCAL_AGENT_UNAVAILABLE, RunExecutorRegistry } from './run-executor-registry';
import type { ExecutionContext } from './run-executor.port';

const ORG = 'b0400000-0000-4000-8000-0000000000c1';
const RUN = 'b0400000-0000-4000-8000-000000000001';

/** A transaction whose one query answers `rows`: the `local_agent_runs` lookup. */
function tx(rows: unknown[]): TenantTransaction {
  const where = vi.fn(() => Promise.resolve(rows));
  return { select: () => ({ from: () => ({ where }) }) } as unknown as TenantTransaction;
}

const local = { admitSubscription: vi.fn(), execute: vi.fn(), release: vi.fn() };

/** Spec 040 § 3 decision 4: a local run never reaches the default (cloud) executor. */
describe('RunExecutorRegistry', () => {
  it('answers undefined (the default executor) for a run with no local target', async () => {
    const registry = new RunExecutorRegistry();
    registry.register(local);

    await expect(registry.select(tx([]), ORG, RUN)).resolves.toBeUndefined();
  });

  it('routes a local run to the registered local executor', async () => {
    const registry = new RunExecutorRegistry();
    registry.register(local);

    await expect(registry.select(tx([{ runId: RUN }]), ORG, RUN)).resolves.toBe(local);
  });

  it('reads a local run’s tool mode, and none for a cloud run (spec 041)', async () => {
    const registry = new RunExecutorRegistry();

    await expect(registry.toolMode(tx([{ toolMode: 'sandbox' }]), ORG, RUN)).resolves.toBe(
      'sandbox',
    );
    await expect(registry.toolMode(tx([]), ORG, RUN)).resolves.toBeUndefined();
  });

  it('knows a local run without the executor registered, and fails it rather than fall back', async () => {
    const registry = new RunExecutorRegistry();

    await expect(registry.isLocal(tx([{ runId: RUN }]), ORG, RUN)).resolves.toBe(true);
    await expect(registry.select(tx([{ runId: RUN }]), ORG, RUN)).resolves.toBe(
      LOCAL_AGENT_UNAVAILABLE,
    );
    await expect(LOCAL_AGENT_UNAVAILABLE.execute({} as ExecutionContext)).resolves.toMatchObject({
      failureClass: 'executor',
      kind: 'failed',
      reason: expect.stringContaining('not enabled') as string,
    });
  });
});
