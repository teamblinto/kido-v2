import { Module } from '@nestjs/common';

import { BREACHED_PASSWORD_PORT } from './breached-password.port';
import { PasswordHasher } from './hasher';
import { HibpAdapter } from './hibp.adapter';
import { NewPasswordService } from './new-password';
import { PasswordStrengthPolicy } from './strength-policy';

/**
 * The password primitives, and the one place HIBP is named.
 *
 * Not `@Global`: signup, login, password change and reset are the only callers, and they all live
 * in the identity module that imports this one. A service that has no business hashing a password
 * should not be able to reach the hasher by accident.
 */
@Module({
  exports: [BREACHED_PASSWORD_PORT, NewPasswordService, PasswordHasher, PasswordStrengthPolicy],
  providers: [
    { provide: BREACHED_PASSWORD_PORT, useClass: HibpAdapter },
    NewPasswordService,
    PasswordHasher,
    PasswordStrengthPolicy,
  ],
})
export class PasswordModule {}
