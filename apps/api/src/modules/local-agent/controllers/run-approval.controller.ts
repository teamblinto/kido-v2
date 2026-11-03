import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { ConflictError, ForbiddenError, NotFoundError } from '../../../common/errors/domain-error';
import { RunService } from '../../agent/run.service';
import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import { RunApprovalDecisionDto } from '../dto/local-agent.dto';
import { LocalAgentEnabledGuard } from '../local-agent.guards';
import { LocalAgentStore } from '../local-agent.store';

/**
 * A person's answer to a local agent's approval request (spec 040 § 3 decision 7). The run must be
 * in the project and the request still waiting; the decision is handed to the executor on the
 * run's control stream, and the executor — which holds the run's fence — emits the one
 * `approval.resolved` and answers the device. `204`: the ask is recorded, the effect is the
 * worker's, as cancel and input are.
 *
 * Only the run's starter may answer (spec 040 § 3, authorisation): the approval lets a tool run on
 * *their* computer, so `project:agent.run` — which every other member with the role also holds —
 * is not enough. Anyone with it may still cancel the run: stopping is safe.
 */
@ApiTags('local-agent')
@ResourceOrg()
@UseGuards(LocalAgentEnabledGuard)
@Controller({ path: 'orgs/:orgId/projects/:projectId/runs/:runId/approvals', version: '1' })
export class RunApprovalController {
  constructor(
    @Inject(RunService) private readonly runs: RunService,
    @Inject(LocalAgentStore) private readonly store: LocalAgentStore,
  ) {}

  @Post(':requestId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('project:agent.run')
  @ApiOperation({ summary: 'Allow or deny what a local agent asked to do' })
  @ApiResponse({ description: 'Only the person who started the run may answer.', status: 403 })
  @ApiResponse({ description: 'No such run.', status: 404 })
  @ApiResponse({ description: 'No approval is waiting with that id.', status: 409 })
  async decide(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Param('runId') runId: string,
    @Param('requestId') requestId: string,
    @Body() body: RunApprovalDecisionDto,
  ): Promise<void> {
    if (!z.uuid().safeParse(runId).success) throw new NotFoundError('No such run.');

    const run = await this.runs.read(orgId, projectId, runId);

    if (run.userId !== caller.userId) {
      throw new ForbiddenError(
        'Only the person who started this run can answer it: it runs on their own computer.',
      );
    }

    if (!(await this.store.hasApproval(runId, requestId))) {
      throw new ConflictError('No approval is waiting with that id.');
    }

    await this.store.decide(runId, {
      decision: body.decision,
      ...(body.message === undefined ? {} : { message: body.message }),
      requestId,
    });
  }
}
