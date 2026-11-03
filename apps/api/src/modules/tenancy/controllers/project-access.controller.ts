import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  AcceptProjectInvitationResponse,
  InviteToProjectResponse,
  ProjectAccessResponse,
} from '@repo/contracts';

import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import { AcceptProjectInvitationDto } from '../dto/accept-project-invitation.dto';
import { InviteToProjectDto } from '../dto/invite-to-project.dto';
import { ProjectInvitationService } from '../services/project-invitation.service';

/**
 * Sharing one project (spec 031 US2, contracts/sharing.md §§ 1–4).
 *
 * The three project routes are `project:share.external` on `:projectId` — the owner's alone.
 * `Idempotency-Key` is honoured on the invite by the application-wide `IdempotencyInterceptor`, as
 * on the org invite; the open-invitation partial unique makes a keyless double-submit harmless too.
 *
 * Accept is modelled on `InvitationController.accept`: a session and nothing else, because the
 * caller holds no grant yet — the link is the authority, and `:orgId` comes from it.
 */
@ApiTags('tenancy')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId', version: '1' })
export class ProjectAccessController {
  constructor(private readonly invitations: ProjectInvitationService) {}

  @Get('projects/:projectId/access')
  @RequirePermission('project:share.external')
  @ApiOperation({ summary: 'List who has access to a project, and who is invited' })
  async list(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
  ): Promise<ProjectAccessResponse> {
    return this.invitations.list(orgId, projectId);
  }

  @Post('projects/:projectId/invitations')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('project:share.external')
  @ApiOperation({ summary: 'Invite an address to one project' })
  async invite(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Body() body: InviteToProjectDto,
  ): Promise<InviteToProjectResponse> {
    return this.invitations.invite({
      actorId: actor.userId,
      email: body.email,
      orgId,
      projectId,
      role: body.role,
    });
  }

  @Delete('projects/:projectId/invitations/:invitationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('project:share.external')
  @ApiOperation({ summary: 'Withdraw an open project invitation' })
  async withdraw(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Param('invitationId') invitationId: string,
  ): Promise<void> {
    await this.invitations.withdraw({ actorId: actor.userId, invitationId, orgId, projectId });
  }

  @Post('project-invitations/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept a project invitation' })
  async accept(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Body() body: AcceptProjectInvitationDto,
  ): Promise<AcceptProjectInvitationResponse> {
    return this.invitations.accept({ actorId: actor.userId, orgId, token: body.token });
  }
}
