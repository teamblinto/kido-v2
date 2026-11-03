import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hash, verify } from '@node-rs/argon2';

import type { Environment } from '../../../config/environment';

/**
 * A stored Argon2id digest. Branded, so the value that goes into `users.password_hash` cannot be
 * confused with the plaintext it came from, and so no DTO can take one by accident (§05).
 */
export type PasswordHash = string & { readonly __brand: 'PasswordHash' };

/** The cost parameters encoded in a stored hash's header. */
export interface Argon2Parameters {
  readonly memoryKib: number;
  readonly parallelism: number;
  readonly timeCost: number;
  readonly version: number;
}

export interface PasswordVerification {
  /**
   * A replacement hash at the configured parameters, or `null` when nothing needs storing. Set only
   * on a successful verification — it is a hash of the password that was just proven correct.
   */
  readonly rehashed: PasswordHash | null;
  readonly valid: boolean;
}

/**
 * The only place a password becomes a hash.
 *
 * §11 mandates Argon2id at 64 MB, t=3, p=1, and the environment schema refuses anything weaker on a
 * real deployment — so the numbers are read from configuration (a local suite may lower them for
 * speed) while the *floor* is enforced at boot rather than here.
 *
 * `verify` re-hashes on the spot when the stored header does not match the configuration, which is
 * what makes raising the cost a one-line change rather than a migration: every user's hash is
 * upgraded the next time they successfully sign in, and nobody else's is touched.
 */
@Injectable()
export class PasswordHasher {
  private readonly parameters: Argon2Parameters;

  // The token is named rather than inferred from emitted `design:paramtypes` metadata, so the class
  // resolves the same under any transpiler and the dependency is legible without decorator metadata.
  constructor(@Inject(ConfigService) config: ConfigService<Environment, true>) {
    this.parameters = {
      memoryKib: config.get('ARGON2_MEMORY_KIB', { infer: true }),
      parallelism: config.get('ARGON2_PARALLELISM', { infer: true }),
      timeCost: config.get('ARGON2_TIME_COST', { infer: true }),
      version: CURRENT_VERSION,
    };
  }

  async hash(password: string): Promise<PasswordHash> {
    return (await hash(password, {
      algorithm: ARGON2ID,
      memoryCost: this.parameters.memoryKib,
      parallelism: this.parameters.parallelism,
      timeCost: this.parameters.timeCost,
      version: VERSION_0X13,
    })) as PasswordHash;
  }

  /**
   * Verification never throws for a stored value it cannot use. A truncated column, an imported
   * bcrypt hash or an empty string all have to answer "no" the same way a wrong password does —
   * anything else turns a data problem into a 500 that confirms the account exists.
   */
  async verify(stored: string, password: string): Promise<PasswordVerification> {
    let valid: boolean;

    try {
      valid = await verify(stored, password);
    } catch {
      return { rehashed: null, valid: false };
    }

    if (!valid) {
      return { rehashed: null, valid: false };
    }

    return {
      rehashed: this.matchesConfiguration(stored) ? null : await this.hash(password),
      valid: true,
    };
  }

  /** Unreadable headers count as a mismatch: if we cannot prove it is current, it is upgraded. */
  private matchesConfiguration(stored: string): boolean {
    const parameters = argon2ParametersOf(stored);

    return (
      parameters !== null &&
      parameters.memoryKib === this.parameters.memoryKib &&
      parameters.parallelism === this.parameters.parallelism &&
      parameters.timeCost === this.parameters.timeCost &&
      parameters.version === this.parameters.version
    );
  }
}

/**
 * `Algorithm.Argon2id` and `Version.V0x13`, spelled as numbers.
 *
 * `@node-rs/argon2` declares both as ambient `const enum`s, which `isolatedModules` forbids reading
 * — the values would have to be inlined at compile time from a declaration file the emitter never
 * sees. They are pinned by assertion rather than by import: `hasher.spec.ts` reads the encoded hash
 * back and fails on anything that is not `$argon2id$v=19$`.
 */
const ARGON2ID = 2;
const VERSION_0X13 = 1;

/** Argon2 version 0x13 as it appears in the PHC header. Older is upgraded on the next sign-in. */
const CURRENT_VERSION = 19;

/**
 * The header of a PHC string, deliberately strict: `$argon2id$v=<n>$m=<n>,t=<n>,p=<n>$salt$digest`,
 * in that order, with a salt and a digest present.
 *
 * Strict because the only consequence of failing to parse is a rehash on the next successful
 * sign-in, which is safe and self-correcting — whereas a loose reader that mistakes an Argon2i hash
 * or a foreign parameter order for "already current" would leave it at those parameters forever.
 */
const PHC_ARGON2ID =
  /^\$argon2id\$v=(?<version>\d{1,3})\$m=(?<memory>\d{1,10}),t=(?<time>\d{1,10}),p=(?<parallelism>\d{1,3})\$[^$]+\$[^$]+$/;

export function argon2ParametersOf(encoded: string): Argon2Parameters | null {
  const groups = PHC_ARGON2ID.exec(encoded)?.groups;

  if (groups === undefined) {
    return null;
  }

  return {
    memoryKib: Number(groups.memory),
    parallelism: Number(groups.parallelism),
    timeCost: Number(groups.time),
    version: Number(groups.version),
  };
}
