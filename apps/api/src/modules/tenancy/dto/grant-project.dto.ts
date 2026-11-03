import { grantProjectRequestSchema } from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/** The body of `PUT /orgs/:orgId/projects/:projectId/grants/:userId`. One field, a closed enum. */
@ApiZodSchema()
export class GrantProjectDto extends createZodDto(grantProjectRequestSchema) {}
