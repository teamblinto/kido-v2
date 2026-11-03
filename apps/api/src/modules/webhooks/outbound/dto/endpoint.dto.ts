import {
  createWebhookEndpointRequestSchema,
  rotateWebhookSecretRequestSchema,
  updateWebhookEndpointRequestSchema,
  webhookDeliverySummarySchema,
  webhookEndpointListSchema,
  webhookEndpointSchema,
  webhookSecretResponseSchema,
} from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../../common/validation/zod-dto';

/**
 * contracts/webhook-endpoints.md § Shapes: the three request bodies (strict — an undeclared key is a
 * `422` from the application-wide pipe) and the four response bodies of US1.
 */
@ApiZodSchema()
export class CreateWebhookEndpointRequestDto extends createZodDto(
  createWebhookEndpointRequestSchema,
) {}

@ApiZodSchema()
export class UpdateWebhookEndpointRequestDto extends createZodDto(
  updateWebhookEndpointRequestSchema,
) {}

@ApiZodSchema()
export class RotateWebhookSecretRequestDto extends createZodDto(rotateWebhookSecretRequestSchema) {}

@ApiZodSchema()
export class WebhookEndpointDto extends createZodDto(webhookEndpointSchema) {}

@ApiZodSchema()
export class WebhookEndpointListDto extends createZodDto(webhookEndpointListSchema) {}

@ApiZodSchema()
export class WebhookSecretResponseDto extends createZodDto(webhookSecretResponseSchema) {}

@ApiZodSchema()
export class WebhookDeliverySummaryDto extends createZodDto(webhookDeliverySummarySchema) {}
