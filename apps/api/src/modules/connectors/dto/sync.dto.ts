import {
  syncCommitRequestSchema,
  syncCommitResponseSchema,
  syncListQuerySchema,
  syncOperationPageSchema,
  syncOperationSchema,
} from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/** Contracts § 3: one operation, a page of them, and the page query. */
@ApiZodSchema()
export class SyncOperationResponseDto extends createZodDto(syncOperationSchema) {}

@ApiZodSchema()
export class SyncOperationPageResponseDto extends createZodDto(syncOperationPageSchema) {}

@ApiZodSchema()
export class SyncListQueryDto extends createZodDto(syncListQuerySchema) {}

/** Spec 044: the one-click commit and push. */
@ApiZodSchema()
export class SyncCommitRequestDto extends createZodDto(syncCommitRequestSchema) {}

@ApiZodSchema()
export class SyncCommitResponseDto extends createZodDto(syncCommitResponseSchema) {}
