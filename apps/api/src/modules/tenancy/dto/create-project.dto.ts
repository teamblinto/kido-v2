import { createProjectRequestSchema } from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/**
 * The body of `POST /orgs/:orgId/workspaces/:workspaceId/projects`, validated by the global `ZodValidationPipe`
 * from the schema `@repo/contracts` publishes (ADR 010).
 */
@ApiZodSchema()
export class CreateProjectDto extends createZodDto(createProjectRequestSchema) {}
