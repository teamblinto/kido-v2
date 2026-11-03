import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { WorkspaceListResponse, WorkspaceResponse } from '@repo/contracts';

import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import { CreateWorkspaceDto } from '../dto/create-workspace.dto';
import { RenameWorkspaceDto } from '../dto/rename-workspace.dto';
import { WorkspaceService } from '../services/workspace.service';

/**
 * Workspace reads (T27) — the surface criterion 11's "an org member of the wrong role cannot read
 * another workspace" is asserted over — and, since spec 007, the three writes.
 *
 * The writes are behind `org:settings.update` rather than a workspace role: a workspace is
 * organisation structure, and the person who may reshape the organisation is the one who may add
 * or remove its workspaces (ADR 031). A workspace admin may run one; they may not create one.
 */
@ApiTags('tenancy')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/workspaces', version: '1' })
export class WorkspaceController {
  constructor(private readonly workspaces: WorkspaceService) {}

  /**
   * `GET /api/v1/orgs/:orgId/workspaces`.
   *
   * `workspace:read` is a *scoped* permission, so this route has no single resource to qualify it
   * with — which is exactly why the listing is not guarded on it. It is guarded on `org:read`
   * instead: seeing that the organisation has workspaces at all is an organisation-level fact, and
   * the list itself contains only the workspaces the caller holds a role in.
   *
   * The alternative — guard it on `workspace:read` and pick some workspace to qualify with — has no
   * sensible answer, and the one it would end up with ("any of them") is how a listing quietly
   * becomes readable by somebody with a role in one unrelated workspace.
   */
  @Get()
  @RequirePermission('org:read')
  @ApiOperation({ summary: 'List the workspaces the caller has a role in' })
  async list(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
  ): Promise<WorkspaceListResponse> {
    return { workspaces: await this.workspaces.list(orgId, caller.userId) };
  }

  /**
   * `GET /api/v1/orgs/:orgId/workspaces/:workspaceId`.
   *
   * `workspace:read`, qualified with `:workspaceId` — `@RequirePermission()` derives that parameter
   * from the `workspace:` prefix. So the resolved set must contain `workspace:read@{this one}`, and
   * a member with a role in a *different* workspace of the same organisation is refused, which is
   * the criterion.
   */
  @Get(':workspaceId')
  @RequirePermission('workspace:read')
  @ApiOperation({ summary: 'Read one workspace' })
  async read(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('workspaceId') workspaceId: string,
  ): Promise<WorkspaceResponse> {
    return { workspace: await this.workspaces.read(orgId, workspaceId, caller.userId) };
  }

  /** `POST /api/v1/orgs/:orgId/workspaces`. The creator holds `admin` in it, which the shape reports. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('org:settings.update')
  @ApiOperation({ summary: 'Create a workspace' })
  async create(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Body() body: CreateWorkspaceDto,
  ): Promise<WorkspaceResponse> {
    return {
      workspace: await this.workspaces.create({
        actorId: caller.userId,
        name: body.name,
        orgId,
        ownerId: caller.userId,
      }),
    };
  }

  /**
   * `PATCH /api/v1/orgs/:orgId/workspaces/:workspaceId`. `204`: the read shape carries the
   * caller's own role, and an org admin renaming a workspace they hold no role in has none to
   * report (contracts/http.md).
   */
  @Patch(':workspaceId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('org:settings.update')
  @ApiOperation({ summary: 'Rename a workspace' })
  async rename(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: RenameWorkspaceDto,
  ): Promise<void> {
    await this.workspaces.rename({ actorId: caller.userId, name: body.name, orgId, workspaceId });
  }

  /** `DELETE /api/v1/orgs/:orgId/workspaces/:workspaceId`. Archives it and its live projects (R6). */
  @Delete(':workspaceId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('org:settings.update')
  @ApiOperation({ summary: 'Archive a workspace and its projects' })
  async archive(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('workspaceId') workspaceId: string,
  ): Promise<void> {
    await this.workspaces.archive({ actorId: caller.userId, orgId, workspaceId });
  }
}
