import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { OBJECT_STORE } from '../../common/object-store/object-store.port';
import { objectStoreFor } from '../../common/object-store/r2-object-store';
import type { Environment } from '../../config/environment';
import { AuditModule } from '../audit/audit.module';
import { OutboxModule } from '../outbox/outbox.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { BUILD_SANDBOX, BuildSandboxService } from './build-sandbox.service';
import { DaytonaAdapter } from './daytona.adapter';
import { FilesService } from './files.service';
import { MaintenanceConsumer } from './maintenance.consumer';
import { MaintenanceScheduler } from './maintenance.scheduler';
import { PoolRefill } from './pool-refill';
import { PoolSettingsService } from './pool-settings';
import {
  DAYTONA_TIMINGS,
  DEFAULT_DAYTONA_TIMINGS,
  DEFAULT_SANDBOX_TIMINGS,
  SANDBOX_TIMINGS,
} from './sandbox.constants';
import { SANDBOX_PORT } from './sandbox.port';
import { SandboxService } from './sandbox.service';
import { SandboxOpsConsumer } from './sandbox-ops.consumer';
import { SandboxProjectConsumer } from './sandbox-project.consumer';
import { SandboxClaim } from './sandbox-claim';
import { SANDBOX_LIFECYCLE, SandboxLifecycleService } from './sandbox-lifecycle';
import { SandboxReconciler } from './sandbox-reconciler';
import { SandboxSweep } from './sandbox-sweep';
import { DEFAULT_TEMPLATES_DIR, TEMPLATES_DIR, TemplateCatalogue } from './template-catalogue';
import { TemplatePublisher } from './template-publisher';
import { TemplateVersions } from './template-versions';
import { FilesController } from './controllers/files.controller';
import { TemplatesController } from './controllers/templates.controller';

/**
 * The project's sandbox behind one port (spec 010). `TenancyModule` for `ProjectService` — the
 * liveness check on every call — and `AuditModule` for the registration's trail; `TenantContext`,
 * `TenantTransactionRunner`, `ConfigService` and `CLOCK` arrive from the global modules. No
 * guard of its own: `TemplatesController` (spec 015, tenant-blind like `models`) and
 * `FilesController` (spec 022, `@ResourceOrg` + `project:read`, over `FilesService`) both ride the
 * global guard chain untouched. `SANDBOX_PORT`, `SANDBOX_LIFECYCLE` and `SANDBOX_TIMINGS` (spec 014) are the
 * exports 011 consumes — the port, the lifecycle and the run-wait timings, never the service or a
 * Daytona type. `DaytonaAdapter` and `TemplateCatalogue` leave for one consumer, the preview route
 * broker (spec 017 contract § 9): the read-only `previewOrigin` and the manifest's `devPort`.
 * `OutboxModule`
 * for the ops the lifecycle appends and the `maintenance.due` the scheduler appends; its consumers are ordinary providers here — `QueueRegistry`
 * discovers them. `TemplateCatalogue`, `TemplateVersions` and `TemplatePublisher` (spec 015) are
 * ordinary providers; the catalogue reads `apps/api/templates` at construction, so a wrong
 * directory refuses boot, and the publisher is driven by `scripts/template-publish.ts` only.
 * `BUILD_SANDBOX` (spec 027 R2) is `deploy`'s row-less build sandbox over the same adapter and
 * versions, so neither leaves the module for it.
 */
@Module({
  controllers: [TemplatesController, FilesController],
  exports: [
    BUILD_SANDBOX,
    SANDBOX_PORT,
    SANDBOX_LIFECYCLE,
    SANDBOX_TIMINGS,
    DaytonaAdapter,
    TemplateCatalogue,
    // Spec 041: the agent home is created from the `agent-home` system template's current version.
    TemplateVersions,
  ],
  imports: [AuditModule, OutboxModule, TenancyModule],
  providers: [
    { provide: DAYTONA_TIMINGS, useValue: DEFAULT_DAYTONA_TIMINGS },
    { provide: SANDBOX_TIMINGS, useValue: DEFAULT_SANDBOX_TIMINGS },
    // Bound here (contract § 1) so a suite can `overrideProvider` it at a fixture directory.
    { provide: TEMPLATES_DIR, useValue: DEFAULT_TEMPLATES_DIR },
    BuildSandboxService,
    DaytonaAdapter,
    FilesService,
    MaintenanceConsumer,
    MaintenanceScheduler,
    PoolSettingsService,
    PoolRefill,
    SandboxService,
    SandboxOpsConsumer,
    SandboxProjectConsumer,
    SandboxClaim,
    SandboxLifecycleService,
    SandboxReconciler,
    SandboxSweep,
    TemplateCatalogue,
    TemplatePublisher,
    TemplateVersions,
    { provide: SANDBOX_PORT, useExisting: SandboxService },
    { provide: SANDBOX_LIFECYCLE, useExisting: SandboxLifecycleService },
    { provide: BUILD_SANDBOX, useExisting: BuildSandboxService },
    // The repos bucket, read by `SandboxOpsConsumer` to restore a replaced sandbox's workspace.
    {
      inject: [ConfigService],
      provide: OBJECT_STORE,
      useFactory: (config: ConfigService<Environment, true>) => objectStoreFor(config, 'repos'),
    },
  ],
})
export class SandboxModule {}
