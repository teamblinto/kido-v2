import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { IdempotencyStore } from '../../../common/idempotency/idempotency.store';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { RunService } from '../../agent/run.service';
import { CheckpointService } from '../../checkpoints/checkpoint.service';
import { BindingService } from '../../connectors/binding.service';
import { ConnectionService } from '../../connectors/connection.service';
import { ConnectorListings } from '../../connectors/connector-listings';
import { DatabaseMigrationService } from '../../connectors/database-migrations';
import { RepoLinkService } from '../../connectors/repo-link.service';
import { SyncService } from '../../connectors/sync.service';
import { DeploymentService } from '../../deploy/deployment.service';
import { SiteService } from '../../deploy/site.service';
import { PreviewReader } from '../../preview/preview-reader';
import { PermissionResolutionService } from '../../rbac/permission-resolution.service';
import { FilesService } from '../../sandbox/files.service';
import { PREVIEW_ENV_SOURCE, type PreviewEnvSource } from '../../sandbox/sandbox.constants';
import { SANDBOX_PORT, type SandboxPort } from '../../sandbox/sandbox.port';
import { TemplateCatalogue } from '../../sandbox/template-catalogue';
import { TemplateVersions } from '../../sandbox/template-versions';
import { OrgService } from '../../tenancy/services/org.service';
import { ProjectService } from '../../tenancy/services/project.service';
import { WorkspaceService } from '../../tenancy/services/workspace.service';

/**
 * The platform services the MCP tools call (spec 046). One injectable so the per-request server
 * factory takes one dependency, and so it is plain which of the product's services the MCP surface
 * reaches: these, and nothing else. Every tool goes through a service the web app's own routes use,
 * so a tool can never do what the product's HTTP API would refuse.
 */
@Injectable()
export class McpPlatform {
  constructor(
    @Inject(TenantTransactionRunner) readonly transactions: TenantTransactionRunner,
    @Inject(PermissionResolutionService) readonly permissions: PermissionResolutionService,
    @Inject(IdempotencyStore) readonly idempotency: IdempotencyStore,
    @Inject(CLOCK) readonly clock: ClockPort,
    @Inject(OrgService) readonly orgs: OrgService,
    @Inject(WorkspaceService) readonly workspaces: WorkspaceService,
    @Inject(ProjectService) readonly projects: ProjectService,
    @Inject(TemplateCatalogue) readonly templates: TemplateCatalogue,
    @Inject(TemplateVersions) readonly templateVersions: TemplateVersions,
    @Inject(FilesService) readonly files: FilesService,
    @Inject(SANDBOX_PORT) readonly sandbox: SandboxPort,
    @Inject(CheckpointService) readonly checkpoints: CheckpointService,
    @Inject(RunService) readonly runs: RunService,
    @Inject(PreviewReader) readonly previews: PreviewReader,
    @Inject(DeploymentService) readonly deployments: DeploymentService,
    @Inject(SiteService) readonly sites: SiteService,
    @Inject(ConnectionService) readonly connections: ConnectionService,
    @Inject(BindingService) readonly bindings: BindingService,
    @Inject(ConnectorListings) readonly listings: ConnectorListings,
    @Inject(DatabaseMigrationService) readonly migrations: DatabaseMigrationService,
    @Inject(SyncService) readonly syncs: SyncService,
    @Inject(RepoLinkService) readonly repoLinks: RepoLinkService,
    @Inject(PREVIEW_ENV_SOURCE) readonly previewEnv: PreviewEnvSource,
  ) {}
}
