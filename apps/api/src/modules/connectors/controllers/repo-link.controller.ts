import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Put,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { PutRepoLinkRequest, RepoLink } from '@repo/contracts';

import { TenantContext } from '../../../database/tenant-context';
import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import { PutRepoLinkRequestDto, RepoLinkResponseDto } from '../dto/repo-link.dto';
import { RepoLinkService } from '../repo-link.service';

/**
 * A project's repository link (spec 018 US2/US5, contracts § 2): read for `project:read`, link
 * and unlink for `project:files.write`. A foreign org and a missing project are the same `404`;
 * a viewer's `PUT` is `permission-denied` before the service runs.
 */
@ApiTags('connectors')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/projects/:projectId/repo-link', version: '1' })
export class RepoLinkController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(RepoLinkService) private readonly links: RepoLinkService,
  ) {}

  @Get()
  @RequirePermission('project:read')
  @ApiOperation({ summary: 'Read the project’s repository link, or null' })
  @ApiResponse({ status: 200, type: RepoLinkResponseDto })
  read(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
  ): Promise<RepoLink | null> {
    return this.links.read(this.tenant.tx, { orgId, projectId });
  }

  @Put()
  @RequirePermission('project:files.write')
  @ApiOperation({ summary: 'Link the project to a new or existing repository' })
  @ApiResponse({ status: 200, type: RepoLinkResponseDto })
  @ApiResponse({ description: 'name-taken, create-unsupported or needs-reauth.', status: 409 })
  link(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Body() body: PutRepoLinkRequestDto,
  ): Promise<RepoLink> {
    return this.links.link(
      this.tenant.tx,
      { orgId, projectId },
      caller.userId,
      body as PutRepoLinkRequest,
    );
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('project:files.write')
  @ApiOperation({ summary: 'Unlink the project; the repository is left as it is' })
  @ApiResponse({ status: 204 })
  unlink(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
  ): Promise<void> {
    return this.links.unlink(this.tenant.tx, { orgId, projectId }, caller.userId);
  }
}
