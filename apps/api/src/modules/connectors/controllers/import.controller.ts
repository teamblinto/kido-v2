import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { ImportMismatchResponse, InspectImportResponse, SyncOperation } from '@repo/contracts';

import { TenantContext } from '../../../database/tenant-context';
import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import {
  InspectImportRequestDto,
  InspectImportResponseDto,
  StartImportRequestDto,
  TemplateMismatchResponseDto,
} from '../dto/import.dto';
import { ImportService } from '../import.service';
import { SyncOperationResponseDto } from '../dto/sync.dto';

/**
 * Importing a repository into a new project (spec 026 US1, contracts §§ 1–2).
 *
 * Under `/workspaces/:workspaceId` for the reason `workspace-project.controller.ts` gives: the
 * permission that admits both routes is the workspace's project-create permission, and the guard
 * reads its qualifying id from `:workspaceId` (ADR 031). The project the import creates does not
 * exist when the request arrives, so there is no project scope for it to be routed under.
 *
 * Both routes are `POST`. The inspect is idempotent and writes nothing — the verb is the body's,
 * not the effect's.
 */
@ApiTags('connectors')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/workspaces/:workspaceId/imports', version: '1' })
export class ImportController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(ImportService) private readonly imports: ImportService,
  ) {}

  @Post('inspect')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('workspace:projects.create')
  @ApiOperation({ summary: 'Propose a template for a repository, with the evidence for it' })
  @ApiResponse({ status: 200, type: InspectImportResponseDto })
  inspect(
    @Param('orgId') orgId: string,
    @Body() body: InspectImportRequestDto,
  ): Promise<InspectImportResponse> {
    return this.imports.inspect(this.tenant.tx, orgId, body);
  }

  /**
   * `202` with spec 018's `SyncOperation` at `kind: 'import'`, carrying the `projectId` the client
   * navigates to while the import runs. Progress is polled through spec 018's existing sync-operation
   * routes; this feature adds no second polling surface.
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('workspace:projects.create')
  @ApiOperation({ summary: 'Import a repository into a new project' })
  @ApiResponse({ status: 202, type: SyncOperationResponseDto })
  start(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: StartImportRequestDto,
  ): Promise<SyncOperation> {
    return this.imports.start(this.tenant.tx, orgId, workspaceId, caller.userId, body);
  }
}

/**
 * Contracts § 4: the FR-016 warning, read by the project's GitHub panel.
 *
 * A separate controller because it is a separate scope — this one is addressed by `:projectId` and
 * guarded by `project:read`, as spec 018's `repo-link` route is, while the import's own two routes
 * are addressed by `:workspaceId` (the project does not exist yet when they are called).
 *
 * It is its own payload rather than a field on the link: `repo-link.ts` is a spec 018 contract this
 * feature does not open (SC-014), and a warning that belongs to an import has no business widening
 * a schema every linked project parses.
 */
@ApiTags('connectors')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/projects/:projectId/import-mismatch', version: '1' })
export class ImportMismatchController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(ImportService) private readonly imports: ImportService,
  ) {}

  @Get()
  @RequirePermission('project:read')
  @ApiOperation({ summary: 'The chosen template’s disagreement with the repository, or null' })
  @ApiResponse({ status: 200, type: TemplateMismatchResponseDto })
  async mismatch(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
  ): Promise<ImportMismatchResponse> {
    return { templateMismatch: await this.imports.mismatch(this.tenant.tx, orgId, projectId) };
  }
}
