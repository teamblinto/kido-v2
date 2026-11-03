import { Body, Controller, Headers, Inject, Param, Put, Res } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IDEMPOTENCY_KEY_HEADER, type WriteFileResponse } from '@repo/contracts';

import { ValidationFailedError } from '../../../common/validation/validation-failed.error';
import { TenantContext } from '../../../database/tenant-context';
import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import { CheckpointService } from '../checkpoint.service';
import { WriteFileRequestDto } from '../dto/file-write.dto';
import { toResponse } from './checkpoints.controller';

/**
 * Saving a file by hand (024 US1, contracts/file-write.md § 2).
 *
 * ## Why this lives in the checkpoints module and not beside `FilesController`
 *
 * The URL is a file URL, but the operation is a checkpoint: the save writes the workspace,
 * commits it and inserts a row with the whole of a checkpoint's machinery behind it — the writer
 * lock, `insertOrGetBySha`, the change summary, the `checkpoint.created` outbox event and the
 * audit entry (research R0, R1). Serving it from `sandbox` would mean a `sandbox → checkpoints`
 * module edge for the one call, and `FilesService` would gain a dependency on a service that
 * already depends, through the port, on `sandbox`. A controller is free to answer on any path,
 * so the module graph stays as it is and the route keeps the shape the web expects: the same
 * prefix it reads the file from. That is the only reason the two halves of `…/files/content`
 * are declared in two files.
 *
 * `PUT`, because the body names the resource it replaces and carries its whole content. The
 * `Idempotency-Key` is required, as on `revert`: a keyless double-submit would move the
 * workspace twice. `201` when the save produced a checkpoint, `200` when the content was
 * already there — the status is set on the response object so the idempotency interceptor
 * records it and replays the same one.
 */
@ApiTags('checkpoints')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/projects/:projectId/files', version: '1' })
export class FileWriteController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(CheckpointService) private readonly checkpoints: CheckpointService,
  ) {}

  @Put('content')
  @RequirePermission('project:files.write')
  @ApiOperation({ summary: 'Save a file, recording the change as a checkpoint' })
  @ApiHeader({ name: IDEMPOTENCY_KEY_HEADER, required: true })
  @ApiResponse({ description: '`{ saved: true, checkpoint }` — the new checkpoint.', status: 201 })
  @ApiResponse({
    description:
      '`{ saved: false, checkpoint }` — the content was already there, nothing recorded.',
    status: 200,
  })
  @ApiResponse({ description: 'A run is active, or the base has moved.', status: 409 })
  @ApiResponse({ description: 'The workspace is waking; Retry-After says when.', status: 503 })
  async save(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Body() body: WriteFileRequestDto,
    @Headers(IDEMPOTENCY_KEY_HEADER.toLowerCase()) idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: StatusSettingResponse,
  ): Promise<WriteFileResponse> {
    if (idempotencyKey === undefined) {
      throw new ValidationFailedError('custom', [
        {
          code: 'idempotency_key_required',
          detail: `${IDEMPOTENCY_KEY_HEADER} is required on a save.`,
          pointer: `/headers/${IDEMPOTENCY_KEY_HEADER.toLowerCase()}`,
        },
      ]);
    }

    const result = await this.checkpoints.save(
      { orgId, projectId },
      caller.userId,
      { baseCheckpointId: body.baseCheckpointId, content: body.content, path: body.path },
      this.tenant.tx,
    );
    response.status(result.saved ? 201 : 200);
    return result.saved
      ? { checkpoint: toResponse(result.checkpoint), saved: true }
      : { checkpoint: toResponse(result.checkpoint), saved: false };
  }
}

/**
 * The platform response narrowed to the one thing this handler does with it, as
 * `session-cookie.ts` narrows it to `cookie`: a handler that only chooses a status should not be
 * typed as able to end the response.
 */
export interface StatusSettingResponse {
  status(code: number): unknown;
}
