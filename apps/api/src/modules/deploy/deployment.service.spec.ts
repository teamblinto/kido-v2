import { deploymentSchema } from '@repo/contracts';
import type { Checkpoint, Deployment } from '@repo/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotFoundError } from '../../common/errors/domain-error';
import type { TenantTransaction } from '../../database/database.types';
import type { AuditService } from '../audit/audit.service';
import type { CheckpointService } from '../checkpoints/checkpoint.service';
import type { OutboxWriter } from '../outbox/outbox-writer';
import type { TemplateCatalogue } from '../sandbox/template-catalogue';
import type { ProjectService } from '../tenancy/services/project.service';
import { LOG_TAIL_MAX_BYTES } from './deploy.constants';
import type { DeploymentRepository } from './deployment.repository';
import { DeploymentService } from './deployment.service';
import type { SiteRepository } from './site.repository';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const HEAD = '44444444-4444-4444-8444-444444444444';
const NAMED = '55555555-5555-4555-8555-555555555555';
const DEPLOYMENT = '66666666-6666-4666-8666-666666666666';
const IN_FLIGHT = '77777777-7777-4777-8777-777777777777';

const ref = { orgId: ORG, projectId: PROJECT };

function checkpoint(id: string, projectId = PROJECT): Checkpoint {
  return { id, orgId: ORG, projectId } as Checkpoint;
}

function row(overrides: Partial<Deployment> = {}): Deployment {
  return {
    artifactSha: null,
    attempts: 0,
    checkpointId: HEAD,
    createdAt: new Date('2026-09-22T10:00:00.000Z'),
    failureReason: null,
    fileCount: null,
    finishedAt: null,
    id: DEPLOYMENT,
    leaseEpoch: 0,
    logTail: null,
    orgId: ORG,
    projectId: PROJECT,
    requestedBy: USER,
    startedAt: null,
    state: 'queued',
    target: 'forge-static',
    template: 'vite-react',
    templateDigest: null,
    templateSnapshot: null,
    totalBytes: null,
    updatedAt: new Date('2026-09-22T10:00:00.000Z'),
    uploadStartedAt: null,
    ...overrides,
  };
}

/**
 * T032 — the request's refusals are decided before anything is written, and what passes writes
 * the row, `deploy.requested` and its audit row on the caller's one transaction handle (so they
 * commit or roll back together). Collaborators are doubles; the partial unique index itself is
 * `deployment.repository.spec.ts`'s.
 */
describe('DeploymentService', () => {
  const tx = { marker: 'the-request-transaction' } as unknown as TenantTransaction;

  let deployments: {
    byId: ReturnType<typeof vi.fn>;
    inFlight: ReturnType<typeof vi.fn>;
    insertQueued: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
  };
  let sites: { byProject: ReturnType<typeof vi.fn> };
  let projects: { deployTarget: ReturnType<typeof vi.fn> };
  let checkpoints: { byId: ReturnType<typeof vi.fn>; head: ReturnType<typeof vi.fn> };
  let catalogue: { get: ReturnType<typeof vi.fn> };
  let outbox: { append: ReturnType<typeof vi.fn> };
  let audit: { record: ReturnType<typeof vi.fn> };
  let service: DeploymentService;

  beforeEach(() => {
    deployments = {
      byId: vi.fn(),
      inFlight: vi.fn().mockResolvedValue(undefined),
      insertQueued: vi
        .fn()
        .mockImplementation((_tx, draft: { checkpointId: string }) =>
          Promise.resolve(row({ checkpointId: draft.checkpointId })),
        ),
      list: vi.fn(),
    };
    sites = { byProject: vi.fn().mockResolvedValue(undefined) };
    projects = {
      deployTarget: vi.fn().mockResolvedValue({
        archived: false,
        name: 'Shop',
        previewLabel: 'a'.repeat(32),
        template: 'vite-react',
      }),
    };
    checkpoints = {
      byId: vi.fn().mockImplementation((_tx, _ref, id: string) => {
        if (id === NAMED) return Promise.resolve(checkpoint(NAMED));
        return Promise.reject(new NotFoundError('No such checkpoint.'));
      }),
      head: vi.fn().mockResolvedValue(checkpoint(HEAD)),
    };
    catalogue = {
      get: vi.fn().mockImplementation((id: string) => ({
        id,
        manifest: id === 'node-api' ? {} : { build: { command: 'npm run build', output: 'dist' } },
      })),
    };
    outbox = { append: vi.fn().mockResolvedValue({ eventId: 'e' }) };
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    service = new DeploymentService(
      deployments as unknown as DeploymentRepository,
      sites as unknown as SiteRepository,
      projects as unknown as ProjectService,
      checkpoints as unknown as CheckpointService,
      catalogue as unknown as TemplateCatalogue,
      outbox as unknown as OutboxWriter,
      audit as unknown as AuditService,
    );
  });

  function nothingWritten(): void {
    expect(deployments.insertQueued).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  }

  describe('request', () => {
    it('with no checkpointId, deploys the head checkpoint', async () => {
      const deployment = await service.request(tx, ref, USER, {});

      expect(checkpoints.head).toHaveBeenCalledWith(tx, ref);
      expect(checkpoints.byId).not.toHaveBeenCalled();
      expect(deployments.insertQueued).toHaveBeenCalledWith(tx, {
        checkpointId: HEAD,
        orgId: ORG,
        projectId: PROJECT,
        requestedBy: USER,
        template: 'vite-react',
      });
      expect(deploymentSchema.parse(deployment)).toEqual(deployment);
      expect(deployment).toMatchObject({ checkpointId: HEAD, current: false, state: 'queued' });
    });

    it('a named checkpoint of this project is deployed', async () => {
      const deployment = await service.request(tx, ref, USER, { checkpointId: NAMED });

      expect(checkpoints.byId).toHaveBeenCalledWith(tx, ref, NAMED);
      expect(checkpoints.head).not.toHaveBeenCalled();
      expect(deployment.checkpointId).toBe(NAMED);
    });

    it('a named checkpoint of another project is not-found, and nothing is written', async () => {
      await expect(
        service.request(tx, ref, USER, { checkpointId: '88888888-8888-4888-8888-888888888888' }),
      ).rejects.toMatchObject({ type: 'not-found' });
      nothingWritten();
    });

    it('a project with no checkpoint yet is not-found', async () => {
      checkpoints.head.mockResolvedValue(null);

      await expect(service.request(tx, ref, USER, {})).rejects.toMatchObject({
        type: 'not-found',
      });
      nothingWritten();
    });

    it('an unknown project is not-found', async () => {
      projects.deployTarget.mockRejectedValue(new NotFoundError('No such project.'));

      await expect(service.request(tx, ref, USER, {})).rejects.toMatchObject({
        type: 'not-found',
      });
      nothingWritten();
    });

    it('an archived project is conflict/project-archived', async () => {
      projects.deployTarget.mockResolvedValue({
        archived: true,
        name: 'Shop',
        previewLabel: 'a'.repeat(32),
        template: 'vite-react',
      });

      await expect(service.request(tx, ref, USER, {})).rejects.toMatchObject({
        extensions: { reason: 'project-archived' },
        type: 'conflict',
      });
      nothingWritten();
    });

    it('a template without build is conflict/not-deployable', async () => {
      projects.deployTarget.mockResolvedValue({
        archived: false,
        name: 'Api',
        previewLabel: 'a'.repeat(32),
        template: 'node-api',
      });

      await expect(service.request(tx, ref, USER, {})).rejects.toMatchObject({
        extensions: { reason: 'not-deployable' },
        type: 'conflict',
      });
      expect(catalogue.get).toHaveBeenCalledWith('node-api');
      nothingWritten();
    });

    it('a deployment in flight is conflict/deploy-active carrying its id', async () => {
      deployments.inFlight.mockResolvedValue(row({ id: IN_FLIGHT, state: 'building' }));

      await expect(service.request(tx, ref, USER, {})).rejects.toMatchObject({
        extensions: { deploymentId: IN_FLIGHT, reason: 'deploy-active' },
        type: 'conflict',
      });
      nothingWritten();
    });

    it('losing the race on the partial unique index is deploy-active too, naming the winner', async () => {
      deployments.inFlight
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(row({ id: IN_FLIGHT }));
      deployments.insertQueued.mockResolvedValue(undefined);

      await expect(service.request(tx, ref, USER, {})).rejects.toMatchObject({
        extensions: { deploymentId: IN_FLIGHT, reason: 'deploy-active' },
        type: 'conflict',
      });
      expect(outbox.append).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('writes the row, deploy.requested and the audit row on the same transaction', async () => {
      await service.request(tx, ref, USER, { checkpointId: NAMED });

      expect(deployments.insertQueued.mock.calls[0]![0]).toBe(tx);
      expect(outbox.append).toHaveBeenCalledTimes(1);
      expect(outbox.append.mock.calls[0]![0]).toBe(tx);
      expect(outbox.append.mock.calls[0]![1]).toEqual({
        aggregateId: DEPLOYMENT,
        orgId: ORG,
        payload: { deploymentId: DEPLOYMENT, orgId: ORG, projectId: PROJECT },
        type: 'deploy.requested',
      });
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record.mock.calls[0]![0]).toBe(tx);
      expect(audit.record.mock.calls[0]![1]).toEqual({
        action: 'deploy.requested',
        actorId: USER,
        metadata: { checkpointId: NAMED, projectId: PROJECT },
        orgId: ORG,
        target: DEPLOYMENT,
      });
      // The row lands before the event and the audit entry that name it.
      expect(deployments.insertQueued.mock.invocationCallOrder[0]).toBeLessThan(
        outbox.append.mock.invocationCallOrder[0]!,
      );
    });
  });

  describe('reads', () => {
    it('get answers the contract shape, current when the site pointer names it', async () => {
      deployments.byId.mockResolvedValue(
        row({
          artifactSha: 'f'.repeat(64),
          attempts: 1,
          fileCount: 3,
          finishedAt: new Date('2026-09-22T10:02:00.000Z'),
          startedAt: new Date('2026-09-22T10:00:05.000Z'),
          state: 'succeeded',
          totalBytes: 1234,
        }),
      );
      sites.byProject.mockResolvedValue({ currentDeploymentId: DEPLOYMENT });

      const deployment = await service.get(tx, ref, DEPLOYMENT);

      expect(deployments.byId).toHaveBeenCalledWith(tx, ORG, PROJECT, DEPLOYMENT);
      expect(deploymentSchema.parse(deployment)).toEqual(deployment);
      expect(deployment).toEqual({
        artifactSha: 'f'.repeat(64),
        attempts: 1,
        checkpointId: HEAD,
        createdAt: '2026-09-22T10:00:00.000Z',
        current: true,
        failureReason: null,
        fileCount: 3,
        finishedAt: '2026-09-22T10:02:00.000Z',
        id: DEPLOYMENT,
        requestedBy: USER,
        startedAt: '2026-09-22T10:00:05.000Z',
        state: 'succeeded',
        totalBytes: 1234,
      });
    });

    it('get of an unknown deployment (or another project’s) is not-found', async () => {
      deployments.byId.mockResolvedValue(undefined);

      await expect(service.get(tx, ref, DEPLOYMENT)).rejects.toMatchObject({ type: 'not-found' });
    });

    it('list pages through the repository and marks only the current one', async () => {
      deployments.list.mockResolvedValue({
        items: [row({ id: IN_FLIGHT }), row({ state: 'succeeded' })],
        nextCursor: 'next',
      });
      sites.byProject.mockResolvedValue({ currentDeploymentId: DEPLOYMENT });

      const page = await service.list(tx, ref, { cursor: 'c', limit: 2 });

      expect(projects.deployTarget).toHaveBeenCalledWith(tx, ref);
      expect(deployments.list).toHaveBeenCalledWith(tx, ORG, PROJECT, { cursor: 'c', limit: 2 });
      expect(page.nextCursor).toBe('next');
      expect(page.items.map((item) => [item.id, item.current])).toEqual([
        [IN_FLIGHT, false],
        [DEPLOYMENT, true],
      ]);
    });

    it('list of an unknown project is not-found', async () => {
      projects.deployTarget.mockRejectedValue(new NotFoundError('No such project.'));

      await expect(service.list(tx, ref, { limit: 20 })).rejects.toMatchObject({
        type: 'not-found',
      });
    });

    it('log is empty before the build ends, and the stored tail after', async () => {
      deployments.byId.mockResolvedValueOnce(row());
      await expect(service.log(tx, ref, DEPLOYMENT)).resolves.toEqual({
        log: '',
        truncated: false,
      });

      deployments.byId.mockResolvedValueOnce(row({ logTail: 'built in 2s\n', state: 'failed' }));
      await expect(service.log(tx, ref, DEPLOYMENT)).resolves.toEqual({
        log: 'built in 2s\n',
        truncated: false,
      });
    });

    it('log says truncated when the tail is at the 64 KiB cap', async () => {
      const full = 'x'.repeat(LOG_TAIL_MAX_BYTES);
      deployments.byId.mockResolvedValue(row({ logTail: full, state: 'failed' }));

      await expect(service.log(tx, ref, DEPLOYMENT)).resolves.toEqual({
        log: full,
        truncated: true,
      });
    });

    it('log of an unknown deployment is not-found', async () => {
      deployments.byId.mockResolvedValue(undefined);

      await expect(service.log(tx, ref, DEPLOYMENT)).rejects.toMatchObject({ type: 'not-found' });
    });
  });
});
