import { completeLinkPendingSchema, completeLinkRequestSchema } from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../../common/validation/zod-dto';

/** Contracts § 1: `{ state, code? , error? }` — strict, never both `code` and `error`. */
@ApiZodSchema()
export class CompleteLinkRequestDto extends createZodDto(completeLinkRequestSchema) {}

/** 202 while a device flow still waits on the person. */
@ApiZodSchema()
export class CompleteLinkPendingDto extends createZodDto(completeLinkPendingSchema) {}
