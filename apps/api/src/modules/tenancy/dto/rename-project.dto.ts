import { renameProjectRequestSchema } from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/**
 * The body of `PATCH /orgs/:orgId/workspaces/:workspaceId/projects/:projectId`, validated by the global `ZodValidationPipe`
 * from the schema `@repo/contracts` publishes (ADR 010).
 */
@ApiZodSchema()
export class RenameProjectDto extends createZodDto(renameProjectRequestSchema) {}
