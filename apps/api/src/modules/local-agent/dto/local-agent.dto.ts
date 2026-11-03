import {
  companionRunEventBatchSchema,
  companionStatusReportSchema,
  subscriptionCodeRequestSchema,
  subscriptionListSchema,
  subscriptionStatusSchema,
} from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/** The hosted runner's uplink bodies (spec 040 § 4), validated by the global `ZodValidationPipe`. */
@ApiZodSchema()
export class CompanionStatusReportDto extends createZodDto(companionStatusReportSchema) {}

@ApiZodSchema()
export class CompanionRunEventBatchDto extends createZodDto(companionRunEventBatchSchema) {}

/** Spec 041: the cloud subscription agent's bodies. The code body is never logged (redaction). */
@ApiZodSchema()
export class SubscriptionCodeDto extends createZodDto(subscriptionCodeRequestSchema) {}

@ApiZodSchema()
export class SubscriptionStatusDto extends createZodDto(subscriptionStatusSchema) {}

@ApiZodSchema()
export class SubscriptionListDto extends createZodDto(subscriptionListSchema) {}
