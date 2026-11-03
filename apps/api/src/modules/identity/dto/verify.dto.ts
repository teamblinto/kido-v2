import { resendVerificationRequestSchema, verifyEmailRequestSchema } from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/**
 * The body of `POST /auth/verify`, validated by the global `ZodValidationPipe` from the schema
 * `@repo/contracts` publishes (ADR 010).
 *
 * The schema bounds the token's length and asserts nothing else about its shape. A truncated link —
 * a mail client that wrapped a URL, a user who pasted half of one — has to reach the service and
 * come back under the `token-invalid` slug, not as a `422` about a string: they are the same
 * problem to the reader and only one of the two answers tells them what to do.
 */
@ApiZodSchema()
export class VerifyEmailDto extends createZodDto(verifyEmailRequestSchema) {}

/**
 * The body of `POST /auth/verify/resend`. One address, normalised exactly as signup normalises it,
 * so the two endpoints agree on which mailbox a spelling refers to before either reaches `citext`.
 */
@ApiZodSchema()
export class ResendVerificationDto extends createZodDto(resendVerificationRequestSchema) {}
