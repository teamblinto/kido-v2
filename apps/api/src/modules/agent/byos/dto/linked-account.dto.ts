import { linkedAccountSchema } from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../../common/validation/zod-dto';

/** Contracts § 1: the label and dates — nothing of the grant. */
@ApiZodSchema()
export class LinkedAccountResponseDto extends createZodDto(linkedAccountSchema) {}
