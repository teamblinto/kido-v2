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
  Put,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { LLM_PROVIDERS, type ProviderKey, type ProviderKeyList } from '@repo/contracts';

import { NotFoundError } from '../../../common/errors/domain-error';
import { TenantContext } from '../../../database/tenant-context';
import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import type { LlmProviderName } from '../llm-provider.port';
import {
  ProviderKeyListResponseDto,
  ProviderKeyResponseDto,
  PutProviderKeyRequestDto,
} from '../byok/dto/provider-key.dto';
import { toContract } from '../byok/provider-key.repository';
import { ProviderKeyService } from '../byok/provider-key.service';

/** `:provider` outside `LLM_PROVIDERS` is a path that does not exist (contracts § 1). */
function providerOf(param: string): LlmProviderName {
  if (!(LLM_PROVIDERS as readonly string[]).includes(param)) {
    throw new NotFoundError('No such provider.');
  }

  return param as LlmProviderName;
}

/**
 * An organisation's LLM provider keys (spec 020 US1/US4, contracts § 1): read for a member, store,
 * replace, remove and check for `org:connectors.manage`. Every response is the contract row — the
 * last four and the fingerprint, nothing else of the key (SC-002).
 */
@ApiTags('provider-keys')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/provider-keys', version: '1' })
export class ProviderKeyController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(ProviderKeyService) private readonly keys: ProviderKeyService,
  ) {}

  @Get()
  @RequirePermission('org:connectors.read')
  @ApiOperation({ summary: 'List the organisation’s provider keys' })
  @ApiResponse({ status: 200, type: ProviderKeyListResponseDto })
  async list(@Param('orgId') orgId: string): Promise<ProviderKeyList> {
    const rows = await this.keys.list(this.tenant.tx, orgId);

    return { keys: rows.map(toContract) };
  }

  @Put(':provider')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('org:connectors.manage')
  @ApiOperation({ summary: 'Store or replace the organisation’s key for a provider' })
  @ApiResponse({ status: 200, type: ProviderKeyResponseDto })
  @ApiResponse({ description: 'Wrong shape, or the provider rejected the key.', status: 422 })
  @ApiResponse({ description: 'The provider could not be reached to check it.', status: 503 })
  async put(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('provider') provider: string,
    @Body() body: PutProviderKeyRequestDto,
  ): Promise<ProviderKey> {
    const row = await this.keys.put(
      this.tenant.tx,
      orgId,
      caller.userId,
      providerOf(provider),
      body.apiKey,
    );

    return toContract(row);
  }

  @Delete(':provider')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('org:connectors.manage')
  @ApiOperation({ summary: 'Remove the organisation’s key for a provider' })
  @ApiResponse({ status: 204 })
  async remove(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('provider') provider: string,
  ): Promise<void> {
    await this.keys.remove(this.tenant.tx, orgId, caller.userId, providerOf(provider));
  }

  @Post(':provider/verify')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('org:connectors.manage')
  @ApiOperation({ summary: 'Check the key against the provider now and answer its state' })
  @ApiResponse({ status: 200, type: ProviderKeyResponseDto })
  async verify(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('provider') provider: string,
  ): Promise<ProviderKey> {
    const row = await this.keys.verify(this.tenant.tx, orgId, providerOf(provider), caller.userId);

    return toContract(row);
  }
}
