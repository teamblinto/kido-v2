import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { objectStoreFor } from '../../common/object-store/r2-object-store';
import type { Environment } from '../../config/environment';
import { AuditModule } from '../audit/audit.module';
import { CheckpointsModule } from '../checkpoints/checkpoints.module';
import { IdentityModule } from '../identity/identity.module';
import { OutboxModule } from '../outbox/outbox.module';
import { RbacModule } from '../rbac/rbac.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { BuildDeployConsumer } from './build-deploy.consumer';
import { BuildRunner } from './build-runner';
import { DeploymentsController } from './controllers/deployments.controller';
import { SiteController } from './controllers/site.controller';
import { ARTIFACT_STORE } from './deploy.constants';
import { DeployProjectConsumer } from './deploy-project.consumer';
import { DeploySweepConsumer } from './deploy-sweep.consumer';
import { DeploymentRepository } from './deployment.repository';
import { DeploymentService } from './deployment.service';
import { CloudflareForSaasAdapter } from './domains/cloudflare-for-saas.adapter';
import { DomainsController } from './domains/controllers/domains.controller';
import { CUSTOM_HOSTNAMES } from './domains/custom-hostname.port';
import { DNS } from './domains/dns.port';
import { DomainCheckConsumer } from './domains/domain-check.consumer';
import { DomainCheckSweepConsumer } from './domains/domain-check-sweep.consumer';
import { DomainMailConsumer } from './domains/domain-mail.consumer';
import { DomainNotices } from './domains/domain-notices';
import { DomainRepository } from './domains/domain.repository';
import { DomainRecordsReader } from './domains/domain-records';
import { DomainChecker } from './domains/domain-checker';
import { DomainService } from './domains/domain.service';
import { DomainRouteService } from './domains/domain-route.service';
import { NodeDnsAdapter } from './domains/node-dns.adapter';
import { ReleaseReader } from './release-reader';
import { SiteRepository } from './site.repository';
import { SiteService } from './site.service';
import { SiteRouteService } from './site-route.service';

/**
 * Deploys and releases (spec 027, research R1). `CheckpointsModule` for the bundle and the
 * checkpoint reads, `SandboxModule` for the build sandbox and the template's `build`,
 * `TenancyModule` for the project, `RbacModule` for the go-live re-check and the routes' guard,
 * `OutboxModule` and `AuditModule` for the trail, `IdentityModule` for the routes' session. No
 * guard of its own. Its exports are `SiteRouteService` and `DomainRouteService`, for `preview`'s broker, and
 * `ReleaseReader`, for the connectors' Netlify publish (spec 030 R11).
 */
@Module({
  controllers: [DeploymentsController, DomainsController, SiteController],
  exports: [
    // Spec 046: the MCP tools call these directly.
    DeploymentService,
    SiteService,
    DomainRecordsReader,
    DomainRouteService,
    ReleaseReader,
    SiteRouteService,
  ],
  imports: [
    AuditModule,
    CheckpointsModule,
    IdentityModule,
    OutboxModule,
    RbacModule,
    SandboxModule,
    TenancyModule,
  ],
  providers: [
    // Discovered by `QueueRegistry`, not exported (spec 006 research R6).
    BuildDeployConsumer,
    DeployProjectConsumer,
    DeploySweepConsumer,
    DomainCheckConsumer,
    DomainCheckSweepConsumer,
    DomainMailConsumer,
    BuildRunner,
    DeploymentRepository,
    DeploymentService,
    DomainChecker,
    DomainNotices,
    DomainRecordsReader,
    DomainRepository,
    DomainService,
    DomainRouteService,
    ReleaseReader,
    SiteRepository,
    SiteRouteService,
    SiteService,
    {
      inject: [ConfigService],
      provide: ARTIFACT_STORE,
      useFactory: (config: ConfigService<Environment, true>) => objectStoreFor(config, 'artifacts'),
    },
    // Spec 028: with the `CLOUDFLARE_*` group absent the adapter answers `EdgeNotConfigured`.
    {
      inject: [ConfigService],
      provide: CUSTOM_HOSTNAMES,
      useFactory: (config: ConfigService<Environment, true>) =>
        new CloudflareForSaasAdapter(config),
    },
    { provide: DNS, useClass: NodeDnsAdapter },
  ],
})
export class DeployModule {}
