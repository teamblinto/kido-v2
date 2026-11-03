import { createWorkspaceRequestSchema } from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/**
 * The body of `POST /orgs/:orgId/workspaces`, validated by the global `ZodValidationPipe`
 * from the schema `@repo/contracts` publishes (ADR 010).
 */
@ApiZodSchema()
export class CreateWorkspaceDto extends createZodDto(createWorkspaceRequestSchema) {}
