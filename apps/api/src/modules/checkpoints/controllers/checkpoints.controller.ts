import {
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
  type CheckpointDiffResponse,
  type CheckpointListResponse,
  type Checkpoint as CheckpointResponse,
  IDEMPOTENCY_KEY_HEADER,
} from '@repo/contracts';
import type { Checkpoint } from '@repo/db';

import { ValidationFailedError } from '../../../common/validation/validation-failed.error';
import { TenantContext } from '../../../database/tenant-context';
import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import { CheckpointService } from '../checkpoint.service';
import {
  CheckpointDiffResponseDto,
  CheckpointListQueryDto,
  CheckpointListResponseDto,
  CheckpointResponseDto,
} from '../dto/checkpoint.dto';

/**
 * A project's checkpoint history (spec 016 US1, contracts § 2): list, one, and its diff — every
 * read `project:read` under the request's tenant transaction. A foreign org, an anonymous caller,
 * a missing project and a missing checkpoint are the same `404` (SC-008): the guards refuse the
 * first two, the service the rest. The revert (US2) is the one write: `project:files.write`,
 * `201` with the new row, replayed by the application-wide idempotency interceptor — and, as
 * the one route where a keyless double-submit moves the workspace twice, the key is required.
 */
@ApiTags('checkpoints')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/projects/:projectId/checkpoints', version: '1' })
export class CheckpointsController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(CheckpointService) private readonly checkpoints: CheckpointService,
  ) {}

  @Get()
  @RequirePermission('project:read')
  @ApiOperation({ summary: 'List the project’s checkpoints, newest first' })
  @ApiResponse({ status: 200, type: CheckpointListResponseDto })
  async list(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Query() query: CheckpointListQueryDto,
  ): Promise<CheckpointListResponse> {
    const page = await this.checkpoints.list(this.tenant.tx, { orgId, projectId }, query);
    return { items: page.items.map(toResponse), nextCursor: page.nextCursor };
  }

  @Get(':checkpointId')
  @RequirePermission('project:read')
  @ApiOperation({ summary: 'Read one checkpoint and its change summary' })
  @ApiResponse({ status: 200, type: CheckpointResponseDto })
  async read(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Param('checkpointId') checkpointId: string,
  ): Promise<CheckpointResponse> {
    return toResponse(
      await this.checkpoints.byId(this.tenant.tx, { orgId, projectId }, checkpointId),
    );
  }

  @Get(':checkpointId/diff')
  @RequirePermission('project:read')
  @ApiOperation({ summary: 'Diff one checkpoint against its parent' })
  @ApiResponse({ status: 200, type: CheckpointDiffResponseDto })
  @ApiResponse({ description: 'The workspace is waking; Retry-After says when.', status: 503 })
  async diff(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Param('checkpointId') checkpointId: string,
  ): Promise<CheckpointDiffResponse> {
    return this.checkpoints.diff(this.tenant.tx, { orgId, projectId }, checkpointId);
  }

  @Post(':checkpointId/revert')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('project:files.write')
  @ApiOperation({ summary: 'Restore the workspace to this checkpoint as a new checkpoint' })
  @ApiHeader({ name: IDEMPOTENCY_KEY_HEADER, required: true })
  @ApiResponse({ status: 201, type: CheckpointResponseDto })
  @ApiResponse({ description: 'A run is active, or the workspace is already there.', status: 409 })
  @ApiResponse({ description: 'The workspace is waking; Retry-After says when.', status: 503 })
  async revert(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Param('checkpointId') checkpointId: string,
    @Headers(IDEMPOTENCY_KEY_HEADER.toLowerCase()) idempotencyKey: string | undefined,
  ): Promise<CheckpointResponse> {
    if (idempotencyKey === undefined) {
      throw new ValidationFailedError('custom', [
        {
          code: 'idempotency_key_required',
          detail: `${IDEMPOTENCY_KEY_HEADER} is required on a revert.`,
          pointer: `/headers/${IDEMPOTENCY_KEY_HEADER.toLowerCase()}`,
        },
      ]);
    }
    return toResponse(
      await this.checkpoints.revert(
        { orgId, projectId },
        caller.userId,
        checkpointId,
        this.tenant.tx,
      ),
    );
  }
}

/** The row less its tenant columns, dates as ISO strings (contracts § 1). */
export function toResponse(row: Checkpoint): CheckpointResponse {
  return {
    actorId: row.actorId,
    createdAt: row.createdAt.toISOString(),
    files: row.files,
    gitSha: row.gitSha,
    id: row.id,
    kind: row.kind,
    label: row.label,
    mirroredAt: row.mirroredAt?.toISOString() ?? null,
    parentId: row.parentId,
    revertsId: row.revertsId,
    runId: row.runId,
    turn: row.turn,
  };
}
