import {
  confirmTotpEnrolmentRequestSchema,
  mfaChallengeRequestSchema,
  stepUpRequestSchema,
} from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/**
 * The body of `POST /auth/mfa/totp/confirm`, validated by the global `ZodValidationPipe` from the
 * schema `@repo/contracts` publishes (ADR 010).
 *
 * One field. The seed is deliberately not one of them: the enrolment being confirmed is the pending
 * one the server minted and is holding, and a body that could carry a seed would let a caller enrol
 * one somebody else already knows. `mfa.ts` in the contracts package argues that at length.
 */
@ApiZodSchema()
export class ConfirmTotpEnrolmentDto extends createZodDto(confirmTotpEnrolmentRequestSchema) {}

/**
 * The body of `POST /auth/mfa/challenge`.
 *
 * One field, and deliberately no account. Which user is being challenged comes from the
 * pending-MFA cookie the login leg set; a body that named one would let anybody holding a stolen
 * code complete somebody else's sign-in.
 */
@ApiZodSchema()
export class MfaChallengeDto extends createZodDto(mfaChallengeRequestSchema) {}

/** The body of `POST /auth/mfa/step-up`. Same single field, for the same reason. */
@ApiZodSchema()
export class StepUpDto extends createZodDto(stepUpRequestSchema) {}
