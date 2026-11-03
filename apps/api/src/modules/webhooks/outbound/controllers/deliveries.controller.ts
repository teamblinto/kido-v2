import { Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { WebhookDelivery, WebhookDeliveryList, WebhookDeliverySummary } from '@repo/contracts';

import { TenantContext } from '../../../../database/tenant-context';
import { CurrentUser } from '../../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../../identity/services/session.service';
import { RequirePermission } from '../../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../../rbac/resource-org.resolver';
import { DeliveryLogService } from '../delivery-log.service';
import {
  WebhookDeliveryDto,
  WebhookDeliveryListDto,
  WebhookDeliveryListQueryDto,
} from '../dto/delivery.dto';
import { WebhookDeliverySummaryDto } from '../dto/endpoint.dto';

/**
 * An endpoint's delivery log (spec 029 US4, contracts/webhook-endpoints.md § Routes), nested under
 * its endpoint: a delivery id read through another endpoint, another org's, or an unknown one is
 * one `404`. Every route is `org:webhooks.manage`.
 */
@ApiTags('webhooks')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/webhooks/endpoints/:endpointId/deliveries', version: '1' })
export class DeliveriesController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(DeliveryLogService) private readonly deliveries: DeliveryLogService,
  ) {}

  @Get()
  @RequirePermission('org:webhooks.manage')
  @ApiOperation({ summary: 'List an endpoint’s deliveries of the last 30 days, newest first' })
  @ApiResponse({ status: 200, type: WebhookDeliveryListDto })
  list(
    @Param('orgId') orgId: string,
    @Param('endpointId') endpointId: string,
    @Query() query: WebhookDeliveryListQueryDto,
  ): Promise<WebhookDeliveryList> {
    return this.deliveries.list(this.tenant.tx, orgId, endpointId, query);
  }

  @Get(':deliveryId')
  @RequirePermission('org:webhooks.manage')
  @ApiOperation({ summary: 'Read one delivery with its body and attempts, newest first' })
  @ApiResponse({ status: 200, type: WebhookDeliveryDto })
  read(
    @Param('orgId') orgId: string,
    @Param('endpointId') endpointId: string,
    @Param('deliveryId') deliveryId: string,
  ): Promise<WebhookDelivery> {
    return this.deliveries.get(this.tenant.tx, orgId, endpointId, deliveryId);
  }

  @Post(':deliveryId/replay')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('org:webhooks.manage')
  @ApiOperation({ summary: 'Send a delivery once more, outside the retry schedule' })
  @ApiResponse({ status: 202, type: WebhookDeliverySummaryDto })
  @ApiResponse({
    description: 'The body has expired, or an attempt is in flight (`reason`).',
    status: 409,
  })
  replay(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('endpointId') endpointId: string,
    @Param('deliveryId') deliveryId: string,
  ): Promise<WebhookDeliverySummary> {
    return this.deliveries.replay(this.tenant.tx, orgId, caller.userId, endpointId, deliveryId);
  }
}
