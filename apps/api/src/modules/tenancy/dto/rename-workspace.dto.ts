import { renameWorkspaceRequestSchema } from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/**
 * The body of `PATCH /orgs/:orgId/workspaces/:workspaceId`, validated by the global `ZodValidationPipe`
 * from the schema `@repo/contracts` publishes (ADR 010).
 */
@ApiZodSchema()
export class RenameWorkspaceDto extends createZodDto(renameWorkspaceRequestSchema) {}
