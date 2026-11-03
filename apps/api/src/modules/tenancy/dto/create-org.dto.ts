import { createOrgRequestSchema } from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/**
 * The body of `POST /orgs`, validated by the global `ZodValidationPipe` from the schema
 * `@repo/contracts` publishes, so the client and the server read one definition of what creating an
 * organisation means (ADR 010).
 */
@ApiZodSchema()
export class CreateOrgDto extends createZodDto(createOrgRequestSchema) {}
