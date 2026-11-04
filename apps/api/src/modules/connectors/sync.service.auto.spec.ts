import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConflictError } from '../../common/errors/domain-error';
import type { TenantTransaction } from '../../database/database.types';
import type { CheckpointService } from '../checkpoints/checkpoint.service';
import type { TenantTransactionRunner } from '../../database/tenant-transaction';
import type { OutboxWriter } from '../outbox/outbox-writer';
import type { ConnectionService } from './connection.service';
import { providerUnavailable, syncConflict } from './connectors.errors';
import type { RepoLinkRecord, RepoLinkRepository } from './repo-link.repository';
import { SIDE_BRANCH } from './sync-guards';
import type { SyncRecord, SyncRepository } from './sync.repository';
import { SyncService } from './sync.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const LINKER = '66666666-6666-4666-8666-666666666666';
const CALLER = '77777777-7777-4777-8777-777777777777';
const REF = { orgId: ORG, projectId: PROJECT };
const TX = { tag: 'tx' } as unknown as TenantTransaction;
const OWN_TX = { own: true } as never;
const SHA = 'a'.repeat(40);

const ROW = {
  commits: 0,
  createdAt: new Date('2026-11-04T10:00:00.000Z'),
  finishedAt: null,
  fromSha: null,
  id: '33333333-3333-4333-8333-333333333333',
  kind: 'push',
  projectId: PROJECT,
  reason: null,
  requestedBy: LINKER,
  requestedByName: 'owner@example.test',
  startedAt: null,
  state: 'queued',
  targetBranch: null,
  toSha: null,
  trigger: 'auto',
} as unknown as SyncRecord;

/** The decisions of spec 044's request paths; `sync.service.spec.ts` holds Postgres's half. */
describe('SyncService (spec 044)', () => {
  let link: Partial<RepoLinkRecord> | undefined;
  let head: { gitSha: string; id: string } | null;
  let succeeded: Partial<SyncRecord> | undefined;
  let insert: ReturnType<typeof vi.fn>;
  let ensureUsable: ReturnType<typeof vi.fn>;
  let append: ReturnType<typeof vi.fn>;
  let commitWorkspace: ReturnType<typeof vi.fn>;
  let wake: ReturnType<typeof vi.fn>;
  let inFlight: boolean;
  let archived: boolean;
  let service: SyncService;

  beforeEach(() => {
    link = {
      autoSync: true,
      branch: 'main',
      id: 'link-1',
      lastPushedCheckpointId: 'cp-old',
      linkedBy: LINKER,
      sideBranch: null,
      state: 'linked',
    };
    head = { gitSha: SHA, id: 'cp-head' };
    succeeded = undefined;
    archived = false;
    insert = vi.fn(() => Promise.resolve(ROW));
    ensureUsable = vi.fn(() => Promise.resolve({}));
    append = vi.fn(() => Promise.resolve());
    commitWorkspace = vi.fn(() => Promise.resolve({ id: 'cp-new' }));
    wake = vi.fn(() => Promise.resolve());
    inFlight = false;

    service = new SyncService(
      {
        byId: () => Promise.resolve(ROW),
        inFlightExists: () => Promise.resolve(inFlight),
        insertQueuedIfFree: insert,
        latest: () => Promise.resolve(succeeded),
      } as unknown as SyncRepository,
      {
        forProject: () => Promise.resolve(link),
        project: () => Promise.resolve({ archived, workspaceId: 'w' }),
      } as unknown as RepoLinkRepository,
      { ensureUsable } as unknown as ConnectionService,
      {
        commitWorkspace,
        head: () => Promise.resolve(head),
        wake,
      } as unknown as CheckpointService,
      { append } as unknown as OutboxWriter,
      {
        runInTenantScope: (_scope: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(OWN_TX),
      } as unknown as TenantTransactionRunner,
    );
  });

  describe('commit: the review findings', () => {
    const commit = () => service.commit(TX, REF, CALLER, {});

    it('wakes the workspace on its own transaction, so a 503 cannot roll the wake back', async () => {
      await commit();

      expect(wake).toHaveBeenCalledWith(OWN_TX, REF);
      expect(wake.mock.invocationCallOrder[0]).toBeLessThan(
        commitWorkspace.mock.invocationCallOrder[0]!,
      );
    });

    it('auto-sync off and the slot taken: refused before committing, since nothing would carry it', async () => {
      link = { ...link, autoSync: false };
      inFlight = true;

      await expect(commit()).rejects.toMatchObject({
        extensions: { reason: 'operation-in-flight' },
      });
      expect(commitWorkspace).not.toHaveBeenCalled();
    });

    it('auto-sync on and the slot taken: commits, and the trailing edge carries it', async () => {
      inFlight = true;
      insert.mockResolvedValueOnce(undefined);

      await expect(commit()).resolves.toEqual({ checkpointId: 'cp-new', operation: null });
    });
  });

  describe('requestPush', () => {
    const request = () => service.requestPush(TX, REF, { actorId: CALLER, trigger: 'manual' });

    it('queues a row with the actor and the trigger, its event on the same transaction', async () => {
      await expect(request()).resolves.toMatchObject({ id: ROW.id, trigger: 'auto' });

      expect(insert).toHaveBeenCalledWith(TX, {
        kind: 'push',
        linkId: 'link-1',
        orgId: ORG,
        projectId: PROJECT,
        requestedBy: CALLER,
        trigger: 'manual',
      });
      expect(append).toHaveBeenCalledWith(
        TX,
        expect.objectContaining({
          payload: { orgId: ORG, projectId: PROJECT, syncOperationId: ROW.id },
          type: 'sync.requested',
        }),
      );
    });

    it('a taken slot is null and no event', async () => {
      insert.mockResolvedValueOnce(undefined);

      await expect(request()).resolves.toBeNull();
      expect(append).not.toHaveBeenCalled();
    });

    it('a head already pushed is null and no row', async () => {
      link = { ...link, lastPushedCheckpointId: 'cp-head' };

      await expect(request()).resolves.toBeNull();
      expect(insert).not.toHaveBeenCalled();
    });

    it('a head only on the side branch still pushes: the click wants the linked branch', async () => {
      link = { ...link, sideBranch: SIDE_BRANCH };
      succeeded = { targetBranch: SIDE_BRANCH, toSha: SHA };

      await expect(request()).resolves.not.toBeNull();
    });

    it('no head and no link are null', async () => {
      head = null;
      await expect(request()).resolves.toBeNull();

      head = { gitSha: SHA, id: 'cp-head' };
      link = undefined;
      await expect(request()).resolves.toBeNull();
    });
  });

  describe('requestAuto', () => {
    const request = () => service.requestAuto(TX, REF);

    it('requests as the person who linked, trigger auto', async () => {
      await expect(request()).resolves.not.toBeNull();

      expect(insert).toHaveBeenCalledWith(
        TX,
        expect.objectContaining({ requestedBy: LINKER, trigger: 'auto' }),
      );
    });

    it.each<[string, () => void]>([
      ['no link', () => (link = undefined)],
      ['a disconnected link', () => (link = { ...link, state: 'disconnected' })],
      ['auto-sync off', () => (link = { ...link, autoSync: false })],
      ['no head', () => (head = null)],
      ['the head already pushed', () => (link = { ...link, lastPushedCheckpointId: 'cp-head' })],
      ['the head of the latest success', () => (succeeded = { targetBranch: 'main', toSha: SHA })],
      ['the head of a pull', () => (succeeded = { targetBranch: null, toSha: SHA })],
      [
        'the head already on the side branch',
        () => {
          link = { ...link, sideBranch: SIDE_BRANCH };
          succeeded = { targetBranch: SIDE_BRANCH, toSha: SHA };
        },
      ],
    ])('%s is a skip', async (_name, arrange) => {
      arrange();

      await expect(request()).resolves.toBeNull();
      expect(insert).not.toHaveBeenCalled();
    });

    it('a success on a branch the link left does not count (decision 9)', async () => {
      link = { ...link, branch: 'feature' };
      succeeded = { targetBranch: 'main', toSha: SHA };

      await expect(request()).resolves.not.toBeNull();
    });

    it.each([
      ['needs-reauth', syncConflict('needs-reauth', 'reconnect')],
      ['no connection', syncConflict('not-linked', 'none')],
      ['an open circuit', providerUnavailable(30)],
    ])('%s from the gate is a skip, never a throw', async (_name, refusal) => {
      ensureUsable.mockRejectedValueOnce(refusal);

      await expect(request()).resolves.toBeNull();
      expect(insert).not.toHaveBeenCalled();
    });

    it('anything but a refusal still throws: a failed read must not pass for a skip', async () => {
      const failure = new Error('connection lost');
      ensureUsable.mockRejectedValueOnce(failure);

      await expect(request()).rejects.toBe(failure);
    });
  });

  describe('commit', () => {
    const request = (message?: string) =>
      service.commit(TX, REF, CALLER, message === undefined ? {} : { message });

    it('commits, then pushes as the caller', async () => {
      await expect(request('Ship')).resolves.toMatchObject({
        checkpointId: 'cp-new',
        operation: { id: ROW.id },
      });

      expect(commitWorkspace).toHaveBeenCalledWith(REF, CALLER, { message: 'Ship' }, TX);
      expect(insert).toHaveBeenCalledWith(
        TX,
        expect.objectContaining({ requestedBy: CALLER, trigger: 'manual' }),
      );
    });

    it('a clean tree skips the commit and still pushes', async () => {
      commitWorkspace.mockResolvedValueOnce(null);

      await expect(request()).resolves.toMatchObject({
        checkpointId: null,
        operation: { id: ROW.id },
      });
    });

    it('a taken slot keeps the commit and answers no operation, no error', async () => {
      insert.mockResolvedValueOnce(undefined);

      await expect(request()).resolves.toEqual({ checkpointId: 'cp-new', operation: null });
    });

    it('a clean tree at the pushed head is both null', async () => {
      commitWorkspace.mockResolvedValueOnce(null);
      link = { ...link, lastPushedCheckpointId: 'cp-head' };

      await expect(request()).resolves.toEqual({ checkpointId: null, operation: null });
    });

    it.each<[string, () => void, object]>([
      ['not linked', () => (link = undefined), { extensions: { reason: 'not-linked' } }],
      [
        'a disconnected link',
        () => (link = { ...link, state: 'disconnected' }),
        { extensions: { reason: 'not-linked' } },
      ],
      [
        'the gate',
        () => ensureUsable.mockRejectedValueOnce(syncConflict('needs-reauth', 'reconnect')),
        { extensions: { reason: 'needs-reauth' } },
      ],
      ['an archived project', () => (archived = true), { type: 'conflict' }],
    ])('%s refuses before the sandbox commits', async (_name, arrange, refusal) => {
      arrange();

      await expect(request()).rejects.toMatchObject(refusal);
      expect(commitWorkspace).not.toHaveBeenCalled();
    });

    it("the commit's own refusal passes through and nothing is pushed", async () => {
      const refusal = new ConflictError('A run is active.', { reason: 'run-active' });
      commitWorkspace.mockRejectedValueOnce(refusal);

      await expect(request()).rejects.toBe(refusal);
      expect(insert).not.toHaveBeenCalled();
    });
  });
});
