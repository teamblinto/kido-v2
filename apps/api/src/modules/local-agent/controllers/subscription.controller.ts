import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SubscriptionList, SubscriptionStatus } from '@repo/contracts';

import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { AgentHomeService } from '../agent-home.service';
import {
  SubscriptionCodeDto,
  SubscriptionListDto,
  SubscriptionStatusDto,
} from '../dto/local-agent.dto';

/**
 * The person's own Claude subscription, run in their private cloud agent home (spec 041 design,
 * § Person-facing API). Session and CSRF only — no step-up: the sign-in itself is Anthropic's.
 * The code route's body is the one-time code, which is redacted from request logs by position
 * (`req.body.code`) and by key name, and goes nowhere but the runner.
 */
@ApiTags('subscriptions')
@Controller({ path: 'me/subscriptions', version: '1' })
export class SubscriptionController {
  constructor(@Inject(AgentHomeService) private readonly homes: AgentHomeService) {}

  @Get()
  @ApiOperation({ summary: 'The caller’s subscriptions and where each one’s sign-in stands' })
  @ApiResponse({ status: 200, type: SubscriptionListDto })
  async list(@CurrentUser() caller: AuthenticatedUser): Promise<SubscriptionList> {
    return { claude: await this.homes.status(caller.userId) };
  }

  @Post('claude/connect')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Provision and start the agent home, and begin Claude’s sign-in' })
  @ApiResponse({ status: 202, type: SubscriptionStatusDto })
  @ApiResponse({ description: '`subscription-unavailable`: not offered here.', status: 503 })
  connect(@CurrentUser() caller: AuthenticatedUser): Promise<SubscriptionStatus> {
    return this.homes.connect(caller.userId);
  }

  @Post('claude/code')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Hand the one-time code from Claude’s sign-in page to the agent home' })
  @ApiResponse({ description: 'No sign-in is waiting, or the home is away.', status: 409 })
  async code(
    @CurrentUser() caller: AuthenticatedUser,
    @Body() body: SubscriptionCodeDto,
  ): Promise<void> {
    await this.homes.submitCode(caller.userId, body.code);
  }

  @Post('claude/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Cancel a sign-in under way' })
  async cancel(@CurrentUser() caller: AuthenticatedUser): Promise<void> {
    await this.homes.cancel(caller.userId);
  }

  @Delete('claude')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Sign Claude out in the agent home, then delete the home' })
  async disconnect(@CurrentUser() caller: AuthenticatedUser): Promise<void> {
    await this.homes.disconnect(caller.userId);
  }
}
