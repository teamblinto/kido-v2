import { Body, Controller, Delete, HttpCode, HttpStatus, Inject, Param, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { PresenceResponse } from '@repo/contracts';
import { schema } from '@repo/db';
import { eq } from 'drizzle-orm';

import { TenantContext } from '../../../database/tenant-context';
import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import { PresenceHeartbeatDto } from '../dto/presence-heartbeat.dto';
import { PresenceService } from './presence.service';

/**
 * Who else has this project open (spec 031, US3, contracts/presence.md). Both routes demand
 * `project:read` on the project in the path, so a revoked guest's next heartbeat is refused by the
 * guard (FR-019). The identity written is the authenticated principal's, never anything sent.
 */
@ApiTags('tenancy')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/projects/:projectId/presence', version: '1' })
export class PresenceController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(PresenceService) private readonly presence: PresenceService,
  ) {}

  /** `PUT …/presence`: a last-write-wins upsert of the caller's field; answers everyone else. */
  @Put()
  @RequirePermission('project:read')
  @ApiOperation({ summary: 'Say where you are in the project and see who else is here' })
  async heartbeat(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Body() body: PresenceHeartbeatDto,
  ): Promise<PresenceResponse> {
    const [account] = await this.tenant.tx
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, caller.userId))
      .limit(1);

    if (!account) {
      return { available: false, people: [] };
    }

    return this.presence.heartbeat(
      orgId,
      projectId,
      { email: account.email, userId: caller.userId },
      body.location,
    );
  }

  /** `DELETE …/presence`: leaving, sent with `keepalive` on `pagehide`. Best effort. */
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('project:read')
  @ApiOperation({ summary: 'Leave the project’s presence list' })
  async leave(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
  ): Promise<void> {
    await this.presence.leave(orgId, projectId, caller.userId);
  }
}
