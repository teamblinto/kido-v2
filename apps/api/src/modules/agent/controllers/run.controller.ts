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
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  lastEventIdSchema,
  type RunEventsResponse,
  type RunLineResponse,
  type RunListResponse,
  type RunResponse,
  STREAM_RETRY_MS,
} from '@repo/contracts';
import type { Redis } from 'ioredis';
import type { ServerResponse } from 'node:http';

import { DomainError } from '../../../common/errors/domain-error';
import { STREAM_REDIS } from '../../../common/redis/redis.constants';
import { TenantContext } from '../../../database/tenant-context';
import { ValidationFailedError } from '../../../common/validation/validation-failed.error';
import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import { CreateRunDto } from '../dto/create-run.dto';
import { RunInputDto } from '../dto/run-input.dto';
import { RunEventsQueryDto, RunListQueryDto } from '../dto/run-query.dto';
import { RunLineService } from '../run-line.service';
import { RunService } from '../run.service';
import { isTerminal } from '../run-state-machine';
import { RunStreamReader } from '../run-stream-reader';

/**
 * Agent runs (spec 008, contracts/http.md). `project:agent.run` to start one, `project:read` to
 * watch it — each qualified by `:projectId`, so a grant on another project is the guard's uniform
 * `403`. Cancel and input answer `202`: the ask is recorded, the effect is the worker's.
 */
@ApiTags('agent')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/projects/:projectId/runs', version: '1' })
export class RunController {
  constructor(
    private readonly runs: RunService,
    @Inject(RunStreamReader) private readonly reader: RunStreamReader,
    @Inject(STREAM_REDIS) private readonly redis: Redis,
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(RunLineService) private readonly lines: RunLineService,
  ) {}

  /** `201` with the durable row in `queued`; the worker has not been involved yet. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('project:agent.run')
  @ApiOperation({ summary: 'Start an agent run' })
  async create(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Body() body: CreateRunDto,
  ): Promise<RunResponse> {
    return this.runs.create(
      orgId,
      projectId,
      caller.userId,
      body.prompt,
      body.model,
      body.credential,
      body.localAgent,
      body.subscription,
    );
  }

  @Post(':runId/cancel')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('project:agent.run')
  @ApiOperation({ summary: 'Ask a run to stop at its next boundary' })
  async cancel(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Param('runId') runId: string,
  ): Promise<void> {
    await this.runs.cancel(orgId, projectId, runId, caller.userId);
  }

  @Post(':runId/input')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('project:agent.run')
  @ApiOperation({ summary: 'Answer a run that is waiting for input' })
  async input(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Param('runId') runId: string,
    @Body() body: RunInputDto,
  ): Promise<void> {
    await this.runs.input(orgId, projectId, runId, caller.userId, body.message);
  }

  @Get()
  @RequirePermission('project:read')
  @ApiOperation({ summary: 'List the project’s runs, newest first' })
  async list(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Query() query: RunListQueryDto,
  ): Promise<RunListResponse> {
    return this.runs.list(orgId, projectId, query);
  }

  /** Spec 031 contracts/run-line.md § 2. Declared before `:runId`, which would otherwise match. */
  @Get('line')
  @RequirePermission('project:read')
  @ApiOperation({ summary: 'Read who holds the project and the runs waiting behind them' })
  async line(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
  ): Promise<RunLineResponse> {
    return this.lines.read(this.tenant.tx, orgId, projectId);
  }

  @Get(':runId')
  @RequirePermission('project:read')
  @ApiOperation({ summary: 'Read one run' })
  async read(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Param('runId') runId: string,
  ): Promise<RunResponse> {
    return this.runs.read(orgId, projectId, runId);
  }

  @Get(':runId/events')
  @RequirePermission('project:read')
  @ApiOperation({ summary: 'Page a run’s events by seq' })
  async events(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Param('runId') runId: string,
    @Query() query: RunEventsQueryDto,
  ): Promise<RunEventsResponse> {
    return this.runs.events(orgId, projectId, runId, query.after, query.limit);
  }

  /**
   * The run event stream (spec 009, contracts/http.md). Not `@Sse()`: the tenant interceptor takes
   * `firstValueFrom` of the handler and would hold the request transaction for the life of the
   * connection (research R4). Instead everything refusable happens here, inside the transaction —
   * the run read, the `Last-Event-ID` bounds, the terminal `204`, the Redis ping — and only then
   * are the headers written and the socket handed to the reader, which runs detached on the stream
   * Redis and short tenant transactions of its own. The handler returns at once and the
   * interceptor's transaction commits.
   */
  @Get(':runId/stream')
  @RequirePermission('project:read')
  @ApiOperation({
    description:
      'Server-sent events: `retry: 2000` first, then `event: <type>` frames carrying the run event ' +
      'envelope as `data`; durable events carry `id: <seq>`, token / thought / tool.delta do not; ' +
      'one `stream.reset` frame with the Postgres snapshot when `Last-Event-ID` has aged out; ' +
      '`:heartbeat` every 15 s; the response ends after the terminal `state` frame.',
    summary: 'Watch a run live, resumable from a seq',
  })
  @ApiProduces('text/event-stream')
  @ApiResponse({ description: 'The run has ended and Last-Event-ID is its last seq.', status: 204 })
  async stream(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Param('runId') runId: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Res() res: ServerResponse,
  ): Promise<void> {
    const run = await this.runs.read(orgId, projectId, runId);
    const from = lastEventIdSchema.safeParse(lastEventId ?? 0);

    if (!from.success || from.data > run.lastSeq) {
      throw new ValidationFailedError('custom', [
        {
          code: 'last_event_id_out_of_range',
          detail: `Last-Event-ID must be an integer between 0 and ${run.lastSeq}.`,
          pointer: '/headers/last-event-id',
        },
      ]);
    }

    const terminal = isTerminal(run.status);

    if (terminal && from.data === run.lastSeq) {
      res.statusCode = HttpStatus.NO_CONTENT;
      res.end();

      return;
    }

    try {
      await this.redis.ping();
    } catch {
      throw new DomainError('service-unavailable', 'The run event stream is unavailable.');
    }

    res.statusCode = HttpStatus.OK;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(`retry: ${STREAM_RETRY_MS}

`);

    const viewer = new AbortController();

    res.on('close', () => viewer.abort());
    void this.reader.serve({
      from: from.data,
      lastSeq: run.lastSeq,
      orgId,
      projectId,
      res,
      runId,
      signal: viewer.signal,
      terminal,
    });
  }
}
