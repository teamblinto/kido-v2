import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type {
  AuthorizeRepoCreateResponse,
  PutRepoLinkRequest,
  RepoBranchList,
  RepoLink,
} from '@repo/contracts';

import { TenantContext } from '../../../database/tenant-context';
import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import {
  AuthorizeRepoCreateRequestDto,
  AuthorizeRepoCreateResponseDto,
  CompleteRepoCreateRequestDto,
  CreateBranchRequestDto,
  PatchRepoLinkRequestDto,
  PutRepoLinkRequestDto,
  RepoBranchListResponseDto,
  RepoLinkResponseDto,
} from '../dto/repo-link.dto';
import { RepoLinkService } from '../repo-link.service';

/**
 * A project's repository link (spec 018 US2/US5, contracts § 2; spec 044): reads for
 * `project:read`, everything that changes it for `project:files.write`. A foreign org and a missing project are the same `404`;
 * a viewer's `PUT` is `permission-denied` before the service runs.
 */
@ApiTags('connectors')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/projects/:projectId/repo-link', version: '1' })
export class RepoLinkController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(RepoLinkService) private readonly links: RepoLinkService,
  ) {}

  @Get()
  @RequirePermission('project:read')
  @ApiOperation({ summary: 'Read the project’s repository link, or null' })
  @ApiResponse({ status: 200, type: RepoLinkResponseDto })
  read(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
  ): Promise<RepoLink | null> {
    return this.links.read(this.tenant.tx, { orgId, projectId });
  }

  @Put()
  @RequirePermission('project:files.write')
  @ApiOperation({ summary: 'Link the project to a new or existing repository' })
  @ApiResponse({ status: 200, type: RepoLinkResponseDto })
  @ApiResponse({ description: 'name-taken, create-unsupported or needs-reauth.', status: 409 })
  link(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Body() body: PutRepoLinkRequestDto,
  ): Promise<RepoLink> {
    return this.links.link(
      this.tenant.tx,
      { orgId, projectId },
      caller.userId,
      body as PutRepoLinkRequest,
    );
  }

  @Patch()
  @RequirePermission('project:files.write')
  @ApiOperation({ summary: 'Change the linked branch or turn auto-sync on or off' })
  @ApiResponse({ status: 200, type: RepoLinkResponseDto })
  @ApiResponse({
    description: 'not-linked, run-active, operation-in-flight or branch-not-found.',
    status: 409,
  })
  update(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Body() body: PatchRepoLinkRequestDto,
  ): Promise<RepoLink> {
    return this.links.update(this.tenant.tx, { orgId, projectId }, caller.userId, body);
  }

  @Get('branches')
  @RequirePermission('project:read')
  @ApiOperation({ summary: 'List the linked repository’s branches' })
  @ApiResponse({ status: 200, type: RepoBranchListResponseDto })
  branches(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
  ): Promise<RepoBranchList> {
    return this.links.branches(this.tenant.tx, { orgId, projectId });
  }

  @Post('branches')
  @RequirePermission('project:files.write')
  @ApiOperation({ summary: 'Create a branch from the linked branch’s head and switch to it' })
  @ApiResponse({ status: 201, type: RepoLinkResponseDto })
  @ApiResponse({
    description: 'not-linked, run-active, operation-in-flight, nothing-to-push or name-taken.',
    status: 409,
  })
  createBranch(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Body() body: CreateBranchRequestDto,
  ): Promise<RepoLink> {
    return this.links.createBranch(this.tenant.tx, { orgId, projectId }, caller.userId, body);
  }

  @Post('authorize')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('project:files.write')
  @ApiOperation({ summary: 'Begin creating a repository on a personal account' })
  @ApiResponse({ status: 200, type: AuthorizeRepoCreateResponseDto })
  @ApiResponse({ description: 'Already linked, an organisation, or not offered.', status: 409 })
  authorize(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Body() body: AuthorizeRepoCreateRequestDto,
  ): Promise<AuthorizeRepoCreateResponse> {
    return this.links.authorize(this.tenant.tx, { orgId, projectId }, caller.userId, body);
  }

  @Post('authorized')
  @RequirePermission('project:files.write')
  @ApiOperation({ summary: 'Finish it: create the repository, link it and push' })
  @ApiResponse({ status: 201, type: RepoLinkResponseDto })
  @ApiResponse({ description: 'The state is unknown, spent or for another project.', status: 400 })
  @ApiResponse({ description: 'account-mismatch or name-taken.', status: 409 })
  @ApiResponse({ description: 'GitHub did not complete the authorisation.', status: 502 })
  completeCreate(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Body() body: CompleteRepoCreateRequestDto,
  ): Promise<RepoLink> {
    return this.links.completeCreate(this.tenant.tx, { orgId, projectId }, caller.userId, body);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('project:files.write')
  @ApiOperation({ summary: 'Unlink the project; the repository is left as it is' })
  @ApiResponse({ status: 204 })
  unlink(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
  ): Promise<void> {
    return this.links.unlink(this.tenant.tx, { orgId, projectId }, caller.userId);
  }
}
