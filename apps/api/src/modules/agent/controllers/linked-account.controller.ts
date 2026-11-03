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
  Res,
} from '@nestjs/common';
import { ApiExtraModels, ApiOperation, ApiResponse, ApiTags, getSchemaPath } from '@nestjs/swagger';
import type {
  BeginLinkResponse,
  CompleteLinkPending,
  LinkedAccount,
  LinkedAccountList,
} from '@repo/contracts';

import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import { StepUp } from '../../identity/decorators/step-up.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { assertOffered } from '../byos/byos.errors';
import { ByosProviders } from '../byos/byos-providers';
import { BeginDeviceLinkDto, BeginRedirectLinkDto } from '../byos/dto/begin-link.dto';
import { CompleteLinkPendingDto, CompleteLinkRequestDto } from '../byos/dto/complete-link.dto';
import { LinkedAccountResponseDto } from '../byos/dto/linked-account.dto';
import { LinkedAccountListResponseDto } from '../byos/dto/linked-account-list.dto';
import { LinkedAccountService } from '../byos/linked-account.service';

/** Only the part of the Express response this controller touches. */
interface StatusResponse {
  status(code: number): unknown;
}

/**
 * A person's own linked subscription accounts (spec 032 US1/US2, contracts § 1). The global session
 * guard only: **no** `@RequirePermission` and no `:orgId` — the caller is the owner and the only
 * reader (FR-008), and the user id and session id come from the session principal, never the body.
 * A provider that is not offered answers `404` on every `:provider` route (US1.1).
 */
@ApiTags('linked-accounts')
@Controller({ path: 'me/linked-accounts', version: '1' })
export class LinkedAccountController {
  constructor(
    @Inject(ByosProviders) private readonly providers: ByosProviders,
    @Inject(LinkedAccountService) private readonly links: LinkedAccountService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'The offered providers and the caller’s linked accounts' })
  @ApiResponse({ status: 200, type: LinkedAccountListResponseDto })
  list(@CurrentUser() caller: AuthenticatedUser): Promise<LinkedAccountList> {
    return this.links.list(caller.userId);
  }

  @Post(':provider/begin')
  @HttpCode(HttpStatus.OK)
  @StepUp()
  @ApiOperation({ summary: 'Start linking the caller’s own subscription' })
  @ApiExtraModels(BeginRedirectLinkDto, BeginDeviceLinkDto)
  @ApiResponse({
    schema: {
      oneOf: [
        { $ref: getSchemaPath(BeginRedirectLinkDto) },
        { $ref: getSchemaPath(BeginDeviceLinkDto) },
      ],
    },
    status: 200,
  })
  @ApiResponse({ description: '`step-up-required`: confirm a second factor first.', status: 403 })
  async begin(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('provider') param: string,
  ): Promise<BeginLinkResponse> {
    const provider = await assertOffered(this.providers, param);
    return this.links.begin(caller.userId, caller.sessionId, provider);
  }

  @Post(':provider/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Finish a link with the provider’s answer' })
  @ApiResponse({ status: 200, type: LinkedAccountResponseDto })
  @ApiResponse({ status: 202, type: CompleteLinkPendingDto })
  async complete(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('provider') param: string,
    @Body() body: CompleteLinkRequestDto,
    @Res({ passthrough: true }) response: StatusResponse,
  ): Promise<LinkedAccount | CompleteLinkPending> {
    const provider = await assertOffered(this.providers, param);
    const result = await this.links.complete(caller.userId, caller.sessionId, provider, body);
    if ('pending' in result) response.status(HttpStatus.ACCEPTED);
    return result;
  }

  @Post(':provider/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check the caller’s linked account now (what the daily sweep runs)' })
  @ApiResponse({ status: 200, type: LinkedAccountResponseDto })
  async verify(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('provider') param: string,
  ): Promise<LinkedAccount> {
    const provider = await assertOffered(this.providers, param);
    return this.links.verify(caller.userId, provider);
  }

  @Delete(':provider')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unlink the caller’s account and revoke it at the provider' })
  @ApiResponse({ status: 204 })
  async unlink(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('provider') param: string,
  ): Promise<void> {
    const provider = await assertOffered(this.providers, param);
    await this.links.unlink(caller.userId, provider);
  }
}
