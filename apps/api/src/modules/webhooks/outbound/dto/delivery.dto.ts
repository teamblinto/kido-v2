import {
  webhookDeliveryListQuerySchema,
  webhookDeliveryListSchema,
  webhookDeliverySchema,
} from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../../common/validation/zod-dto';

/**
 * contracts/webhook-endpoints.md § Shapes for the delivery log (US4): the list query (strict, so
 * an undeclared key is a `422`), one page, and one delivery with its attempts. Replay answers with
 * `WebhookDeliverySummaryDto`.
 */
@ApiZodSchema()
export class WebhookDeliveryListQueryDto extends createZodDto(webhookDeliveryListQuerySchema) {}

@ApiZodSchema()
export class WebhookDeliveryListDto extends createZodDto(webhookDeliveryListSchema) {}

@ApiZodSchema()
export class WebhookDeliveryDto extends createZodDto(webhookDeliverySchema) {}
