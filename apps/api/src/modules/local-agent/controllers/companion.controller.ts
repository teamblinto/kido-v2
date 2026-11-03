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
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { companionAuthEventSchema } from '@repo/contracts';
import type { LocalAgentDeviceRow } from '@repo/db';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';

import { NotFoundError } from '../../../common/errors/domain-error';
import { ValidationFailedError } from '../../../common/validation/validation-failed.error';
import { toValidationIssues } from '../../../common/validation/zod-validation.pipe';
import { Public } from '../../identity/decorators/public.decorator';
import { AgentHomeService } from '../agent-home.service';
import { CommandStream } from '../command-stream';
import { DeviceService } from '../device.service';
import { CompanionRunEventBatchDto, CompanionStatusReportDto } from '../dto/local-agent.dto';
import { DEVICE_EVENTS_PER_MINUTE } from '../local-agent.constants';
import {
  CurrentDevice,
  DeviceThrottlerGuard,
  DeviceTokenGuard,
  LocalAgentEnabledGuard,
} from '../local-agent.guards';

const STREAM_ID = /^\d{1,20}-\d{1,20}$/;

/**
 * The companion's own routes (spec 040 § 5): `@Public()` to the session guard, gated by the device
 * token instead, and CSRF-exempt by exact path (the stream is a `GET`). The downlink is SSE, the
 * uplink is POSTs.
 */
@ApiTags('local-agent')
@ApiBearerAuth()
@Public()
@UseGuards(LocalAgentEnabledGuard, DeviceTokenGuard, DeviceThrottlerGuard)
@Controller({ path: 'local-agent', version: '1' })
export class CompanionController {
  constructor(
    @Inject(DeviceService) private readonly devices: DeviceService,
    @Inject(CommandStream) private readonly commands: CommandStream,
    @Inject(AgentHomeService) private readonly homes: AgentHomeService,
  ) {}

  /**
   * Not `@Sse()`, for run.controller.ts's reason: the handler checks what it can refuse, writes the
   * headers and hands the socket to the detached reader, and returns.
   */
  @Get('connect')
  @ApiOperation({
    description:
      'Server-sent events: `hello` first, then commands with `id:` = stream entry id (send it back ' +
      'as `Last-Event-ID` to resume), `:heartbeat` every 15 s. One connection per device: a newer ' +
      'one replaces it. `device.revoked` is the last frame of a revoked device.',
    summary: 'The companion’s command stream',
  })
  @ApiProduces('text/event-stream')
  connect(
    @CurrentDevice() device: LocalAgentDeviceRow,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Res() res: ServerResponse,
  ): void {
    if (lastEventId !== undefined && !STREAM_ID.test(lastEventId)) {
      throw new ValidationFailedError('custom', [
        {
          code: 'last_event_id_invalid',
          detail: 'Last-Event-ID must be an id this stream sent.',
          pointer: '/headers/last-event-id',
        },
      ]);
    }

    res.statusCode = HttpStatus.OK;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const closed = new AbortController();

    res.on('close', () => closed.abort());
    void this.commands.serve({
      deviceId: device.id,
      from: lastEventId,
      kind: device.kind,
      res,
      signal: closed.signal,
    });
  }

  @Post('status')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Report the CLI the runner found and its sign-in' })
  async status(
    @CurrentDevice() device: LocalAgentDeviceRow,
    @Body() body: CompanionStatusReportDto,
  ): Promise<void> {
    await this.devices.reportStatus(device, body);

    await this.homes.onReport(device.id);
  }

  /**
   * Spec 041: an agent home's runner reports its sign-in — the Anthropic URL to show, then the
   * result.
   */
  @Post('auth')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Report a Claude sign-in’s URL or result' })
  async auth(@CurrentDevice() device: LocalAgentDeviceRow, @Body() raw: unknown): Promise<void> {
    // A discriminated union has no DTO class (a class cannot extend a union), so it is parsed here,
    // with the pipe's own issue mapping.
    const parsed = companionAuthEventSchema.safeParse(raw);

    if (!parsed.success) throw new ValidationFailedError('body', toValidationIssues(parsed.error));

    await this.homes.onAuthEvent(device, parsed.data);
  }

  /**
   * Idempotent by `seq`: a retried batch adds nothing it already added. Refused while the run is
   * not executing or the batch's turn is not the running one (`409`), and past the turn's byte
   * budget (`413`, the run is stopped). Throttled per address and per device.
   */
  @Post('runs/:runId/events')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: DEVICE_EVENTS_PER_MINUTE, ttl: 60_000 } })
  @ApiOperation({ summary: 'Post a batch of a run’s events (the device must own the run)' })
  @ApiResponse({ description: 'The run, or that turn of it, is not running.', status: 409 })
  @ApiResponse({
    description: 'The turn’s event budget is spent; the run is stopped.',
    status: 413,
  })
  async events(
    @CurrentDevice() device: LocalAgentDeviceRow,
    @Param('runId') runId: string,
    @Body() body: CompanionRunEventBatchDto,
  ): Promise<void> {
    if (!z.uuid().safeParse(runId).success) throw new NotFoundError('No such run on this device.');

    await this.devices.ingest(device, runId, body);
  }
}
