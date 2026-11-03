import { Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FileContentResponse, FileListResponse, WakeResponse } from '@repo/contracts';

import { TenantContext } from '../../../database/tenant-context';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import { FileListResponseDto, FilePathQueryDto, WakeResponseDto } from '../dto/files.dto';
import { FilesService } from '../files.service';

/**
 * A project's files, read-only, and the wake (spec 022, contracts/files.md § 1–3). Every route is
 * `project:read` under the request's tenant transaction — the wake included: waking a workspace to
 * look at it is not a write to the project.
 *
 * No try/catch anywhere. The service lets every refusal but `file-too-large` through untouched, and
 * `sandbox.errors.ts` already maps a `SandboxGuardError` to the 404 / 400 / 409 § 1–2 asks for.
 * Catching here could only duplicate that mapping or hide it.
 */
@ApiTags('sandbox')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/projects/:projectId/files', version: '1' })
export class FilesController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(FilesService) private readonly files: FilesService,
  ) {}

  @Get()
  @RequirePermission('project:read')
  @ApiOperation({ summary: 'List one directory of the project workspace' })
  @ApiResponse({ status: 200, type: FileListResponseDto })
  @ApiResponse({ description: 'The path escapes the jail, or names a file.', status: 400 })
  @ApiResponse({
    description: 'The sandbox is not ready; `extensions.state` says why.',
    status: 409,
  })
  async list(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Query() query: FilePathQueryDto,
  ): Promise<FileListResponse> {
    return this.files.list({ orgId, projectId }, query.path);
  }

  @Get('content')
  @RequirePermission('project:read')
  @ApiOperation({ summary: 'Read one file, or why it cannot be shown' })
  @ApiResponse({
    description:
      '`{ renderable: true, path, bytes, content, baseCheckpointId }`, or `{ renderable: false, path, bytes, reason }` with `reason` `binary` or `too-large`.',
    status: 200,
  })
  @ApiResponse({ description: 'The path escapes the jail, or names a directory.', status: 400 })
  @ApiResponse({
    description: 'The sandbox is not ready; `extensions.state` says why.',
    status: 409,
  })
  async content(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Query() query: FilePathQueryDto,
  ): Promise<FileContentResponse> {
    return this.files.read(this.tenant.tx, { orgId, projectId }, query.path);
  }

  /** § 3: idempotent — a second call while resuming answers the same `because` and enqueues nothing. */
  @Post('wake')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('project:read')
  @ApiOperation({ summary: 'Wake the project workspace, or say what it is already doing' })
  @ApiResponse({ status: 200, type: WakeResponseDto })
  async wake(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
  ): Promise<WakeResponse> {
    return this.files.wake(this.tenant.tx, { orgId, projectId });
  }
}
