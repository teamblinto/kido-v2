import { acceptProjectInvitationRequestSchema } from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/** Spec 031 (contracts/sharing.md). */
@ApiZodSchema()
export class AcceptProjectInvitationDto extends createZodDto(
  acceptProjectInvitationRequestSchema,
) {}
