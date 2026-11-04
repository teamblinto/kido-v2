import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SyncCommitResponse, SyncOperation, SyncOperationPage } from '@repo/contracts';

import { TenantContext } from '../../../database/tenant-context';
import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import {
  SyncCommitRequestDto,
  SyncCommitResponseDto,
  SyncListQueryDto,
  SyncOperationPageResponseDto,
  SyncOperationResponseDto,
} from '../dto/sync.dto';
import { SyncService } from '../sync.service';

/**
 * A project's push and pull operations (spec 018 US2/US3, contracts § 3): the two `POST`s answer
 * `202` with the `queued` row (refusals in § 4), replayed by the application-wide idempotency
 * interceptor; the reads are `project:read`. `commit` (spec 044) answers `200`: it did the work.
 */
@ApiTags('connectors')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/projects/:projectId/sync', version: '1' })
export class SyncController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(SyncService) private readonly syncs: SyncService,
  ) {}

  @Post('push')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('project:files.write')
  @ApiOperation({ summary: 'Queue a push of the project head to the linked branch' })
  @ApiResponse({ status: 202, type: SyncOperationResponseDto })
  push(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
  ): Promise<SyncOperation> {
    return this.syncs.request(this.tenant.tx, { orgId, projectId }, caller.userId, 'push');
  }

  @Post('pull')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('project:files.write')
  @ApiOperation({ summary: 'Queue a pull of the linked branch into the project' })
  @ApiResponse({ status: 202, type: SyncOperationResponseDto })
  pull(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
  ): Promise<SyncOperation> {
    return this.syncs.request(this.tenant.tx, { orgId, projectId }, caller.userId, 'pull');
  }

  @Post('commit')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('project:files.write')
  @ApiOperation({ summary: 'Commit the dirty workspace and push the project head' })
  @ApiResponse({ status: 200, type: SyncCommitResponseDto })
  commit(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Body() body: SyncCommitRequestDto,
  ): Promise<SyncCommitResponse> {
    return this.syncs.commit(this.tenant.tx, { orgId, projectId }, caller.userId, body);
  }

  @Get()
  @RequirePermission('project:read')
  @ApiOperation({ summary: 'List the project’s sync operations, newest first' })
  @ApiResponse({ status: 200, type: SyncOperationPageResponseDto })
  async list(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Query() query: SyncListQueryDto,
  ): Promise<SyncOperationPage> {
    const page = await this.syncs.list(this.tenant.tx, { orgId, projectId }, query);

    return {
      operations: page.items.map((row) => this.syncs.toContract(row)),
      ...(page.nextCursor === null ? {} : { nextCursor: page.nextCursor }),
    };
  }

  @Get(':operationId')
  @RequirePermission('project:read')
  @ApiOperation({ summary: 'Read one sync operation' })
  @ApiResponse({ status: 200, type: SyncOperationResponseDto })
  read(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Param('operationId') operationId: string,
  ): Promise<SyncOperation> {
    return this.syncs.byId(this.tenant.tx, { orgId, projectId }, operationId);
  }
}
