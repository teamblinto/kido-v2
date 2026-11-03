import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { PersonalAccountsPolicy } from '@repo/contracts';

import { TenantContext } from '../../../database/tenant-context';
import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import { PersonalAccountsPolicyDto } from '../dto/personal-accounts-policy.dto';
import { OrgService } from '../services/org.service';

/**
 * Spec 032 T051 (contracts/byos.md § 2): whether members may run on their own Claude or OpenAI
 * subscriptions. Every member may read it — the composer explains a forbidden organisation — and
 * only `org:settings.update` (owner, admin) may change it.
 */
@ApiTags('tenancy')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/settings', version: '1' })
export class OrgSettingsController {
  constructor(
    private readonly orgs: OrgService,
    @Inject(TenantContext) private readonly tenant: TenantContext,
  ) {}

  @Get('personal-accounts')
  @RequirePermission('org:read')
  @ApiOperation({ summary: "Read whether members' personal subscriptions are allowed" })
  async readPersonalAccounts(): Promise<PersonalAccountsPolicy> {
    return {
      allowed: await this.orgs.personalAccountsAllowed(this.tenant.tx, this.tenant.orgId),
    };
  }

  @Put('personal-accounts')
  @RequirePermission('org:settings.update')
  @ApiOperation({ summary: "Allow or forbid members' personal subscriptions" })
  async updatePersonalAccounts(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: PersonalAccountsPolicyDto,
  ): Promise<PersonalAccountsPolicy> {
    return {
      allowed: await this.orgs.setPersonalAccountsAllowed(
        this.tenant.tx,
        this.tenant.orgId,
        actor.userId,
        body.allowed,
      ),
    };
  }
}
