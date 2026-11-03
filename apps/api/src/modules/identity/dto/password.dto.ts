import {
  changePasswordRequestSchema,
  requestPasswordResetRequestSchema,
  resetPasswordRequestSchema,
} from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/**
 * The body of `POST /auth/password/change`, validated by the global `ZodValidationPipe` from the
 * schema `@repo/contracts` publishes (ADR 010).
 *
 * The two fields are held to deliberately different rules: the new password must clear the length
 * floor every chosen password clears, and the current one must not, because it may predate that
 * floor. `password.ts` in the contracts package argues that at length.
 */
@ApiZodSchema()
export class ChangePasswordDto extends createZodDto(changePasswordRequestSchema) {}

/**
 * The body of `POST /auth/password/reset`. One address, normalised exactly as signup normalises it,
 * so the two endpoints agree on which mailbox a spelling refers to before either reaches `citext`.
 */
@ApiZodSchema()
export class RequestPasswordResetDto extends createZodDto(requestPasswordResetRequestSchema) {}

/**
 * The body of `POST /auth/password/reset/confirm`.
 *
 * The token's schema bounds its length and asserts nothing else about its shape, for the reason
 * `verify.dto.ts` gives: a link a mail client wrapped has to come back under the `token-invalid`
 * slug, not as a `422` about a string.
 */
@ApiZodSchema()
export class ResetPasswordDto extends createZodDto(resetPasswordRequestSchema) {}
