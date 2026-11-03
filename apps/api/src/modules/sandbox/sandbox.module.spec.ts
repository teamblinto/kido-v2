import path from 'node:path';

import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { EventConsumer } from '../outbox/consumer';
import { BUILD_SANDBOX, BuildSandboxService } from './build-sandbox.service';
import { DaytonaAdapter } from './daytona.adapter';
import { MaintenanceConsumer } from './maintenance.consumer';
import { MaintenanceScheduler } from './maintenance.scheduler';

import {
  DAYTONA_TIMINGS,
  DEFAULT_DAYTONA_TIMINGS,
  DEFAULT_SANDBOX_TIMINGS,
  MAINTENANCE_QUEUE,
  SANDBOX_OPS_QUEUE,
  SANDBOX_TIMINGS,
} from './sandbox.constants';
import { SandboxModule } from './sandbox.module';
import { SANDBOX_PORT } from './sandbox.port';
import { SandboxService } from './sandbox.service';
import { SandboxOpsConsumer } from './sandbox-ops.consumer';
import { SandboxProjectConsumer } from './sandbox-project.consumer';
import { SANDBOX_LIFECYCLE, SandboxLifecycleService } from './sandbox-lifecycle';
import { DEFAULT_TEMPLATES_DIR, TEMPLATES_DIR, TemplateCatalogue } from './template-catalogue';
import { TemplatePublisher } from './template-publisher';
import { TemplateVersions } from './template-versions';
import { FilesController } from './controllers/files.controller';
import { TemplatesController } from './controllers/templates.controller';

/** Read off the module metadata, as `agent.module.spec.ts` does: the declaration is the invariant. */
describe('SandboxModule', () => {
  const providers = Reflect.getMetadata('providers', SandboxModule) as unknown[];
  const tokens = providers.map((provider) =>
    typeof provider === 'object' && provider !== null && 'provide' in provider
      ? provider.provide
      : provider,
  );

  it('exports the build sandbox (027), the port, the lifecycle, the timings, and (for the preview broker) the adapter and the catalogue, and (041) the versions', () => {
    expect(Reflect.getMetadata('exports', SandboxModule)).toEqual([
      BUILD_SANDBOX,
      SANDBOX_PORT,
      SANDBOX_LIFECYCLE,
      SANDBOX_TIMINGS,
      DaytonaAdapter,
      TemplateCatalogue,
      TemplateVersions,
    ]);
    expect(providers).toContainEqual({ provide: SANDBOX_PORT, useExisting: SandboxService });
    expect(providers).toContainEqual({
      provide: SANDBOX_LIFECYCLE,
      useExisting: SandboxLifecycleService,
    });
    expect(providers).toContainEqual({ provide: BUILD_SANDBOX, useExisting: BuildSandboxService });
  });

  it('binds the default timings under an overridable token', () => {
    expect(providers).toContainEqual({
      provide: DAYTONA_TIMINGS,
      useValue: DEFAULT_DAYTONA_TIMINGS,
    });
    expect(providers).toContainEqual({
      provide: SANDBOX_TIMINGS,
      useValue: DEFAULT_SANDBOX_TIMINGS,
    });
  });

  /** Constitution III: both controllers ride the global guard chain, which stays as it was. */
  it('registers the templates and files controllers and no guard', () => {
    expect(Reflect.getMetadata('controllers', SandboxModule)).toEqual([
      TemplatesController,
      FilesController,
    ]);
    expect(tokens).not.toContain(APP_GUARD);
    expect(tokens).not.toContain(APP_INTERCEPTOR);
  });
});

/**
 * Spec 014 data-model § Queues: the consumers are ordinary providers `QueueRegistry` discovers, and
 * each claims its queue for one profile — `sandbox.ops` for `events` (both ops consumers, so the
 * registry sees one profile on that queue), `maintenance` for `cron`; the scheduler is bound
 * beside them so the `cron` process has something to append.
 */
describe('SandboxModule queues', () => {
  const providers = Reflect.getMetadata('providers', SandboxModule) as unknown[];

  it('binds the scheduler and the three consumers', () => {
    expect(providers).toEqual(
      expect.arrayContaining([
        MaintenanceScheduler,
        MaintenanceConsumer,
        SandboxOpsConsumer,
        SandboxProjectConsumer,
      ]),
    );
  });

  it.each([
    ['SandboxOpsConsumer', SandboxOpsConsumer, SANDBOX_OPS_QUEUE, 'events', 16, 5],
    ['SandboxProjectConsumer', SandboxProjectConsumer, SANDBOX_OPS_QUEUE, 'events', 16, 5],
    ['MaintenanceConsumer', MaintenanceConsumer, MAINTENANCE_QUEUE, 'cron', 2, 3],
  ] as const)(
    '%s claims %s for the %s profile',
    (_name, consumer, queue, profile, concurrency, attempts) => {
      // The declarations are class fields, read off an instance; every injection is a stub that
      // answers `get` for the one constructor that reads its config.
      const stub = { get: () => 'stub' };
      const instance = new (consumer as unknown as new (...args: unknown[]) => EventConsumer)(
        ...Array.from({ length: consumer.length }, () => stub),
      );

      expect(instance).toBeInstanceOf(EventConsumer);
      expect(instance).toMatchObject({ attempts, concurrency, profile, queue });
    },
  );
});

/**
 * Spec 015: the catalogue and the versions table are ordinary providers, and the catalogue reads
 * its directory at construction — bind `TEMPLATES_DIR` at a wrong fixture and the module refuses
 * to boot, rather than serving a partial catalogue.
 */
describe('SandboxModule templates', () => {
  const providers = Reflect.getMetadata('providers', SandboxModule) as unknown[];
  const fixtures = path.join(__dirname, '../../../test/fixtures/templates');

  it('provides the catalogue, the versions and the publisher, with the directory bound to its default', () => {
    expect(providers).toEqual(
      expect.arrayContaining([TemplateCatalogue, TemplatePublisher, TemplateVersions]),
    );
    // Bound rather than left to the `@Optional` default, so an e2e can override it at a fixture.
    expect(providers).toContainEqual({ provide: TEMPLATES_DIR, useValue: DEFAULT_TEMPLATES_DIR });
  });

  it('resolves the catalogue from the shipped templates', async () => {
    const moduleRef = await Test.createTestingModule({ providers: [TemplateCatalogue] }).compile();
    expect(moduleRef.get(TemplateCatalogue).all()).toHaveLength(4);
  });

  it.each(['missing', 'extra'])(
    'refuses boot when the directory set is wrong (%s)',
    async (dir) => {
      await expect(
        Test.createTestingModule({
          providers: [
            TemplateCatalogue,
            { provide: TEMPLATES_DIR, useValue: path.join(fixtures, dir) },
          ],
        }).compile(),
      ).rejects.toThrow(/expected \[.*\], found \[/);
    },
  );
});
