import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryObjectStore } from '../../common/object-store/memory-object-store';
import {
  type ObjectStorePort,
  UnconfiguredObjectStore,
} from '../../common/object-store/object-store.port';
import type { TenantTransaction } from '../../database/database.types';
import { RetryableFailure } from '../outbox/consumer';
import type { MutationContext, SandboxPort } from '../sandbox/sandbox.port';
import type { SandboxLifecycle } from '../sandbox/sandbox-lifecycle';
import type { CheckpointRepository } from './checkpoint.repository';
import { gitBundle } from './git-commands';
import { BUNDLE_PATH, mirrorKey, RepoBundler } from './repo-bundler';

const ref = { orgId: randomUUID(), projectId: randomUUID() };
const ctx: MutationContext = { leaseEpoch: 0, operationId: 'push/1' };
const tx = {} as TenantTransaction;
const HEAD = 'a'.repeat(40);

describe('RepoBundler', () => {
  let store: ObjectStorePort;
  let head: { gitSha: string } | null;
  let readiness: Awaited<ReturnType<SandboxLifecycle['ensureReady']>>;
  let exec: ReturnType<typeof vi.fn>;
  let download: ReturnType<typeof vi.fn>;

  function build(): RepoBundler {
    const repository = { head: () => Promise.resolve(head) } as unknown as CheckpointRepository;
    const port = { download, exec } as unknown as SandboxPort;
    const lifecycle = {
      ensureReady: () => Promise.resolve(readiness),
    } as unknown as SandboxLifecycle;
    return new RepoBundler(repository, port, lifecycle, store);
  }

  beforeEach(() => {
    store = new MemoryObjectStore();
    head = { gitSha: HEAD };
    readiness = { ready: true };
    exec = vi.fn(() =>
      Promise.resolve({ exitCode: 0, output: '', timedOut: false, truncated: false }),
    );
    download = vi.fn(() => Promise.resolve(Buffer.from('fresh')));
  });

  it('serves the mirror when its head label is the project head (R5, FR-021)', async () => {
    await store.put(mirrorKey(ref.orgId, ref.projectId), Buffer.from('mirrored'), { head: HEAD });

    await expect(build().current(tx, ref, ctx)).resolves.toEqual({
      body: Buffer.from('mirrored'),
      head: HEAD,
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it('bundles in the sandbox when the mirror is stale, absent or unconfigured', async () => {
    await store.put(mirrorKey(ref.orgId, ref.projectId), Buffer.from('old'), {
      head: 'b'.repeat(40),
    });
    await expect(build().current(tx, ref, ctx)).resolves.toEqual({
      body: Buffer.from('fresh'),
      head: HEAD,
    });
    expect(exec).toHaveBeenCalledWith(ref, gitBundle(), ctx);
    expect(download).toHaveBeenCalledWith(ref, BUNDLE_PATH, ctx);

    store = new MemoryObjectStore();
    await expect(build().current(tx, ref, ctx)).resolves.toMatchObject({ head: HEAD });

    store = new UnconfiguredObjectStore();
    await expect(build().current(tx, ref, ctx)).resolves.toMatchObject({ head: HEAD });
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it('a waking sandbox is retried, a git failure is terminal, no head is an error', async () => {
    readiness = { because: 'resuming', ready: false };
    await expect(build().current(tx, ref, ctx)).rejects.toMatchObject({ reason: 'timeout' });
    await expect(build().current(tx, ref, ctx)).rejects.toBeInstanceOf(RetryableFailure);

    readiness = { ready: true };
    exec.mockResolvedValueOnce({
      exitCode: 128,
      output: 'fatal',
      timedOut: false,
      truncated: false,
    });
    await expect(build().current(tx, ref, ctx)).rejects.toThrow(/failed: fatal/);

    head = null;
    await expect(build().current(tx, ref, ctx)).rejects.toThrow(/no checkpoint/);
  });
});
