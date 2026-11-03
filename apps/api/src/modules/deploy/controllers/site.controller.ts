import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SiteResponse, UpdateSiteRequest } from '@repo/contracts';

import { TenantContext } from '../../../database/tenant-context';
import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import { SiteResponseDto, UpdateSiteRequestDto } from '../dto/site.dto';
import { SiteService } from '../site.service';

/**
 * A project's site (spec 027 US2 and US5, contracts/deployments.md § site). `PUT` is one verb with
 * two actions: `release` makes a `succeeded` deployment current with no build (rollback /
 * roll-forward), `offline` takes the site down. Both are idempotent by their target state, so no
 * `Idempotency-Key` is required.
 */
@ApiTags('deploy')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/projects/:projectId/site', version: '1' })
export class SiteController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(SiteService) private readonly sites: SiteService,
  ) {}

  @Get()
  @RequirePermission('project:read')
  @ApiOperation({ summary: 'Read the project’s site: address, current deployment, offline' })
  @ApiResponse({ status: 200, type: SiteResponseDto })
  async read(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
  ): Promise<SiteResponse> {
    return { site: await this.sites.read(this.tenant.tx, { orgId, projectId }) };
  }

  @Put()
  @RequirePermission('project:deploy')
  @ApiOperation({ summary: 'Release a succeeded deployment, or take the site offline' })
  @ApiResponse({ status: 200, type: SiteResponseDto })
  @ApiResponse({
    description: 'Not releasable, archived, or never deployed (`reason`).',
    status: 409,
  })
  async update(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Body() body: UpdateSiteRequestDto,
  ): Promise<SiteResponse> {
    const ref = { orgId, projectId };
    const request = body as UpdateSiteRequest;
    const site =
      request.action === 'release'
        ? await this.sites.release(this.tenant.tx, ref, caller.userId, request.deploymentId)
        : await this.sites.offline(this.tenant.tx, ref, caller.userId);

    return { site };
  }
}
