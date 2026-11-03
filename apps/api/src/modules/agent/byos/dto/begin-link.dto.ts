import { beginLinkResponseSchema } from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../../common/validation/zod-dto';

const [redirect, device] = beginLinkResponseSchema.options;

/** Contracts § 1, `begin`'s redirect variant: the provider's authorise URL. */
@ApiZodSchema()
export class BeginRedirectLinkDto extends createZodDto(redirect) {}

/** Contracts § 1, `begin`'s device variant: the user code, and the state to poll `complete` by. */
@ApiZodSchema()
export class BeginDeviceLinkDto extends createZodDto(device) {}
