import { Body, Controller, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  type Connection,
  pasteTokenProviderSchema,
  type SupabaseInstallResponse,
} from '@repo/contracts';

import { NotFoundError } from '../../../common/errors/domain-error';
import { TenantContext } from '../../../database/tenant-context';
import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import { ConnectionService } from '../connection.service';
import {
  PasteTokenRequestDto,
  ProviderConnectionResponseDto,
  SupabaseCompleteRequestDto,
  SupabaseInstallResponseDto,
} from '../dto/connection.dto';

/**
 * Connecting the five spec 030 providers (contracts/bindings.md § 1): a pasted token for Netlify,
 * Neon, Resend and Cloudflare, verified before it is sealed; Supabase over OAuth with PKCE. Every
 * response is the contract row — the credential's fingerprint and nothing else of it (SC-002).
 */
@ApiTags('connectors')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/connectors', version: '1' })
export class ProviderConnectController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(ConnectionService) private readonly connections: ConnectionService,
  ) {}

  @Post('supabase/install')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('org:connectors.manage')
  @ApiOperation({ summary: 'Start authorising Supabase for this organisation' })
  @ApiResponse({ status: 200, type: SupabaseInstallResponseDto })
  @ApiResponse({ description: 'Supabase OAuth is not configured on this deployment.', status: 501 })
  supabaseInstall(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
  ): Promise<SupabaseInstallResponse> {
    return this.connections.beginSupabaseInstall(orgId, caller.userId);
  }

  @Post('supabase/complete')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('org:connectors.manage')
  @ApiOperation({ summary: 'Finish the authorisation Supabase sent the browser back from' })
  @ApiResponse({ status: 201, type: ProviderConnectionResponseDto })
  @ApiResponse({ description: 'The state is unknown, spent or for another org.', status: 400 })
  async supabaseComplete(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Body() body: SupabaseCompleteRequestDto,
  ): Promise<Connection> {
    const row = await this.connections.completeSupabaseInstall(
      this.tenant.tx,
      orgId,
      caller.userId,
      body,
    );

    return this.connections.toContract(row);
  }

  @Post(':provider/token')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('org:connectors.manage')
  @ApiOperation({ summary: 'Connect Netlify, Neon, Resend or Cloudflare with a pasted token' })
  @ApiResponse({ status: 201, type: ProviderConnectionResponseDto })
  @ApiResponse({
    description: 'The provider refused the token, or it lacks a permission (`missing`).',
    status: 422,
  })
  async pasteToken(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('provider') provider: string,
    @Body() body: PasteTokenRequestDto,
  ): Promise<Connection> {
    const parsed = pasteTokenProviderSchema.safeParse(provider);

    if (!parsed.success) {
      throw new NotFoundError('No such connector.');
    }

    const row = await this.connections.connectWithToken(
      this.tenant.tx,
      orgId,
      caller.userId,
      parsed.data,
      body.token,
    );

    return this.connections.toContract(row);
  }
}
