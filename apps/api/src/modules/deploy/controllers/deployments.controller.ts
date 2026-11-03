import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  type DeploymentListResponse,
  type DeploymentLogResponse,
  type DeploymentResponse,
  IDEMPOTENCY_KEY_HEADER,
} from '@repo/contracts';

import { ValidationFailedError } from '../../../common/validation/validation-failed.error';
import { TenantContext } from '../../../database/tenant-context';
import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import { DeploymentService } from '../deployment.service';
import {
  CreateDeploymentRequestDto,
  DeploymentListQueryDto,
  DeploymentListResponseDto,
  DeploymentLogResponseDto,
  DeploymentResponseDto,
} from '../dto/deployment.dto';

/**
 * A project's deployments (spec 027 US1, contracts/deployments.md). The create answers `202` with
 * the `queued` row and requires an `Idempotency-Key` — a keyless double-submit would queue two
 * builds — which the application-wide idempotency interceptor then replays. The reads are
 * `project:read`; the log has its own route so a list never carries a 64 KiB tail per row.
 */
@ApiTags('deploy')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/projects/:projectId/deployments', version: '1' })
export class DeploymentsController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(DeploymentService) private readonly deployments: DeploymentService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('project:deploy')
  @ApiOperation({ summary: 'Build and deploy a checkpoint (the head when none is named)' })
  @ApiHeader({ name: IDEMPOTENCY_KEY_HEADER, required: true })
  @ApiResponse({ status: 202, type: DeploymentResponseDto })
  @ApiResponse({
    description: 'Archived, not deployable, or a deployment is already in flight (`reason`).',
    status: 409,
  })
  async create(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Body() body: CreateDeploymentRequestDto,
    @Headers(IDEMPOTENCY_KEY_HEADER.toLowerCase()) idempotencyKey: string | undefined,
  ): Promise<DeploymentResponse> {
    if (idempotencyKey === undefined) {
      throw new ValidationFailedError('custom', [
        {
          code: 'idempotency_key_required',
          detail: `${IDEMPOTENCY_KEY_HEADER} is required on a deploy.`,
          pointer: `/headers/${IDEMPOTENCY_KEY_HEADER.toLowerCase()}`,
        },
      ]);
    }

    return {
      deployment: await this.deployments.request(
        this.tenant.tx,
        { orgId, projectId },
        caller.userId,
        body,
      ),
    };
  }

  @Get()
  @RequirePermission('project:read')
  @ApiOperation({ summary: 'List the project’s deployments, newest first' })
  @ApiResponse({ status: 200, type: DeploymentListResponseDto })
  list(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Query() query: DeploymentListQueryDto,
  ): Promise<DeploymentListResponse> {
    return this.deployments.list(this.tenant.tx, { orgId, projectId }, query);
  }

  @Get(':deploymentId')
  @RequirePermission('project:read')
  @ApiOperation({ summary: 'Read one deployment' })
  @ApiResponse({ status: 200, type: DeploymentResponseDto })
  async read(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Param('deploymentId') deploymentId: string,
  ): Promise<DeploymentResponse> {
    return {
      deployment: await this.deployments.get(this.tenant.tx, { orgId, projectId }, deploymentId),
    };
  }

  @Get(':deploymentId/log')
  @RequirePermission('project:read')
  @ApiOperation({ summary: 'Read a deployment’s stored, scrubbed build log tail' })
  @ApiResponse({ status: 200, type: DeploymentLogResponseDto })
  log(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Param('deploymentId') deploymentId: string,
  ): Promise<DeploymentLogResponse> {
    return this.deployments.log(this.tenant.tx, { orgId, projectId }, deploymentId);
  }
}
