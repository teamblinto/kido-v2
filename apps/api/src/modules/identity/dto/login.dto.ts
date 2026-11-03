import { loginRequestSchema } from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/**
 * The body of `POST /auth/login`, validated by the global `ZodValidationPipe` from the schema
 * `@repo/contracts` publishes — so the client and the server are reading the same definition of
 * what a sign-in request is (ADR 010).
 */
@ApiZodSchema()
export class LoginDto extends createZodDto(loginRequestSchema) {}
