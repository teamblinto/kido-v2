import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type {
  NeonProjectPage,
  NetlifySitePage,
  ResendDomainPage,
  SupabaseProjectPage,
} from '@repo/contracts';

import { TenantContext } from '../../../database/tenant-context';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import { ConnectorListings } from '../connector-listings';
import {
  NeonProjectPageResponseDto,
  NetlifySitePageResponseDto,
  ProjectListingQueryDto,
  ResendDomainPageResponseDto,
  SupabaseProjectPageResponseDto,
} from '../dto/bindings.dto';

/**
 * The bind form's listings on the connectors path (contracts/bindings.md § 1): what the named
 * connection can see, for `org:connectors.read`. A class of its own beside `ConnectorsController`
 * so each provider's story adds its listing without widening that controller's constructor.
 */
@ApiTags('connectors')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/connectors', version: '1' })
export class ConnectorListingsController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(ConnectorListings) private readonly listings: ConnectorListings,
  ) {}

  @Get(':connectionId/netlify/sites')
  @RequirePermission('org:connectors.read')
  @ApiOperation({ summary: 'The Netlify sites the token can see' })
  @ApiResponse({ status: 200, type: NetlifySitePageResponseDto })
  netlifySites(
    @Param('orgId') orgId: string,
    @Param('connectionId') connectionId: string,
    @Query() query: ProjectListingQueryDto,
  ): Promise<NetlifySitePage> {
    return this.listings.netlifySites(this.tenant.tx, orgId, connectionId, query.q, query.cursor);
  }

  @Get(':connectionId/neon/projects')
  @RequirePermission('org:connectors.read')
  @ApiOperation({ summary: 'The Neon projects the key can see, with branches, databases, roles' })
  @ApiResponse({ status: 200, type: NeonProjectPageResponseDto })
  neonProjects(
    @Param('orgId') orgId: string,
    @Param('connectionId') connectionId: string,
    @Query() query: ProjectListingQueryDto,
  ): Promise<NeonProjectPage> {
    return this.listings.neonProjects(this.tenant.tx, orgId, connectionId, query.q);
  }

  @Get(':connectionId/supabase/projects')
  @RequirePermission('org:connectors.read')
  @ApiOperation({ summary: 'The Supabase projects the grant can see' })
  @ApiResponse({ status: 200, type: SupabaseProjectPageResponseDto })
  supabaseProjects(
    @Param('orgId') orgId: string,
    @Param('connectionId') connectionId: string,
  ): Promise<SupabaseProjectPage> {
    return this.listings.supabaseProjects(this.tenant.tx, orgId, connectionId);
  }

  @Get(':connectionId/resend/domains')
  @RequirePermission('org:connectors.read')
  @ApiOperation({ summary: "The Resend domains the key can see, never the platform's own" })
  @ApiResponse({ status: 200, type: ResendDomainPageResponseDto })
  resendDomains(
    @Param('orgId') orgId: string,
    @Param('connectionId') connectionId: string,
  ): Promise<ResendDomainPage> {
    return this.listings.resendDomains(this.tenant.tx, orgId, connectionId);
  }
}
