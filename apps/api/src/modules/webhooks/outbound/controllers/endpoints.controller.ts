import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type {
  WebhookDeliverySummary,
  WebhookEndpoint,
  WebhookEndpointList,
  WebhookSecretResponse,
} from '@repo/contracts';

import { TenantContext } from '../../../../database/tenant-context';
import { CurrentUser } from '../../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../../identity/services/session.service';
import { RequirePermission } from '../../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../../rbac/resource-org.resolver';
import {
  CreateWebhookEndpointRequestDto,
  RotateWebhookSecretRequestDto,
  UpdateWebhookEndpointRequestDto,
  WebhookDeliverySummaryDto,
  WebhookEndpointDto,
  WebhookEndpointListDto,
  WebhookSecretResponseDto,
} from '../dto/endpoint.dto';
import { EndpointService } from '../endpoint.service';

/**
 * An organisation's outbound webhook endpoints (spec 029 US1, contracts/webhook-endpoints.md
 * § Routes). Every route is `org:webhooks.manage` (owner and admin), so a member without it gets
 * the guard's one `403` whether or not anything exists. Unknown and foreign ids are one `404`.
 * Rotate-secret is US5's; the delivery log is `DeliveriesController`'s.
 */
@ApiTags('webhooks')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/webhooks/endpoints', version: '1' })
export class EndpointsController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(EndpointService) private readonly endpoints: EndpointService,
  ) {}

  @Get()
  @RequirePermission('org:webhooks.manage')
  @ApiOperation({ summary: 'List the organisation’s webhook endpoints, newest first' })
  @ApiResponse({ status: 200, type: WebhookEndpointListDto })
  list(@Param('orgId') orgId: string): Promise<WebhookEndpointList> {
    return this.endpoints.list(this.tenant.tx, orgId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('org:webhooks.manage')
  @ApiOperation({ summary: 'Create a webhook endpoint; its signing secret is shown only here' })
  @ApiResponse({ status: 201, type: WebhookSecretResponseDto })
  @ApiResponse({
    description:
      'Invalid URL, destination not allowed, project not in the organisation, or the endpoint limit (`reason`).',
    status: 409,
  })
  create(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Body() body: CreateWebhookEndpointRequestDto,
  ): Promise<WebhookSecretResponse> {
    return this.endpoints.create(this.tenant.tx, orgId, caller.userId, body);
  }

  @Get(':endpointId')
  @RequirePermission('org:webhooks.manage')
  @ApiOperation({ summary: 'Read one webhook endpoint' })
  @ApiResponse({ status: 200, type: WebhookEndpointDto })
  read(
    @Param('orgId') orgId: string,
    @Param('endpointId') endpointId: string,
  ): Promise<WebhookEndpoint> {
    return this.endpoints.get(this.tenant.tx, orgId, endpointId);
  }

  @Patch(':endpointId')
  @RequirePermission('org:webhooks.manage')
  @ApiOperation({ summary: 'Change a webhook endpoint, or enable or disable it' })
  @ApiResponse({ status: 200, type: WebhookEndpointDto })
  @ApiResponse({
    description:
      'Invalid URL, destination not allowed, or project not in the organisation (`reason`).',
    status: 409,
  })
  update(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('endpointId') endpointId: string,
    @Body() body: UpdateWebhookEndpointRequestDto,
  ): Promise<WebhookEndpoint> {
    return this.endpoints.update(this.tenant.tx, orgId, caller.userId, endpointId, body);
  }

  @Delete(':endpointId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('org:webhooks.manage')
  @ApiOperation({ summary: 'Delete a webhook endpoint with its delivery log and secret' })
  @ApiResponse({ status: 204 })
  async remove(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('endpointId') endpointId: string,
  ): Promise<void> {
    await this.endpoints.delete(this.tenant.tx, orgId, caller.userId, endpointId);
  }

  @Post(':endpointId/rotate-secret')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('org:webhooks.manage')
  @ApiOperation({
    summary:
      'Rotate the signing secret; the new one is shown only here, the old one signs beside it for 24 h unless expired now',
  })
  @ApiResponse({ status: 200, type: WebhookSecretResponseDto })
  rotateSecret(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('endpointId') endpointId: string,
    @Body() body: RotateWebhookSecretRequestDto,
  ): Promise<WebhookSecretResponse> {
    return this.endpoints.rotateSecret(this.tenant.tx, orgId, caller.userId, endpointId, body);
  }

  @Post(':endpointId/test')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('org:webhooks.manage')
  @ApiOperation({ summary: 'Send a ping to an enabled webhook endpoint' })
  @ApiResponse({ status: 202, type: WebhookDeliverySummaryDto })
  @ApiResponse({ description: 'The endpoint is not enabled (`reason`).', status: 409 })
  test(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('endpointId') endpointId: string,
  ): Promise<WebhookDeliverySummary> {
    return this.endpoints.test(this.tenant.tx, orgId, caller.userId, endpointId);
  }
}
