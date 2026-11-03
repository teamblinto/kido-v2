import { linkedAccountListSchema } from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../../common/validation/zod-dto';

/** `GET /me/linked-accounts`: what is offered, and the caller's own accounts. */
@ApiZodSchema()
export class LinkedAccountListResponseDto extends createZodDto(linkedAccountListSchema) {}
