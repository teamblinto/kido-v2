import { Body, Controller, Delete, Param, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  PROJECT_GRANT_REVOKED,
  PROJECT_GRANTED,
  type GrantProjectResponse,
  type RevokeProjectGrantResponse,
} from '@repo/contracts';

import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import { GrantProjectDto } from '../dto/grant-project.dto';
import { ProjectGrantService } from '../services/project-grant.service';

/**
 * Sharing a project with somebody outside the organisation (T30) — the two routes that create and
 * end a guest relationship.
 *
 * Both are guarded on `project:share.external`, which `PROJECT_ROLE_PERMISSIONS` gives to the
 * project owner alone. That is §11's own division and it is the right one here: "rotating the
 * preview label and sharing externally are the owner's alone: both change who *outside* the
 * organisation can reach the project, which is not something an editor of the files should decide."
 *
 * The permission is scoped, so `@RequirePermission()` qualifies it with `:projectId` — the resolved
 * set must hold `project:share.external@{this project}`. An owner of one project therefore cannot
 * share another, which is the property that keeps a single compromised project owner from becoming
 * a way to hand out the whole organisation.
 */
@ApiTags('tenancy')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/projects/:projectId/grants', version: '1' })
export class ProjectGrantController {
  constructor(private readonly grants: ProjectGrantService) {}

  /**
   * `PUT /api/v1/orgs/:orgId/projects/:projectId/grants/:userId`.
   *
   * `PUT` and idempotent: "this person has this role on this project" is a statement about a state,
   * and re-sending it must not be a conflict.
   */
  @Put(':userId')
  @RequirePermission('project:share.external')
  @ApiOperation({ summary: 'Grant a user access to one project' })
  async grant(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @Body() body: GrantProjectDto,
  ): Promise<GrantProjectResponse> {
    await this.grants.grant({
      actorId: actor.userId,
      orgId,
      projectId,
      role: body.role,
      userId,
    });

    return { role: body.role, status: PROJECT_GRANTED };
  }

  /**
   * `DELETE /api/v1/orgs/:orgId/projects/:projectId/grants/:userId`.
   *
   * The guest's permission set is invalidated after the commit, so the access ends on their very
   * next request. Their session is left alone: a revoked grant is not a member removal, and the
   * account may be a full member of somewhere else entirely.
   */
  @Delete(':userId')
  @RequirePermission('project:share.external')
  @ApiOperation({ summary: 'Withdraw a user’s access to one project' })
  async revoke(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
  ): Promise<RevokeProjectGrantResponse> {
    await this.grants.revoke({ actorId: actor.userId, orgId, projectId, userId });

    return { status: PROJECT_GRANT_REVOKED };
  }
}
