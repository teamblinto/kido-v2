import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ProjectListResponse, ProjectResponse } from '@repo/contracts';

import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import { ProjectService } from '../services/project.service';

/**
 * Project reads (T27), and the surface T30's guest proof is written over.
 *
 * Reads only. The writes live on `workspace-project.controller.ts`, under the workspace.
 */
@ApiTags('tenancy')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/projects', version: '1' })
export class ProjectController {
  constructor(private readonly projects: ProjectService) {}

  /**
   * `GET /api/v1/orgs/:orgId/projects` — the listing T30 is built around, and the one route in the
   * application that deliberately carries no `@RequirePermission()`.
   *
   * ## Why there is nothing for the guard to check
   *
   * Every candidate is wrong, and each is wrong in an instructive way.
   *
   * `org:read` would be the obvious choice and it is the one that breaks the criterion. A guest
   * holds no membership, so their resolved set never enters the org scope; the route would answer
   * `403` and a guest could not list the projects they were explicitly granted. §11 gives them
   * "access to named projects only" — that access has to be reachable.
   *
   * `project:read` cannot be used either: it is a *scoped* permission, so it only means anything
   * qualified with a project id, and this route names no project. Qualifying it with "any of them"
   * is how a listing quietly becomes readable by anyone holding one unrelated grant.
   *
   * So the answer is that the permission set is not a *precondition* here — it **is** the result.
   * `ProjectService.list` asks for the caller's resolved set and returns exactly the projects it
   * holds `project:read` on. A caller with nothing gets `[]`. There is no decision left for a guard
   * to make, and adding one would only be able to make the route wrong.
   *
   * ## Why the empty list leaks nothing
   *
   * An organisation the caller has no access to and an organisation that does not exist both answer
   * `{"projects":[]}`, byte for byte. That is the property §11's guest scope needs — "no visibility
   * into the organisation", which T30 spells out as "not a filtered org view, not an empty org
   * listing that confirms the org exists". It is empty here because the *caller* can see nothing,
   * not because the organisation is; the two are indistinguishable from outside, which is the point.
   *
   * And the exclusion is why the list is a list rather than a page of refusals: a per-item `403`
   * would tell a guest exactly how many projects they cannot see.
   */
  @Get()
  @ApiOperation({ summary: 'List the projects the caller may read' })
  async list(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
  ): Promise<ProjectListResponse> {
    return { projects: await this.projects.list(orgId, caller.userId) };
  }

  /**
   * `GET /api/v1/orgs/:orgId/projects/:projectId`.
   *
   * Guarded, and qualified with `:projectId`, so the resolved set must hold
   * `project:read@{this one}`. A guest granted project A is refused project B with the same `403`
   * they would get for a project id that does not exist — which is what stops the route being a way
   * to discover the organisation's projects one uuid at a time.
   */
  @Get(':projectId')
  @RequirePermission('project:read')
  @ApiOperation({ summary: 'Read one project' })
  async read(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
  ): Promise<ProjectResponse> {
    return { project: await this.projects.read(orgId, projectId, caller.userId) };
  }
}
