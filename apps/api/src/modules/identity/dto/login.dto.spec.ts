import { loginRequestSchema } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { isZodDto } from '../../../common/validation/zod-dto';
import { LoginDto } from './login.dto';

describe('LoginDto', () => {
  /**
   * The pipe finds a schema through this predicate and validates nothing without one. A DTO that
   * stopped being recognised would not fail to compile and would not throw — every login body
   * would simply arrive unvalidated, which is the failure mode worth a test of its own.
   */
  it('is a shape the global validation pipe recognises', () => {
    expect(isZodDto(LoginDto)).toBe(true);
  });

  it('carries the schema the contract package publishes, not a local copy of it', () => {
    expect(LoginDto.zodSchema).toBe(loginRequestSchema);
  });

  /** A named subclass, because `design:paramtypes` serialises anything else to `Object`. */
  it('is a real class declaration, so Nest can see it in the parameter metadata', () => {
    expect(LoginDto.name).toBe('LoginDto');
  });
});
