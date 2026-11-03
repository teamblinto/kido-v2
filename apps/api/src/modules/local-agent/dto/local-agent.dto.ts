import {
  approvePairingRequestSchema,
  companionRunEventBatchSchema,
  companionStatusReportSchema,
  localAgentDeviceListSchema,
  pairingPreviewSchema,
  pairingTokenRequestSchema,
  runApprovalDecisionRequestSchema,
  startPairingRequestSchema,
  startPairingResponseSchema,
  subscriptionCodeRequestSchema,
  subscriptionListSchema,
  subscriptionStatusSchema,
} from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/** Spec 040 § 4's bodies, validated by the global `ZodValidationPipe`. */
@ApiZodSchema()
export class StartPairingDto extends createZodDto(startPairingRequestSchema) {}

@ApiZodSchema()
export class StartPairingResponseDto extends createZodDto(startPairingResponseSchema) {}

@ApiZodSchema()
export class PairingTokenDto extends createZodDto(pairingTokenRequestSchema) {}

@ApiZodSchema()
export class ApprovePairingDto extends createZodDto(approvePairingRequestSchema) {}

@ApiZodSchema()
export class PairingPreviewDto extends createZodDto(pairingPreviewSchema) {}

@ApiZodSchema()
export class LocalAgentDeviceListDto extends createZodDto(localAgentDeviceListSchema) {}

@ApiZodSchema()
export class CompanionStatusReportDto extends createZodDto(companionStatusReportSchema) {}

@ApiZodSchema()
export class CompanionRunEventBatchDto extends createZodDto(companionRunEventBatchSchema) {}

@ApiZodSchema()
export class RunApprovalDecisionDto extends createZodDto(runApprovalDecisionRequestSchema) {}

/** Spec 041: the cloud subscription agent's bodies. The code body is never logged (redaction). */
@ApiZodSchema()
export class SubscriptionCodeDto extends createZodDto(subscriptionCodeRequestSchema) {}

@ApiZodSchema()
export class SubscriptionStatusDto extends createZodDto(subscriptionStatusSchema) {}

@ApiZodSchema()
export class SubscriptionListDto extends createZodDto(subscriptionListSchema) {}
