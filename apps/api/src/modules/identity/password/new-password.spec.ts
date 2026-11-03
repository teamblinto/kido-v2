import { ConfigModule } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { validateEnvironment } from '../../../config/environment';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
  BreachedPasswordError,
} from './breached-password.port';
import { PasswordHasher } from './hasher';
import { NewPasswordService } from './new-password';
import {
  PersonalInformationPasswordError,
  PasswordStrengthPolicy,
  WeakPasswordError,
} from './strength-policy';

vi.hoisted(() => {
  // The cheapest Argon2id the environment schema allows locally. This suite hashes on nearly every
  // test and is asserting the *order* of three checks, not the cost of the third.
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
});

const STRONG = 'thermos-quibble-tundra-vellum';

/** Driven rather than reached: the real adapter fails open on a network error (ADR 008). */
class ScriptedBreachPort implements BreachedPasswordPort {
  breached = false;
  calls = 0;

  isBreached(_password: string): Promise<boolean> {
    this.calls += 1;

    return Promise.resolve(this.breached);
  }
}

describe('NewPasswordService', () => {
  let moduleRef: TestingModule;
  let passwords: NewPasswordService;
  let breach: ScriptedBreachPort;
  let hasher: PasswordHasher;

  beforeAll(async () => {
    breach = new ScriptedBreachPort();
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          isGlobal: true,
          validate: validateEnvironment,
        }),
      ],
      providers: [
        { provide: BREACHED_PASSWORD_PORT, useValue: breach },
        NewPasswordService,
        PasswordHasher,
        PasswordStrengthPolicy,
      ],
    }).compile();

    passwords = moduleRef.get(NewPasswordService);
    hasher = moduleRef.get(PasswordHasher);
  });

  /**
   * The three §11 rejections and the hash, in one place, because password change and password reset
   * both apply them and two copies is two chances for one of them to drift.
   */
  describe('vet', () => {
    it('returns a hash that verifies against the password it was given', async () => {
      breach.breached = false;

      const stored = await passwords.vet(STRONG);

      await expect(hasher.verify(stored, STRONG)).resolves.toMatchObject({ valid: true });
    });

    it('returns a hash, never the password', async () => {
      breach.breached = false;

      await expect(passwords.vet(STRONG)).resolves.not.toContain(STRONG);
    });

    it('refuses a guessable password', async () => {
      breach.breached = false;

      await expect(passwords.vet('password123456')).rejects.toBeInstanceOf(WeakPasswordError);
    });

    it('refuses one that has appeared in a breach corpus', async () => {
      breach.breached = true;

      await expect(passwords.vet(STRONG)).rejects.toBeInstanceOf(BreachedPasswordError);

      breach.breached = false;
    });

    it('refuses one made mostly of the owner’s own address', async () => {
      breach.breached = false;

      await expect(passwords.vet('ada.lovelace', { email: 'ada.lovelace@example.com' })) //
        .rejects.toBeInstanceOf(PersonalInformationPasswordError);
    });

    /**
     * Order matters and is not cosmetic. The breach lookup is a network call to a third party, and
     * sending it a password we were always going to reject spends a round trip and hands a stranger
     * a prefix of a password nobody will use.
     */
    it('rejects a weak password without asking the breach corpus about it', async () => {
      breach.breached = false;
      const before = breach.calls;

      await expect(passwords.vet('password123456')).rejects.toBeInstanceOf(WeakPasswordError);

      expect(breach.calls).toBe(before);
    });

    /**
     * And the hash comes last. Argon2id at 64 MB is the most expensive thing in the request; hashing
     * a password that is about to be refused is that cost spent for nothing, on an endpoint an
     * attacker chooses the input to.
     */
    it('does not hash a password it is going to refuse', async () => {
      breach.breached = true;
      const hashing = vi.spyOn(hasher, 'hash');

      await expect(passwords.vet(STRONG)).rejects.toBeInstanceOf(BreachedPasswordError);

      expect(hashing).not.toHaveBeenCalled();

      hashing.mockRestore();
      breach.breached = false;
    });
  });
});
