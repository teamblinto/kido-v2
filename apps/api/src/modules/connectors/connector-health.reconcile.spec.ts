import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeClock } from '../../common/clock/fake-clock';
import type { ForgeDatabase, TenantTransaction } from '../../database/database.types';
import type { TenantTransactionRunner } from '../../database/tenant-transaction';
import type { Envelope } from '../outbox/envelope';
import type { ConnectionRepository } from './connection.repository';
import type { ConnectionService } from './connection.service';
import {
  ConnectorHealthConsumer,
  STALE_SYNC_MS,
  SYNC_RETRY_SPACING_MS,
} from './connector-health.consumer';
import type { OperationRepository } from './operation.repository';
import type { OperationService } from './operation.service';
import type { RepoLinkRepository } from './repo-link.repository';
import type { ResourceRepository } from './resource.repository';
import type { SyncRepository } from './sync.repository';
import type { SyncService } from './sync.service';

const NOW = new Date('2026-11-04T10:00:00.000Z');
const TX = { tag: 'tx' } as unknown as TenantTransaction;

/** Spec 044 decision 11, with the rows stubbed: what the tick closes, re-asks and leaves alone. */
describe('ConnectorHealthConsumer (connector.sync-reconcile)', () => {
  let tenants: { id: string }[];
  let stale: Record<string, { id: string }[]>;
  let linksOf: Record<string, { id: string; projectId: string }[]>;
  let latest: Record<string, object | undefined>;
  let markDone: ReturnType<typeof vi.fn>;
  let requestAuto: ReturnType<typeof vi.fn>;
  let staleQueued: ReturnType<typeof vi.fn>;
  let staleRunning: ReturnType<typeof vi.fn>;
  let consumer: ConnectorHealthConsumer;

  beforeEach(() => {
    tenants = [{ id: 'org-a' }];
    stale = {};
    linksOf = { 'org-a': [{ id: 'link-1', projectId: 'project-1' }] };
    latest = {};
    markDone = vi.fn(() => Promise.resolve(1));
    requestAuto = vi.fn(() => Promise.resolve({ id: 'op' }));
    staleQueued = vi.fn(() => Promise.resolve([]));
    staleRunning = vi.fn((_tx: unknown, orgId: string) => Promise.resolve(stale[orgId] ?? []));

    const db = {
      select: () => ({ from: () => ({ where: () => Promise.resolve(tenants) }) }),
    } as unknown as ForgeDatabase;
    const transactions = {
      runInTenantTransaction: (_org: string, fn: (tx: TenantTransaction) => Promise<unknown>) =>
        fn(TX),
    } as unknown as TenantTransactionRunner;
    const operations = {
      latest: (_tx: unknown, _ref: unknown, id: string) => Promise.resolve(latest[id]),
      markDone,
      staleQueued,
      staleRunning,
    } as unknown as SyncRepository;
    const links = {
      autoSyncLinks: (_tx: unknown, orgId: string) => Promise.resolve(linksOf[orgId] ?? []),
    } as unknown as RepoLinkRepository;

    consumer = new ConnectorHealthConsumer(
      db,
      transactions,
      {} as ConnectionService,
      operations,
      new FakeClock(NOW),
      {} as ForgeDatabase,
      {} as OperationRepository,
      {} as OperationService,
      {} as ResourceRepository,
      {} as ConnectionRepository,
      null,
      links,
      { requestAuto } as unknown as SyncService,
    );
  });

  it('owns the job', async () => {
    const event = {
      payload: { job: 'connector.sync-reconcile' },
    } as Envelope<'maintenance.due'>;

    await expect(consumer.handle(event)).resolves.toBe('connector.sync-reconcile');
    await consumer.effect(event, 'connector.sync-reconcile');
    expect(requestAuto).toHaveBeenCalledOnce();
  });

  it('closes running rows past thirty minutes as timed-out, before it looks at the links', async () => {
    stale = { 'org-a': [{ id: 'op-stuck' }] };

    await expect(consumer.reconcileSync()).resolves.toEqual({ requested: 1, timedOut: 1 });

    expect(staleRunning).toHaveBeenCalledWith(TX, 'org-a', new Date(NOW.getTime() - STALE_SYNC_MS));
    expect(STALE_SYNC_MS).toBe(30 * 60_000);
    expect(markDone).toHaveBeenCalledWith(TX, 'org-a', 'op-stuck', {
      finishedAt: NOW,
      reason: 'timed-out',
      state: 'failed',
    });
    expect(markDone.mock.invocationCallOrder[0]).toBeLessThan(
      requestAuto.mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    ['no operation yet', undefined],
    ['a success', { reason: null, state: 'succeeded' }],
    ['provider-unavailable', { reason: 'provider-unavailable', state: 'failed' }],
    ['timed-out', { reason: 'timed-out', state: 'failed' }],
    ['git-failed', { reason: 'git-failed', state: 'failed' }],
  ])('%s re-requests', async (_name, row) => {
    latest = { 'link-1': row };

    await consumer.reconcileSync();

    expect(requestAuto).toHaveBeenCalledWith(TX, { orgId: 'org-a', projectId: 'project-1' });
  });

  it.each([
    ['queued', { reason: null, state: 'queued' }],
    ['running', { reason: null, state: 'running' }],
    ['remote-ahead', { reason: 'remote-ahead', state: 'failed' }],
    ['diverged', { reason: 'diverged', state: 'failed' }],
    ['branch-protected', { reason: 'branch-protected', state: 'failed' }],
    ['push-rejected', { reason: 'push-rejected', state: 'failed' }],
    ['workflow-permission', { reason: 'workflow-permission', state: 'failed' }],
    ['repo-gone', { reason: 'repo-gone', state: 'failed' }],
    ['needs-reauth', { reason: 'needs-reauth', state: 'failed' }],
  ])('%s is left for a new head', async (_name, row) => {
    latest = { 'link-1': row };

    await consumer.reconcileSync();

    expect(requestAuto).not.toHaveBeenCalled();
  });

  it('a queued row whose job was lost is closed too: it would hold the slot for ever', async () => {
    staleQueued.mockResolvedValueOnce([{ id: 'op-lost' }]);

    await expect(consumer.reconcileSync()).resolves.toMatchObject({ timedOut: 1 });

    expect(staleQueued).toHaveBeenCalledWith(TX, 'org-a', new Date(NOW.getTime() - STALE_SYNC_MS));
    expect(markDone).toHaveBeenCalledWith(
      TX,
      'org-a',
      'op-lost',
      expect.objectContaining({ reason: 'timed-out', state: 'failed' }),
    );
  });

  it('a failure waits out the spacing, so a stuck link does not fill the table', async () => {
    latest = {
      'link-1': {
        finishedAt: new Date(NOW.getTime() - SYNC_RETRY_SPACING_MS + 1),
        reason: 'git-failed',
        state: 'failed',
      },
    };

    await consumer.reconcileSync();
    expect(requestAuto).not.toHaveBeenCalled();

    latest = {
      'link-1': {
        finishedAt: new Date(NOW.getTime() - SYNC_RETRY_SPACING_MS),
        reason: 'git-failed',
        state: 'failed',
      },
    };

    await consumer.reconcileSync();
    expect(requestAuto).toHaveBeenCalledOnce();
  });

  it('a failed pull does not strand a commit that waited behind it', async () => {
    latest = { 'link-1': { kind: 'pull', reason: 'diverged', state: 'failed' } };

    await consumer.reconcileSync();

    expect(requestAuto).toHaveBeenCalledOnce();
  });

  it('a request the service declines is not counted', async () => {
    requestAuto.mockResolvedValueOnce(null);

    await expect(consumer.reconcileSync()).resolves.toEqual({ requested: 0, timedOut: 0 });
  });

  it("one organisation's failure does not stop the sweep", async () => {
    tenants = [{ id: 'org-a' }, { id: 'org-b' }];
    linksOf = { 'org-b': [{ id: 'link-2', projectId: 'project-2' }] };
    staleRunning.mockRejectedValueOnce(new Error('org-a is down'));

    await expect(consumer.reconcileSync()).resolves.toEqual({ requested: 1, timedOut: 0 });

    expect(requestAuto).toHaveBeenCalledWith(TX, { orgId: 'org-b', projectId: 'project-2' });
  });
});
