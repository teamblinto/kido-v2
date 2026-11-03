import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Ip,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { PairingTokenResponse, StartPairingResponse } from '@repo/contracts';

import { Public } from '../../identity/decorators/public.decorator';
import { PairingTokenDto, StartPairingDto, StartPairingResponseDto } from '../dto/local-agent.dto';
import { LocalAgentEnabledGuard } from '../local-agent.guards';
import { PairingService } from '../pairing.service';

/**
 * The companion's half of pairing (spec 040 § 5): unauthenticated by nature — the companion has
 * no credential yet — so strictly throttled per address, and CSRF-exempt by exact path.
 */
@ApiTags('local-agent')
@Public()
@UseGuards(LocalAgentEnabledGuard)
@Controller({ path: 'local-agent/pairings', version: '1' })
export class PairingController {
  constructor(@Inject(PairingService) private readonly pairings: PairingService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Begin pairing a companion: a device code and a code to approve' })
  @ApiResponse({ status: 201, type: StartPairingResponseDto })
  start(@Body() body: StartPairingDto, @Ip() ip: string): Promise<StartPairingResponse> {
    // The address only as a coarse network, for the person's preview (pairing phishing).
    return this.pairings.start(body, ip);
  }

  @Post('token')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Poll a pairing; the device token is in exactly one answer' })
  @ApiResponse({ description: '`local-agent-pairing-invalid`: unknown or spent.', status: 400 })
  poll(@Body() body: PairingTokenDto): Promise<PairingTokenResponse> {
    return this.pairings.poll(body.deviceCode);
  }
}
