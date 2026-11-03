import { changeMemberRoleRequestSchema } from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/** The body of `PATCH /orgs/:orgId/members/:userId`. One field, and it is a closed enum. */
@ApiZodSchema()
export class ChangeMemberRoleDto extends createZodDto(changeMemberRoleRequestSchema) {}
