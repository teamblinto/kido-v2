import { createRunRequestSchema } from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/** The body of `POST /orgs/:orgId/projects/:projectId/runs`, validated by the global `ZodValidationPipe`. */
@ApiZodSchema()
export class CreateRunDto extends createZodDto(createRunRequestSchema) {}
