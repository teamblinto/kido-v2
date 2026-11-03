import { Inject, Injectable } from '@nestjs/common';

import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
  BreachedPasswordError,
} from './breached-password.port';
import { type PasswordHash, PasswordHasher } from './hasher';
import { type PasswordOwner, PasswordStrengthPolicy } from './strength-policy';

/**
 * "This password is acceptable, and here is what to store for it" — the three §11 rejections and the
 * Argon2id hash, in the order they have to run.
 *
 * Extracted because T19 has two callers for it. `PasswordChangeService` and `PasswordResetService`
 * both take a password a user has just chosen and both must apply the same policy signup applies;
 * two copies of "assert, check, hash" is two places for one of the three to be dropped, and the one
 * that gets dropped is invisible — the endpoint keeps working and simply stops refusing.
 *
 * The order is the part with teeth, and both of its steps are asserted in `new-password.spec.ts`:
 *
 * - **Strength before the corpus.** The breach lookup is a network call to a third party, and
 *   sending it a password that was never going to be accepted spends a round trip and hands a
 *   stranger the prefix of a hash nobody will use.
 * - **The corpus before the hash.** Argon2id at 64 MB dominates the request. Hashing a password that
 *   is about to be refused is that cost spent for nothing, on input an attacker chooses.
 *
 * `SignupService` deliberately still runs its own copy of the same three steps. Its ordering is
 * load-bearing for a different reason — the policy has to run *before* the address is looked up, or
 * a weak password could not be refused without saying whether the address was taken — and the
 * comments there argue it at length. Folding it into this class would move that argument away from
 * the code it constrains.
 */
@Injectable()
export class NewPasswordService {
  constructor(
    @Inject(BREACHED_PASSWORD_PORT) private readonly breached: BreachedPasswordPort,
    private readonly hasher: PasswordHasher,
    private readonly strength: PasswordStrengthPolicy,
  ) {}

  /**
   * @param owner what the account is known by, so a password made of it can be refused. Omitted by
   * callers that genuinely do not know — never guessed, because a wrong owner makes the personal
   * information rule silently check nothing.
   * @throws {WeakPasswordError} below the zxcvbn floor.
   * @throws {PersonalInformationPasswordError} mostly the owner's own name or address.
   * @throws {BreachedPasswordError} present in the k-anonymity corpus.
   */
  async vet(password: string, owner: PasswordOwner = {}): Promise<PasswordHash> {
    this.strength.assert(password, owner);

    if (await this.breached.isBreached(password)) {
      throw new BreachedPasswordError();
    }

    return this.hasher.hash(password);
  }
}
