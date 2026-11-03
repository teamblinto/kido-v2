import { Body, Controller, Delete, Get, Param, Patch } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  MEMBER_REMOVED,
  MEMBER_ROLE_CHANGED,
  type ChangeMemberRoleResponse,
  type OrgMemberListResponse,
  type RemoveMemberResponse,
} from '@repo/contracts';

import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import { ChangeMemberRoleDto } from '../dto/change-member-role.dto';
import { MembershipService } from '../services/membership.service';

/**
 * Organisation membership (T27).
 *
 * Three routes, and each is here because a permission needs proving: the list is what `org:read`'s
 * neighbour `org:members.read` guards, and the two mutations are the ones whose *effects* — the
 * permission-cache invalidation and the wholesale session revocation — are what criterion 11 turns
 * on. There is no "add member" route; that is an invitation (criterion 10, T29), and adding somebody
 * to an organisation without their consent is the thing an invitation exists to avoid.
 *
 * Every permission here is checked against the organisation named by `:orgId`, because
 * `@ResourceOrg()` at the class says that is the resource, and nothing reads a header (§11).
 */
@ApiTags('tenancy')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/members', version: '1' })
export class MembershipController {
  constructor(private readonly memberships: MembershipService) {}

  @Get()
  @RequirePermission('org:members.read')
  @ApiOperation({ summary: 'List the members of the organisation' })
  async list(@Param('orgId') orgId: string): Promise<OrgMemberListResponse> {
    return { members: await this.memberships.list(orgId) };
  }

  /**
   * `PATCH /api/v1/orgs/:orgId/members/:userId`.
   *
   * The guard answers "may this caller change roles here at all". The service answers "but not to a
   * role above their own, and not to the last owner" — §11's second layer, for the part a route
   * decorator cannot express because it depends on two rows nobody has loaded yet.
   */
  @Patch(':userId')
  @RequirePermission('org:members.role-change')
  @ApiOperation({ summary: 'Change a member’s organisation role' })
  async changeRole(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('userId') userId: string,
    @Body() body: ChangeMemberRoleDto,
  ): Promise<ChangeMemberRoleResponse> {
    await this.memberships.changeRole({ actorId: actor.userId, orgId, role: body.role, userId });

    return { role: body.role, status: MEMBER_ROLE_CHANGED };
  }

  /**
   * `DELETE /api/v1/orgs/:orgId/members/:userId`.
   *
   * The route criterion 11's second proof is written over: when this returns, the removed member's
   * permission set is gone from the cache *and* every session they held has been revoked — both
   * after the transaction committed, never before. `MembershipService.remove` documents why either
   * alone is insufficient.
   */
  @Delete(':userId')
  @RequirePermission('org:members.remove')
  @ApiOperation({ summary: 'Remove a member, revoking their sessions' })
  async remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('userId') userId: string,
  ): Promise<RemoveMemberResponse> {
    await this.memberships.remove({ actorId: actor.userId, orgId, userId });

    return { status: MEMBER_REMOVED };
  }
}
