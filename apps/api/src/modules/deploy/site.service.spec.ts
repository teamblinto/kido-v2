import type { ConfigService } from '@nestjs/config';
import { siteSchema } from '@repo/contracts';
import type { Deployment, ProjectSite } from '@repo/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConflictError, NotFoundError } from '../../common/errors/domain-error';
import type { Environment } from '../../config/environment';
import type { TenantTransaction } from '../../database/database.types';
import type { AuditService } from '../audit/audit.service';
import type { CheckpointService } from '../checkpoints/checkpoint.service';
import type { OutboxWriter } from '../outbox/outbox-writer';
import type { TemplateCatalogue } from '../sandbox/template-catalogue';
import type { ProjectService } from '../tenancy/services/project.service';
import type { DeploymentRepository } from './deployment.repository';
import type { SiteRepository } from './site.repository';
import { SiteService } from './site.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const A = '44444444-4444-4444-8444-444444444444';
const B = '55555555-5555-4555-8555-555555555555';
const SITE_ID = '66666666-6666-4666-8666-666666666666';
const LABEL = 'shop-a1b2c3d4';
const DOMAIN = 'forge-sites.example';
const NOW = new Date('2026-09-22T12:00:00.000Z');

const ref = { orgId: ORG, projectId: PROJECT };

function deployment(id: string, state: Deployment['state'] = 'succeeded'): Deployment {
  return { id, orgId: ORG, projectId: PROJECT, state } as Deployment;
}

function site(overrides: Partial<ProjectSite> = {}): ProjectSite {
  return {
    createdAt: NOW,
    currentDeploymentId: B,
    id: SITE_ID,
    offlineAt: null,
    orgId: ORG,
    projectId: PROJECT,
    siteLabel: LABEL,
    updatedAt: NOW,
    updatedBy: USER,
    ...overrides,
  };
}

/**
 * T059 (release) and T088 (offline). The pointer writes are one transaction with their audit row
 * and event: every write goes through the caller's `tx`, after the project writer lock go-live
 * takes. Refusals are decided before anything is written. Collaborators are doubles; the pointer
 * SQL itself is `site.repository.spec.ts`'s.
 */
describe('SiteService', () => {
  const tx = { marker: 'the-request-transaction' } as unknown as TenantTransaction;

  let order: string[];
  let sites: {
    byProject: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
    setOffline: ReturnType<typeof vi.fn>;
  };
  let deployments: {
    byId: ReturnType<typeof vi.fn>;
    insertQueued: ReturnType<typeof vi.fn>;
  };
  let projects: { deployTarget: ReturnType<typeof vi.fn> };
  let checkpoints: { lockProject: ReturnType<typeof vi.fn> };
  let catalogue: { get: ReturnType<typeof vi.fn> };
  let outbox: { append: ReturnType<typeof vi.fn> };
  let audit: { record: ReturnType<typeof vi.fn> };
  let service: SiteService;

  beforeEach(() => {
    order = [];
    const track =
      <T>(name: string, value?: T) =>
      (...args: unknown[]) => {
        order.push(name);
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown)(...args)
          : Promise.resolve(value);
      };

    let stored: ProjectSite | undefined = site();
    sites = {
      byProject: vi.fn().mockImplementation(track('byProject', () => Promise.resolve(stored))),
      release: vi.fn().mockImplementation(
        track('release', (_tx: unknown, pointer: { deploymentId: string }) => {
          if (stored === undefined) return Promise.resolve(undefined);
          stored = { ...stored, currentDeploymentId: pointer.deploymentId, offlineAt: null };
          return Promise.resolve(stored);
        }),
      ),
      setOffline: vi.fn().mockImplementation(
        track('setOffline', () => {
          if (stored === undefined) return Promise.resolve(undefined);
          // The repository stamps the database's `now()`; the service passes no time.
          stored = { ...stored, offlineAt: NOW };
          return Promise.resolve(stored);
        }),
      ),
    };
    (sites as unknown as { set: (row: ProjectSite | undefined) => void }).set = (row) => {
      stored = row;
    };
    deployments = {
      byId: vi
        .fn()
        .mockImplementation(
          track('byId', (_tx: unknown, _org: string, _project: string, id: string) =>
            Promise.resolve(id === A || id === B ? deployment(id) : undefined),
          ),
        ),
      insertQueued: vi.fn(),
    };
    projects = {
      deployTarget: vi.fn().mockImplementation(
        track('deployTarget', {
          archived: false,
          name: 'Shop',
          previewLabel: 'a'.repeat(32),
          runSource: { runConfig: null, template: 'vite-react' },
          template: 'vite-react',
        }),
      ),
    };
    checkpoints = { lockProject: vi.fn().mockImplementation(track('lock', undefined)) };
    catalogue = {
      get: vi.fn().mockImplementation((id: string) => ({
        id,
        manifest: id === 'node-api' ? {} : { build: { command: 'npm run build', output: 'dist' } },
      })),
    };
    outbox = { append: vi.fn().mockImplementation(track('outbox', { eventId: 'e' })) };
    audit = { record: vi.fn().mockImplementation(track('audit', undefined)) };

    service = new SiteService(
      sites as unknown as SiteRepository,
      deployments as unknown as DeploymentRepository,
      projects as unknown as ProjectService,
      checkpoints as unknown as CheckpointService,
      catalogue as unknown as TemplateCatalogue,
      outbox as unknown as OutboxWriter,
      audit as unknown as AuditService,
      { get: () => DOMAIN } as unknown as ConfigService<Environment, true>,
    );
  });

  function setStored(row: ProjectSite | undefined): void {
    (sites as unknown as { set: (row: ProjectSite | undefined) => void }).set(row);
  }

  function nothingWritten(): void {
    expect(sites.release).not.toHaveBeenCalled();
    expect(sites.setOffline).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  }

  async function refusal(promise: Promise<unknown>): Promise<ConflictError> {
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictError);
    return error as ConflictError;
  }

  describe('read', () => {
    it('answers the url from site_label and SITE_DOMAIN, the pointer, offline and deployable', async () => {
      setStored(site({ offlineAt: NOW }));

      const read = await service.read(tx, ref);

      expect(siteSchema.parse(read)).toEqual(read);
      expect(read).toEqual({
        currentDeploymentId: B,
        deployable: true,
        offline: true,
        url: `https://${LABEL}.${DOMAIN}`,
      });
      expect(projects.deployTarget).toHaveBeenCalledWith(tx, ref);
    });

    it('answers the never-deployed shape, with deployable from the template', async () => {
      setStored(undefined);
      projects.deployTarget.mockResolvedValue({
        archived: false,
        runSource: { runConfig: null, template: 'node-api' },
        template: 'node-api',
      });

      expect(await service.read(tx, ref)).toEqual({
        currentDeploymentId: null,
        deployable: false,
        offline: false,
        url: null,
      });
    });

    it('is 404 for an unknown project', async () => {
      projects.deployTarget.mockRejectedValue(new NotFoundError('No such project.'));

      await expect(service.read(tx, ref)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('release', () => {
    it('makes a succeeded deployment current and clears offline_at, under the writer lock', async () => {
      setStored(site({ currentDeploymentId: B, offlineAt: NOW }));

      const released = await service.release(tx, ref, USER, A);

      expect(released).toEqual({
        currentDeploymentId: A,
        deployable: true,
        offline: false,
        url: `https://${LABEL}.${DOMAIN}`,
      });
      expect(checkpoints.lockProject).toHaveBeenCalledWith(tx, ref);
      expect(order[0]).toBe('lock');
      expect(sites.release).toHaveBeenCalledWith(tx, {
        deploymentId: A,
        orgId: ORG,
        projectId: PROJECT,
        updatedBy: USER,
      });
    });

    it('writes the audit row and site.released on the same transaction as the pointer', async () => {
      await service.release(tx, ref, USER, A);

      expect(audit.record).toHaveBeenCalledWith(tx, {
        action: 'site.released',
        actorId: USER,
        metadata: { deploymentId: A, projectId: PROJECT },
        orgId: ORG,
        target: PROJECT,
      });
      expect(outbox.append).toHaveBeenCalledWith(tx, {
        aggregateId: PROJECT,
        orgId: ORG,
        payload: { deploymentId: A, orgId: ORG, projectId: PROJECT },
        type: 'site.released',
      });
      expect(order.indexOf('release')).toBeLessThan(order.indexOf('audit'));
      expect(order.indexOf('release')).toBeLessThan(order.indexOf('outbox'));
    });

    it('adds no deployments row and queues no build', async () => {
      await service.release(tx, ref, USER, A);

      expect(deployments.insertQueued).not.toHaveBeenCalled();
      expect(outbox.append).toHaveBeenCalledTimes(1);
      expect(outbox.append.mock.calls[0]![1]).toMatchObject({ type: 'site.released' });
    });

    it.each(['failed', 'cancelled', 'queued', 'building', 'uploading'] as const)(
      'refuses a %s deployment as not-releasable',
      async (state) => {
        deployments.byId.mockResolvedValue(deployment(A, state));

        const error = await refusal(service.release(tx, ref, USER, A));

        expect(error.extensions).toMatchObject({ reason: 'not-releasable' });
        nothingWritten();
      },
    );

    it("is 404 for another project's deployment (the scoped read finds none)", async () => {
      const other = '77777777-7777-4777-8777-777777777777';

      await expect(service.release(tx, ref, USER, other)).rejects.toBeInstanceOf(NotFoundError);
      expect(deployments.byId).toHaveBeenCalledWith(tx, ORG, PROJECT, other);
      nothingWritten();
    });

    it('refuses an archived project as project-archived', async () => {
      projects.deployTarget.mockResolvedValue({
        archived: true,
        runSource: { runConfig: null, template: 'vite-react' },
        template: 'vite-react',
      });

      const error = await refusal(service.release(tx, ref, USER, A));

      expect(error.extensions).toMatchObject({ reason: 'project-archived' });
      nothingWritten();
    });

    it('is 404 for an unknown project', async () => {
      projects.deployTarget.mockRejectedValue(new NotFoundError('No such project.'));

      await expect(service.release(tx, ref, USER, A)).rejects.toBeInstanceOf(NotFoundError);
      nothingWritten();
    });

    it('repeating the same release is a no-op answering the same body', async () => {
      const first = await service.release(tx, ref, USER, A);
      sites.release.mockClear();
      audit.record.mockClear();
      outbox.append.mockClear();

      const again = await service.release(tx, ref, USER, A);

      expect(again).toEqual(first);
      nothingWritten();
    });

    it('releasing the current deployment of an offline site brings it back', async () => {
      setStored(site({ currentDeploymentId: A, offlineAt: NOW }));

      const released = await service.release(tx, ref, USER, A);

      expect(released.offline).toBe(false);
      expect(sites.release).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledTimes(1);
    });
  });

  describe('offline', () => {
    it('sets offline_at under the writer lock and keeps the pointer and label', async () => {
      const answer = await service.offline(tx, ref, USER);

      expect(answer).toEqual({
        currentDeploymentId: B,
        deployable: true,
        offline: true,
        url: `https://${LABEL}.${DOMAIN}`,
      });
      expect(order[0]).toBe('lock');
      expect(sites.setOffline).toHaveBeenCalledWith(tx, {
        orgId: ORG,
        projectId: PROJECT,
        updatedBy: USER,
      });
    });

    it('writes the audit row and site.offline on the same transaction as the pointer', async () => {
      await service.offline(tx, ref, USER);

      expect(audit.record).toHaveBeenCalledWith(tx, {
        action: 'site.offline',
        actorId: USER,
        metadata: { projectId: PROJECT },
        orgId: ORG,
        target: PROJECT,
      });
      expect(outbox.append).toHaveBeenCalledWith(tx, {
        aggregateId: PROJECT,
        orgId: ORG,
        payload: { orgId: ORG, projectId: PROJECT },
        type: 'site.offline',
      });
      expect(order.indexOf('setOffline')).toBeLessThan(order.indexOf('audit'));
    });

    it('is idempotent: a second offline writes nothing and answers the same body', async () => {
      const first = await service.offline(tx, ref, USER);
      sites.setOffline.mockClear();
      audit.record.mockClear();
      outbox.append.mockClear();

      expect(await service.offline(tx, ref, USER)).toEqual(first);
      nothingWritten();
    });

    it('refuses a project with no site row as never-deployed', async () => {
      setStored(undefined);

      const error = await refusal(service.offline(tx, ref, USER));

      expect(error.extensions).toMatchObject({ reason: 'never-deployed' });
      nothingWritten();
    });

    it('is 404 for an unknown project', async () => {
      projects.deployTarget.mockRejectedValue(new NotFoundError('No such project.'));

      await expect(service.offline(tx, ref, USER)).rejects.toBeInstanceOf(NotFoundError);
      nothingWritten();
    });

    it('a later release clears offline_at and keeps site_label', async () => {
      await service.offline(tx, ref, USER);

      const released = await service.release(tx, ref, USER, A);

      expect(released).toEqual({
        currentDeploymentId: A,
        deployable: true,
        offline: false,
        url: `https://${LABEL}.${DOMAIN}`,
      });
    });
  });
});
