import { Controller, Get, Inject, Param } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { ModelCatalogueResponse } from '@repo/contracts';

import { TenantContext } from '../../../database/tenant-context';
import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import { CatalogueService } from '../byok/catalogue.service';
import { ModelCatalogueResponseDto } from '../dto/model-catalogue.dto';

/**
 * The organisation's model catalogue (spec 011 US6, re-homed per organisation by 020 § 2 and
 * research R8): which models a run may be created with, the credential each would run under,
 * and the default. Tenant data, so `@ResourceOrg()` and `org:read` like every other org route.
 */
@ApiTags('agent')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/models', version: '1' })
export class ModelsController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(CatalogueService) private readonly catalogue: CatalogueService,
  ) {}

  @Get()
  @RequirePermission('org:read')
  @ApiOperation({ summary: 'List the models a run may be created with, and the default' })
  @ApiResponse({ status: 200, type: ModelCatalogueResponseDto })
  list(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
  ): Promise<ModelCatalogueResponse> {
    return this.catalogue.forOrg(this.tenant.tx, orgId, caller.userId);
  }
}
