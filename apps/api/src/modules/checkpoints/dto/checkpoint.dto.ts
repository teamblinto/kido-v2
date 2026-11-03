import {
  checkpointDiffResponseSchema,
  checkpointListQuerySchema,
  checkpointListResponseSchema,
  checkpointSchema,
} from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/** `GET …/checkpoints?cursor=&limit=`: the shared cursor page (contracts § 2). */
@ApiZodSchema()
export class CheckpointListQueryDto extends createZodDto(checkpointListQuerySchema) {}

@ApiZodSchema()
export class CheckpointListResponseDto extends createZodDto(checkpointListResponseSchema) {}

@ApiZodSchema()
export class CheckpointResponseDto extends createZodDto(checkpointSchema) {}

@ApiZodSchema()
export class CheckpointDiffResponseDto extends createZodDto(checkpointDiffResponseSchema) {}
