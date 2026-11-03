import { syncListQuerySchema, syncOperationPageSchema, syncOperationSchema } from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/** Contracts § 3: one operation, a page of them, and the page query. */
@ApiZodSchema()
export class SyncOperationResponseDto extends createZodDto(syncOperationSchema) {}

@ApiZodSchema()
export class SyncOperationPageResponseDto extends createZodDto(syncOperationPageSchema) {}

@ApiZodSchema()
export class SyncListQueryDto extends createZodDto(syncListQuerySchema) {}
