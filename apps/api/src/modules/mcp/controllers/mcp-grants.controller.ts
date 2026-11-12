import { Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { McpGrantList } from '@repo/contracts';

import { TenantContext } from '../../../database/tenant-context';
import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import { McpGrantListDto } from '../dto/mcp.dto';
import { McpOAuthService } from '../oauth/mcp-oauth.service';

/**
 * The AI agents a person has connected to one organisation (spec 046). Each person sees and
 * revokes their own; a grant is their consent, not the organisation's setting.
 */
@ApiTags('mcp')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/mcp/grants', version: '1' })
export class McpGrantsController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(McpOAuthService) private readonly oauth: McpOAuthService,
  ) {}

  @Get()
  @RequirePermission('org:read')
  @ApiOperation({ summary: 'List the MCP clients the caller has authorized in this organization' })
  @ApiResponse({ status: 200, type: McpGrantListDto })
  async list(@CurrentUser() caller: AuthenticatedUser): Promise<McpGrantList> {
    return { items: await this.oauth.listGrants(this.tenant.tx, caller.userId) };
  }

  @Delete(':grantId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('org:read')
  @ApiOperation({ summary: 'Revoke one of the caller’s MCP clients' })
  async revoke(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('grantId') grantId: string,
  ): Promise<void> {
    await this.oauth.revokeGrant(this.tenant.tx, orgId, caller.userId, grantId);
  }
}
