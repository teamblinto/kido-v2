import { signupRequestSchema } from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/**
 * The body of `POST /auth/signup`, validated by the global `ZodValidationPipe` from the schema
 * `@repo/contracts` publishes (ADR 010).
 *
 * `strictObject` matters more here than on most endpoints: an `organisationName` accepted and
 * silently dropped would look exactly like a working feature to the client that sent it, and
 * signup creates no organisation (ADR 007).
 */
@ApiZodSchema()
export class SignupDto extends createZodDto(signupRequestSchema) {}
