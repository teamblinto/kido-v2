import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Checkpoint } from '@repo/db';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeClock } from '../../common/clock/fake-clock';
import { MemoryObjectStore } from '../../common/object-store/memory-object-store';
import {
  type ObjectStorePort,
  UnconfiguredObjectStore,
} from '../../common/object-store/object-store.port';
import type { Environment } from '../../config/environment';
import type { TenantTransaction } from '../../database/database.types';
import type { TenantTransactionRunner } from '../../database/tenant-transaction';
import { RetryableFailure } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import { DaytonaError, SandboxGuardError } from '../sandbox/sandbox.errors';
import type { SandboxPort } from '../sandbox/sandbox.port';
import type { SandboxLifecycle } from '../sandbox/sandbox-lifecycle';
import type { CheckpointRepository } from './checkpoint.repository';
import { gitBundle } from './git-commands';
import { BUNDLE_PATH, mirrorKey, RepoBundler } from './repo-bundler';
import { RepoMirrorConsumer } from './repo-mirror.consumer';

const orgId = randomUUID();
const projectId = randomUUID();
const tx = { execute: vi.fn(() => Promise.resolve()) } as unknown as TenantTransaction;
const KEY = mirrorKey(orgId, projectId);

/** Rows in memory stand for the repository (`checkpoint.repository.spec.ts` proves the SQL). */
describe('RepoMirrorConsumer', () => {
  let rows: Checkpoint[];
  let store: ObjectStorePort;
  let memory: MemoryObjectStore;
  let readiness: Awaited<ReturnType<SandboxLifecycle['ensureReady']>>;
  let exec: ReturnType<typeof vi.fn>;
  let download: ReturnType<typeof vi.fn>;
  let deployEnv: Environment['DEPLOY_ENV'];
  let warn: ReturnType<typeof vi.spyOn>;
  /** The lock, the git steps, the PUT and the scope's end, in order (one writer per project). */
  let trace: string[];
  const clock = new FakeClock('2026-09-17T10:00:00.000Z');

  const later = (row: Checkpoint) =>
    rows.some(
      (other) =>
        other.projectId === row.projectId &&
        other.mirroredAt !== null &&
        (other.createdAt > row.createdAt ||
          (other.createdAt.getTime() === row.createdAt.getTime() && other.id > row.id)),
    );

  function build(): RepoMirrorConsumer {
    const repository = {
      byId: (_tx: unknown, org: string, id: string) =>
        Promise.resolve(rows.find((row) => row.orgId === org && row.id === id) ?? null),
      head: () => Promise.resolve([...rows].sort((a, b) => +b.createdAt - +a.createdAt)[0] ?? null),
      laterMirroredExists: (_tx: unknown, row: Checkpoint) => Promise.resolve(later(row)),
      lockProject: (_tx: unknown, project: string) => {
        trace.push(`lock:${project === projectId ? 'project' : project}`);
        return Promise.resolve();
      },
      markMirrored: vi.fn((_tx: unknown, _org: string, id: string, at: Date) => {
        const row = rows.find((r) => r.id === id);
        if (row?.mirroredAt === null) row.mirroredAt = at;
        return Promise.resolve();
      }),
    } as unknown as CheckpointRepository;
    const port = { download, exec } as unknown as SandboxPort;
    const lifecycle = {
      ensureReady: vi.fn(() => Promise.resolve(readiness)),
    } as unknown as SandboxLifecycle;
    const transactions = {
      runInTenantScope: async (
        _scope: unknown,
        fn: (tx: TenantTransaction) => Promise<unknown>,
      ) => {
        const result = await fn(tx);
        trace.push('scope-end');
        return result;
      },
      runInTenantTransaction: (_org: string, fn: (tx: TenantTransaction) => Promise<unknown>) =>
        fn(tx),
    } as unknown as TenantTransactionRunner;
    const config = {
      get: (key: string) => (key === 'DEPLOY_ENV' ? deployEnv : undefined),
    } as unknown as ConfigService<Environment, true>;

    const bundler = new RepoBundler(repository, port, lifecycle, store);
    return new RepoMirrorConsumer(repository, bundler, store, transactions, clock, config);
  }

  function checkpoint(at: string): Checkpoint {
    const row = {
      createdAt: new Date(at),
      gitSha: randomUUID().replaceAll('-', '').padEnd(40, '0'),
      id: randomUUID(),
      mirroredAt: null,
      orgId,
      projectId,
    } as Checkpoint;
    rows.push(row);
    return row;
  }

  function event(row: Checkpoint): Envelope<'checkpoint.created'> {
    return {
      aggregateId: row.id,
      eventId: randomUUID(),
      occurredAt: clock.now().toISOString(),
      orgId,
      payload: { checkpointId: row.id, orgId, projectId },
      traceId: null,
      type: 'checkpoint.created',
    } as Envelope<'checkpoint.created'>;
  }

  /** `handle` then `effect`, as the base runs them. */
  async function mirror(consumer: RepoMirrorConsumer, row: Checkpoint): Promise<void> {
    const prepared = await consumer.handle(event(row), tx);
    await consumer.effect(event(row), prepared);
  }

  beforeEach(() => {
    rows = [];
    trace = [];
    memory = new MemoryObjectStore();
    const put = memory.put.bind(memory);
    memory.put = (...args) => {
      trace.push('put');
      return put(...args);
    };
    store = memory;
    readiness = { ready: true };
    deployEnv = 'staging';
    exec = vi.fn(() => {
      trace.push('exec');
      return Promise.resolve({ exitCode: 0, output: '', timedOut: false, truncated: false });
    });
    download = vi.fn(() => Promise.resolve(Buffer.from('bundle')));
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('describes the repo.mirror queue as contracts § 5 does', () => {
    const consumer = build();
    const row = checkpoint('2026-09-17T09:00:00.000Z');
    expect(consumer).toMatchObject({
      attempts: 8,
      concurrency: 4,
      name: 'repo-mirror',
      profile: 'events',
      queue: 'repo.mirror',
      types: ['checkpoint.created'],
    });
    expect(consumer.jobId(event(row))).toBe(`${row.id}.mirror`);
  });

  it('bundles, downloads, PUTs with the head sha and marks the row (SC-005)', async () => {
    const consumer = build();
    const row = checkpoint('2026-09-17T09:00:00.000Z');
    await mirror(consumer, row);

    expect(exec).toHaveBeenCalledWith(
      { orgId, projectId },
      gitBundle(),
      expect.objectContaining({ operationId: `mirror/${row.id}` }),
    );
    expect(download).toHaveBeenCalledWith({ orgId, projectId }, BUNDLE_PATH, expect.anything());
    expect(memory.objects.get(KEY)).toEqual({
      body: Buffer.from('bundle'),
      meta: { head: row.gitSha },
    });
    expect(row.mirroredAt).toEqual(clock.now());
  });

  it('takes the project writer lock before the bundle and PUTs before the scope ends (one writer)', async () => {
    const consumer = build();
    const row = checkpoint('2026-09-17T09:00:00.000Z');
    await mirror(consumer, row);

    expect(trace).toEqual(['lock:project', 'exec', 'put', 'scope-end']);
  });

  it('a row already mirrored, or gone, is a no-op', async () => {
    const consumer = build();
    const row = checkpoint('2026-09-17T09:00:00.000Z');
    row.mirroredAt = new Date('2026-09-17T09:30:00.000Z');
    await mirror(consumer, row);
    await consumer.effect(
      event(row),
      await consumer.handle(event({ ...row, id: randomUUID() }), tx),
    );

    expect(exec).not.toHaveBeenCalled();
    expect(memory.objects.size).toBe(0);
  });

  it('two checkpoints mirrored in reverse order leave the head at the later commit (FR-019)', async () => {
    const consumer = build();
    const older = checkpoint('2026-09-17T09:00:00.000Z');
    const newer = checkpoint('2026-09-17T09:05:00.000Z');

    await mirror(consumer, newer);
    await mirror(consumer, older);

    expect(memory.objects.get(KEY)?.meta).toEqual({ head: newer.gitSha });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(older.mirroredAt).toEqual(clock.now());
  });

  it('two in-flight mirrors of one project both label the later head (FR-019)', async () => {
    const consumer = build();
    const older = checkpoint('2026-09-17T09:00:00.000Z');
    const newer = checkpoint('2026-09-17T09:05:00.000Z');

    const jobs = [await consumer.handle(event(older), tx), await consumer.handle(event(newer), tx)];
    await consumer.effect(event(newer), jobs[1]);
    await consumer.effect(event(older), jobs[0]);

    expect(memory.objects.get(KEY)?.meta).toEqual({ head: newer.gitSha });
    expect(exec).toHaveBeenCalledTimes(2);
    expect(older.mirroredAt).toEqual(clock.now());
    expect(newer.mirroredAt).toEqual(clock.now());
  });

  it('a waking sandbox, an unreachable daemon and an unreachable store are retried (SC-006)', async () => {
    const consumer = build();
    const row = checkpoint('2026-09-17T09:00:00.000Z');

    readiness = { because: 'resuming', ready: false };
    await expect(mirror(consumer, row)).rejects.toBeInstanceOf(RetryableFailure);

    readiness = { ready: true };
    exec.mockRejectedValueOnce(new DaytonaError('unreachable', 'ECONNREFUSED'));
    await expect(mirror(consumer, row)).rejects.toMatchObject({ reason: 'timeout' });

    const wire = Object.assign(new Error('socket hang up'), { $metadata: { attempts: 3 } });
    store = { put: () => Promise.reject(wire) } as unknown as ObjectStorePort;
    await expect(mirror(build(), row)).rejects.toMatchObject({ reason: 'timeout' });

    const busy = Object.assign(new Error('SlowDown'), { $metadata: { httpStatusCode: 503 } });
    store = { put: () => Promise.reject(busy) } as unknown as ObjectStorePort;
    await expect(mirror(build(), row)).rejects.toMatchObject({ reason: 'upstream-5xx' });

    expect(row.mirroredAt).toBeNull();
  });

  it('asks a sleeping sandbox to wake outside the scope that would roll the wake back', async () => {
    readiness = { because: 'resuming', ready: false };

    await expect(mirror(build(), checkpoint('2026-09-17T09:00:00.000Z'))).rejects.toBeInstanceOf(
      RetryableFailure,
    );
    expect(trace).toEqual([]);
  });

  it('a git failure, a bundle over the cap and a store 4xx are terminal', async () => {
    const consumer = build();
    const row = checkpoint('2026-09-17T09:00:00.000Z');

    exec.mockResolvedValueOnce({
      exitCode: 128,
      output: 'fatal',
      timedOut: false,
      truncated: false,
    });
    await expect(mirror(consumer, row)).rejects.toThrow(/exited|failed/);

    download.mockRejectedValueOnce(new SandboxGuardError('file-too-large', 'Over the cap.'));
    await expect(mirror(consumer, row)).rejects.toBeInstanceOf(SandboxGuardError);

    const denied = Object.assign(new Error('AccessDenied'), { $metadata: { httpStatusCode: 403 } });
    store = { put: () => Promise.reject(denied) } as unknown as ObjectStorePort;
    await expect(mirror(build(), row)).rejects.toBe(denied);

    expect(row.mirroredAt).toBeNull();
  });

  it('an unconfigured store under local is warned once and the row left unmirrored (FR-024)', async () => {
    store = new UnconfiguredObjectStore();
    const row = checkpoint('2026-09-17T09:00:00.000Z');
    deployEnv = 'local';
    await mirror(build(), row);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(row.mirroredAt).toBeNull();
  });
});
