import { acceptInvitationRequestSchema } from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/**
 * The body of `POST /orgs/:orgId/invitations/accept`. The token only — the organisation is the route
 * parameter, because §11 derives it from the resource and never from a body field.
 */
@ApiZodSchema()
export class AcceptInvitationDto extends createZodDto(acceptInvitationRequestSchema) {}
