import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { LocalAgentDeviceList, PairingPreview } from '@repo/contracts';
import { z } from 'zod';

import { NotFoundError } from '../../../common/errors/domain-error';
import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import { StepUp } from '../../identity/decorators/step-up.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { DeviceService } from '../device.service';
import {
  ApprovePairingDto,
  LocalAgentDeviceListDto,
  PairingPreviewDto,
} from '../dto/local-agent.dto';
import { LocalAgentEnabledGuard } from '../local-agent.guards';
import { PairingService } from '../pairing.service';

/**
 * A person's own paired devices (spec 040 § 5). The session guard only — no `:orgId`, no
 * permission: the caller is the owner and the only reader, as `/me/linked-accounts` is. Revoking
 * and approving a pairing are step-up actions; previewing and denying are not.
 */
@ApiTags('local-agent')
@UseGuards(LocalAgentEnabledGuard)
@Controller({ path: 'me/local-agents', version: '1' })
export class LocalAgentController {
  constructor(
    @Inject(DeviceService) private readonly devices: DeviceService,
    @Inject(PairingService) private readonly pairings: PairingService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'The caller’s paired devices, with presence and what each reported' })
  @ApiResponse({ status: 200, type: LocalAgentDeviceListDto })
  list(@CurrentUser() caller: AuthenticatedUser): Promise<LocalAgentDeviceList> {
    return this.devices.list(caller.userId);
  }

  @Get('pairings/:userCode')
  @ApiOperation({ summary: 'What a pairing code would pair, before approving it' })
  @ApiResponse({ status: 200, type: PairingPreviewDto })
  preview(@Param('userCode') userCode: string): Promise<PairingPreview> {
    return this.pairings.preview(userCode);
  }

  @Post('pairings/approve')
  @HttpCode(HttpStatus.NO_CONTENT)
  @StepUp()
  @ApiOperation({ summary: 'Approve a pairing: the companion receives its device token' })
  @ApiResponse({ description: '`step-up-required`: confirm a second factor first.', status: 403 })
  async approve(
    @CurrentUser() caller: AuthenticatedUser,
    @Body() body: ApprovePairingDto,
  ): Promise<void> {
    await this.pairings.approve(caller.userId, body.userCode);
  }

  @Post('pairings/deny')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Refuse a pairing' })
  async deny(
    @CurrentUser() caller: AuthenticatedUser,
    @Body() body: ApprovePairingDto,
  ): Promise<void> {
    await this.pairings.deny(caller.userId, body.userCode);
  }

  @Delete(':deviceId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @StepUp()
  @ApiOperation({ summary: 'Revoke a device: its token stops working at once' })
  async revoke(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('deviceId') deviceId: string,
  ): Promise<void> {
    if (!z.uuid().safeParse(deviceId).success)
      throw new NotFoundError('No such device among yours.');

    await this.devices.revoke(caller.userId, deviceId);
  }
}
