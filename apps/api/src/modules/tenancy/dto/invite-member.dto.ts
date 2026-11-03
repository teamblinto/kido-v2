import { inviteMemberRequestSchema } from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/** The body of `POST /orgs/:orgId/invitations` — an address and a role, both normalised at the edge. */
@ApiZodSchema()
export class InviteMemberDto extends createZodDto(inviteMemberRequestSchema) {}
