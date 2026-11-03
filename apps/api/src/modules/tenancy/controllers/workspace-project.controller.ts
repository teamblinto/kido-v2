import { Body, Controller, Delete, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ProjectResponse } from '@repo/contracts';

import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import { CreateProjectDto } from '../dto/create-project.dto';
import { RenameProjectDto } from '../dto/rename-project.dto';
import { ProjectService } from '../services/project.service';

/**
 * Project writes (spec 007), routed under the workspace they happen in.
 *
 * Under `/workspaces/:workspaceId` rather than `/projects`, because the permissions that admit
 * them are workspace-scoped (`workspace:projects.create`, `workspace:projects.archive`) and the
 * guard reads its qualifying id from the `:workspaceId` parameter (ADR 031). The reads stay on
 * `project.controller.ts`, where a guest with a grant and no workspace role can reach them.
 */
@ApiTags('tenancy')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/workspaces/:workspaceId/projects', version: '1' })
export class WorkspaceProjectController {
  constructor(private readonly projects: ProjectService) {}

  /**
   * `POST /api/v1/orgs/:orgId/workspaces/:workspaceId/projects`.
   *
   * A `403` for a viewer, a member with no role here, a guest and a workspace id from another
   * organisation alike — the guard's uniform denial (§10.7). The one `404` is an archived workspace
   * the caller still holds a role in, which the service decides.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('workspace:projects.create')
  @ApiOperation({ summary: 'Create a project in a workspace' })
  async create(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: CreateProjectDto,
  ): Promise<ProjectResponse> {
    return {
      project: await this.projects.create({
        actorId: caller.userId,
        name: body.name,
        orgId,
        ownerId: caller.userId,
        template: body.template,
        workspaceId,
      }),
    };
  }

  /**
   * `PATCH …/projects/:projectId`. `204`: the client refetches (contracts/http.md). Behind the
   * same permission as create — a rename is the workspace's business, not a project role's.
   */
  @Patch(':projectId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('workspace:projects.create')
  @ApiOperation({ summary: 'Rename a project' })
  async rename(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('projectId') projectId: string,
    @Body() body: RenameProjectDto,
  ): Promise<void> {
    await this.projects.rename({
      actorId: caller.userId,
      name: body.name,
      orgId,
      projectId,
      workspaceId,
    });
  }

  /** `DELETE …/projects/:projectId`. An archive, never a purge (ADR 012); `404` once archived. */
  @Delete(':projectId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('workspace:projects.archive')
  @ApiOperation({ summary: 'Archive a project' })
  async archive(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('projectId') projectId: string,
  ): Promise<void> {
    await this.projects.archive({ actorId: caller.userId, orgId, projectId, workspaceId });
  }
}
