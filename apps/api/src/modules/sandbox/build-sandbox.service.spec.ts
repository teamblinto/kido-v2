import type { ConfigService } from '@nestjs/config';
import type { TemplateVersion } from '@repo/db';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { FakeClock } from '../../common/clock/fake-clock';
import type { Environment } from '../../config/environment';
import { type FakeDaytona, startFakeDaytona } from '../../../test/support/fake-daytona';
import { BuildSandboxError, BuildSandboxService } from './build-sandbox.service';
import { DaytonaAdapter } from './daytona.adapter';
import {
  DEFAULT_DAYTONA_TIMINGS,
  DEFAULT_SANDBOX_TIMINGS,
  type SandboxTimings,
} from './sandbox.constants';
import { DaytonaError } from './sandbox.errors';
import type { TemplateVersions } from './template-versions';

const OWNER = 'forge-test';
const TEMPLATE = 'vite-react';
const SNAPSHOT = 'forge-vite-react-abc123';
const DEPLOYMENT = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000';
const BUILD_ID = 'sandbox-build-1';
const ROOT = '/home/daytona';
/** Milliseconds: the poll spins, and the budget is near enough for the never-starts case. */
const TIMINGS: SandboxTimings = { ...DEFAULT_SANDBOX_TIMINGS, readyBudgetMs: 200, readyPollMs: 1 };

type Fake = { [K in keyof DaytonaAdapter]: Mock };

const config = { get: () => OWNER } as unknown as ConfigService<Environment, true>;

/** The adapter doubles: the sandbox answers `creating` once, then `started`. */
function fakeDaytona(states: string[] = ['creating', 'started']): Fake {
  return {
    create: vi.fn(() =>
      Promise.resolve({ id: BUILD_ID, state: 'creating', toolboxProxyUrl: 'http://x' }),
    ),
    describe: vi.fn(() => Promise.resolve({ id: BUILD_ID, state: states.shift() ?? 'started' })),
    download: vi.fn(() => Promise.resolve(Buffer.from('archive'))),
    execute: vi.fn(() => Promise.resolve({ exitCode: 0, result: 'ok\n', timedOut: false })),
    info: vi.fn(() => Promise.resolve({ isDir: false, name: 'forge-out.tar', size: 7 })),
    remove: vi.fn(() => Promise.resolve()),
    upload: vi.fn(() => Promise.resolve()),
    workDir: vi.fn(() => Promise.resolve(ROOT)),
  } as unknown as Fake;
}

function versionsWith(row: Partial<TemplateVersion> | null): { current: Mock } {
  return {
    current: vi.fn(() =>
      Promise.resolve(row === null ? null : { snapshot: SNAPSHOT, template: TEMPLATE, ...row }),
    ),
  };
}

describe('BuildSandboxService', () => {
  let daytona: Fake;
  let versions: { current: Mock };
  let service: BuildSandboxService;

  const build = (fake: Fake = daytona) =>
    new BuildSandboxService(
      fake as unknown as DaytonaAdapter,
      versions as unknown as TemplateVersions,
      TIMINGS,
      config,
    );

  beforeEach(() => {
    daytona = fakeDaytona();
    versions = versionsWith({});
    service = build();
  });

  describe('create', () => {
    it('creates from TemplateVersions.current(template).snapshot, labelled build/owner/template/deployment', async () => {
      const handle = await service.create(TEMPLATE, DEPLOYMENT);

      expect(versions.current).toHaveBeenCalledWith(TEMPLATE);
      expect(daytona.create).toHaveBeenCalledExactlyOnceWith({
        labels: {
          'forge.deployment': DEPLOYMENT,
          'forge.kind': 'build',
          'forge.owner': OWNER,
          'forge.template': TEMPLATE,
        },
        snapshot: SNAPSHOT,
      });
      expect(handle).toEqual({ id: BUILD_ID, snapshot: SNAPSHOT, workDir: ROOT });
    });

    it('polls describe until the sandbox is started before answering', async () => {
      daytona = fakeDaytona(['creating', 'creating', 'creating', 'started']);
      service = build();

      await service.create(TEMPLATE, DEPLOYMENT);

      expect(daytona.describe).toHaveBeenCalledTimes(4);
      expect(daytona.workDir).toHaveBeenCalledAfter(daytona.describe);
    });

    it('refuses not-published when the template has no current ready version, creating nothing', async () => {
      versions = versionsWith(null);
      service = build();

      await expect(service.create(TEMPLATE, DEPLOYMENT)).rejects.toMatchObject({
        kind: 'not-published',
      });
      expect(daytona.create).not.toHaveBeenCalled();
    });

    it('refuses not-started and removes the sandbox when it errors or never starts in the budget', async () => {
      daytona = fakeDaytona(['creating', 'error']);
      service = build();
      await expect(service.create(TEMPLATE, DEPLOYMENT)).rejects.toMatchObject({
        kind: 'not-started',
      });
      expect(daytona.remove).toHaveBeenCalledWith(BUILD_ID);

      daytona = fakeDaytona(Array.from({ length: 100_000 }, () => 'creating'));
      service = build();
      await expect(service.create(TEMPLATE, DEPLOYMENT)).rejects.toBeInstanceOf(BuildSandboxError);
      expect(daytona.remove).toHaveBeenCalledWith(BUILD_ID);
    });

    it('uploads nothing and runs nothing: no callback token, no supervisor (FR-022)', async () => {
      await service.create(TEMPLATE, DEPLOYMENT);

      expect(daytona.upload).not.toHaveBeenCalled();
      expect(daytona.execute).not.toHaveBeenCalled();
    });
  });

  describe('run', () => {
    it('passes the timeout in whole seconds, rounded up, from the work dir', async () => {
      const handle = await service.create(TEMPLATE, DEPLOYMENT);

      await expect(service.run(handle, 'npm ci', 90_500)).resolves.toEqual({
        exitCode: 0,
        result: 'ok\n',
        timedOut: false,
      });
      expect(daytona.execute).toHaveBeenCalledExactlyOnceWith(BUILD_ID, {
        command: 'npm ci',
        cwd: ROOT,
        timeoutSeconds: 91,
      });
    });

    it('answers a timeout as the outcome, not a throw, and never asks for less than a second', async () => {
      daytona.execute.mockResolvedValue({ timedOut: true });
      const handle = await service.create(TEMPLATE, DEPLOYMENT);

      await expect(service.run(handle, 'npm run build', 10)).resolves.toEqual({ timedOut: true });
      expect(daytona.execute).toHaveBeenCalledWith(
        BUILD_ID,
        expect.objectContaining({ timeoutSeconds: 1 }),
      );
    });
  });

  describe('put', () => {
    it('uploads the body at a path relative to the work dir', async () => {
      const handle = await service.create(TEMPLATE, DEPLOYMENT);
      const body = Buffer.from('bundle');

      await service.put(handle, '.git/forge.bundle', body);

      expect(daytona.upload).toHaveBeenCalledExactlyOnceWith(
        BUILD_ID,
        `${ROOT}/.git/forge.bundle`,
        body,
      );
    });
  });

  describe('get', () => {
    it('downloads a file within its cap, absolute paths as given', async () => {
      const handle = await service.create(TEMPLATE, DEPLOYMENT);

      await expect(service.get(handle, '/tmp/forge-out.tar', 1024)).resolves.toEqual(
        Buffer.from('archive'),
      );
      expect(daytona.info).toHaveBeenCalledWith(BUILD_ID, '/tmp/forge-out.tar');
      expect(daytona.download).toHaveBeenCalledWith(BUILD_ID, '/tmp/forge-out.tar');
    });

    it('refuses too-large over its cap without downloading', async () => {
      daytona.info.mockResolvedValue({ isDir: false, name: 'forge-out.tar', size: 1025 });
      const handle = await service.create(TEMPLATE, DEPLOYMENT);

      await expect(service.get(handle, '/tmp/forge-out.tar', 1024)).rejects.toMatchObject({
        kind: 'too-large',
      });
      expect(daytona.download).not.toHaveBeenCalled();
    });

    it('refuses too-large when the bytes outgrow the cap after the stat', async () => {
      daytona.download.mockResolvedValue(Buffer.alloc(2048));
      const handle = await service.create(TEMPLATE, DEPLOYMENT);

      await expect(service.get(handle, '/tmp/forge-out.tar', 1024)).rejects.toMatchObject({
        kind: 'too-large',
      });
    });
  });

  describe('remove', () => {
    it('removes the sandbox', async () => {
      const handle = await service.create(TEMPLATE, DEPLOYMENT);

      await service.remove(handle);

      expect(daytona.remove).toHaveBeenCalledExactlyOnceWith(BUILD_ID);
    });

    it('treats a 404 (already gone) as success', async () => {
      daytona.remove.mockRejectedValue(
        new DaytonaError('sandbox-not-found', 'Daytona has no sandbox with that id.', 404),
      );
      const handle = await service.create(TEMPLATE, DEPLOYMENT);

      await expect(service.remove(handle)).resolves.toBeUndefined();
    });

    it('propagates any other failure to the caller', async () => {
      daytona.remove.mockRejectedValue(new DaytonaError('upstream', 'Daytona failed.', 503));
      const handle = await service.create(TEMPLATE, DEPLOYMENT);

      await expect(service.remove(handle)).rejects.toBeInstanceOf(DaytonaError);
    });
  });

  /**
   * SC-012, the unit half (T100): the real adapter over the loopback fake, so the bytes on the wire
   * are what is asserted — the create body, every execute's `envs`, and every upload.
   */
  describe('on the wire (SC-012)', () => {
    let fake: FakeDaytona;

    beforeEach(async () => {
      fake = await startFakeDaytona();
    });

    afterEach(async () => {
      await fake.close();
    });

    it('passes nothing beyond LC_ALL into the build sandbox and uploads nothing but the bundle', async () => {
      const adapter = new DaytonaAdapter(
        {
          get: (key: string) =>
            ({ DAYTONA_API_KEY: fake.apiKey, DAYTONA_API_URL: fake.apiUrl })[key],
        } as unknown as ConfigService<Environment, true>,
        DEFAULT_DAYTONA_TIMINGS,
        new FakeClock('2026-09-22T10:00:00.000Z'),
      );
      // Daytona's runner catching up: every poll first settles whatever is still `creating`.
      const describe = adapter.describe.bind(adapter);
      vi.spyOn(adapter, 'describe').mockImplementation((id) => {
        fake.settle(id);
        return describe(id);
      });
      fake.onExecute(() => ({ exitCode: 0, result: '' }));
      fake.workspace.set('/tmp/forge-out.tar', { content: Buffer.from('tar'), kind: 'file' });

      const wire = new BuildSandboxService(
        adapter,
        versions as unknown as TemplateVersions,
        TIMINGS,
        config,
      );
      const handle = await wire.create(TEMPLATE, DEPLOYMENT);
      await wire.put(handle, '.git/forge.bundle', Buffer.from('bundle'));
      for (const command of ['git init -q', 'npm ci', 'npm run build']) {
        await wire.run(handle, command, 60_000);
      }
      await wire.get(handle, '/tmp/forge-out.tar', 1024);
      await wire.remove(handle);

      const creates = fake.requests.filter((r) => r.method === 'POST' && r.path === '/api/sandbox');
      expect(creates).toHaveLength(1);
      expect(JSON.parse(creates[0]!.body)).toEqual({
        autoArchiveInterval: 0,
        autoStopInterval: 0,
        labels: {
          'forge.deployment': DEPLOYMENT,
          'forge.kind': 'build',
          'forge.owner': OWNER,
          'forge.template': TEMPLATE,
        },
        snapshot: SNAPSHOT,
      });

      const executes = fake.requests.filter((r) => r.path.endsWith('/process/execute'));
      expect(executes).toHaveLength(3);
      for (const execute of executes) {
        const body = JSON.parse(execute.body) as Record<string, unknown>;
        expect(Object.keys(body).sort()).toEqual(['command', 'cwd', 'envs', 'timeout']);
        expect(body.envs).toEqual({ LC_ALL: 'C' });
      }

      const uploads = fake.requests.filter((r) => r.path.endsWith('/files/upload'));
      expect(uploads.map((r) => r.query.path)).toEqual([`${fake.workDir}/.git/forge.bundle`]);
    });
  });
});
