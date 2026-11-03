import { presenceHeartbeatRequestSchema } from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/** The body of `PUT /orgs/:orgId/projects/:projectId/presence`: where the caller is. */
@ApiZodSchema()
export class PresenceHeartbeatDto extends createZodDto(presenceHeartbeatRequestSchema) {}
