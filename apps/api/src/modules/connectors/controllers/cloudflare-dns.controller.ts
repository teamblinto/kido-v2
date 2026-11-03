import { Controller, Get, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { CloudflareOffer, Operation } from '@repo/contracts';

import { TenantContext } from '../../../database/tenant-context';
import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import { StepUp } from '../../identity/decorators/step-up.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import { CloudflareDnsService } from '../cloudflare-dns.service';
import { CloudflareOfferResponseDto, OperationResponseDto } from '../dto/connection.dto';

/**
 * A custom domain's DNS through the organisation's Cloudflare connection (spec 030 US2,
 * contracts/bindings.md § 3): the offer, and the write — step-up and `org:domains.manage`, the
 * permission 028's domain routes carry.
 */
@ApiTags('connectors')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/domains/:domainId/cloudflare', version: '1' })
export class CloudflareDnsController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(CloudflareDnsService) private readonly dns: CloudflareDnsService,
  ) {}

  @Get()
  @RequirePermission('org:domains.manage')
  @ApiOperation({ summary: "Whether Cloudflare can write this domain's records" })
  @ApiResponse({ status: 200, type: CloudflareOfferResponseDto })
  @ApiResponse({ description: 'The domain is not pending and nothing was written.', status: 409 })
  offer(
    @Param('orgId') orgId: string,
    @Param('domainId') domainId: string,
  ): Promise<CloudflareOffer> {
    return this.dns.offer(this.tenant.tx, orgId, domainId);
  }

  @Post('write')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('org:domains.manage')
  @StepUp()
  @ApiOperation({ summary: "Write this domain's records into the Cloudflare zone" })
  @ApiResponse({ status: 202, type: OperationResponseDto })
  @ApiResponse({
    description:
      'A different record is at a name (`record-conflict`), or the domain is not pending.',
    status: 409,
  })
  write(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('domainId') domainId: string,
  ): Promise<Operation> {
    return this.dns.requestWrite(this.tenant.tx, orgId, caller.userId, domainId);
  }
}
