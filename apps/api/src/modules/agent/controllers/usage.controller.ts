import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { UsageRunListResponse } from '@repo/contracts';

import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import { RunListQueryDto } from '../dto/run-query.dto';
import { RunService } from '../run.service';

/**
 * Settings → Usage (contracts usage.ts): the caller's own runs in the organisation and what each
 * spent. `org:read`, not a project permission: the list spans every project, and it is the
 * caller's own spend, so the service filters to the session's user — never a user in the path.
 */
@ApiTags('agent')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/usage', version: '1' })
export class UsageController {
  constructor(@Inject(RunService) private readonly runs: RunService) {}

  @Get('runs')
  @RequirePermission('org:read')
  @ApiOperation({ summary: 'List the caller’s own runs in the organisation, newest first' })
  list(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Query() query: RunListQueryDto,
  ): Promise<UsageRunListResponse> {
    return this.runs.usage(orgId, caller.userId, query);
  }
}
