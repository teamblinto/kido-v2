import { personalAccountsPolicySchema } from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/** The body of `PUT /orgs/:orgId/settings/personal-accounts` (spec 032, contracts § 2). */
@ApiZodSchema()
export class PersonalAccountsPolicyDto extends createZodDto(personalAccountsPolicySchema) {}
