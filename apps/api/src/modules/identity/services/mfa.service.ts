import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RECOVERY_CODE_COUNT } from '@repo/contracts';
import { schema } from '@repo/db';
import { and, eq, isNull } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { randomInt } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { AccountSecretService } from '../../../common/crypto/account-secret';
import { type Plaintext, plaintext, revealPlaintext } from '../../../common/crypto/branded';
import { ConflictError, DomainError, NotFoundError } from '../../../common/errors/domain-error';
import { SESSION_REDIS } from '../../../common/redis/redis.constants';
import type { Environment } from '../../../config/environment';
import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase } from '../../../database/database.types';
import { PasswordHasher } from '../password/hasher';
import { type IssuedSession, SessionService, sessionKey } from './session.service';

/**
 * The `purpose` half of the AAD every MFA seed is sealed under (T08, ADR 003). A ciphertext
 * re-labelled as any other kind of secret fails to open, and so does one moved to another account.
 */
export const MFA_SEED_PURPOSE = 'mfa_seed';

/** Session ids are `uuid` everywhere in the schema, so anything else is a bug, not a user. */
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The field on the session hash counting wrong codes against one challenge.
 *
 * On the session rather than in a bucket of its own, so it expires exactly when the challenge does
 * and there is nothing left to sweep up. It never reaches a full session: only the challenge path
 * writes it, and promotion rotates the hash away from it.
 */
const CHALLENGE_ATTEMPTS_FIELD = 'mfaAttempts';

/** 160 bits, which is RFC 4226 §4's floor and what every authenticator app expects. */
const SEED_BYTES = 20;

/** SHA-1, because that is what RFC 6238 specifies and what every authenticator app implements. */
const TOTP_ALGORITHM = 'SHA1';

/**
 * The alphabet a recovery code is drawn from: Crockford's base32 minus nothing it already omits.
 *
 * `I`, `L`, `O` and `U` are absent — the first three because they are unreadable next to `1` and
 * `0` on a printout somebody will photograph, and `U` because excluding it keeps the set from
 * spelling anything. Thirty-two symbols is five bits each, so the length below is exact.
 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';

/**
 * Ten symbols, fifty bits, written as two groups of five.
 *
 * Fifty bits is far past guessing at any rate a network allows, and the grouping is for the human:
 * these are read off a printout and typed by hand, and an unbroken run of ten is where transcription
 * errors live. The separator is cosmetic — {@link normaliseCode} removes it before anything compares.
 */
const RECOVERY_CODE_SYMBOLS = 10;
const RECOVERY_GROUP = 5;

/** Which of the two things a caller presented turned out to be the one that worked. */
export type MfaFactor = 'recovery' | 'totp';

/** What beginning an enrolment hands back — the URI, and deliberately nothing else. */
export interface PendingEnrolment {
  readonly otpauthUri: string;
}

/** What confirming one hands back, once, and never again. */
export interface ConfirmedEnrolment {
  readonly recoveryCodes: readonly string[];
}

/**
 * What completing a login challenge hands back: the rotated cookie, and the account.
 *
 * Deliberately the same shape `LoginService` answers a passwordy sign-in with, so the controller
 * has one success body to build and a client has one success shape to parse.
 */
export interface ChallengeCompleted {
  readonly session: IssuedSession;
  readonly user: {
    readonly email: string;
    readonly emailVerified: boolean;
    readonly id: string;
    readonly mfaEnabled: boolean;
  };
}

/**
 * The challenge was not answered — no pending session, a wrong code, or one too many wrong codes.
 *
 * One error for all three, and a plain `unauthorized` rather than the `mfa-code-incorrect` a
 * signed-in caller gets. Nobody is signed in at this point: the caller has presented a password and
 * a code, and telling them which of the two was wrong is the oracle `InvalidCredentialsError`
 * exists to withhold on the leg before this one.
 */
export class InvalidChallengeError extends DomainError {
  constructor() {
    super('unauthorized', 'That code is not valid, or the sign-in has expired. Start again.');
  }
}

/**
 * The second factor was presented and was wrong, on a route whose caller is already signed in.
 *
 * A `403` refinement rather than a `401`, for the reason `problem-types.ts` gives about
 * `current-password-incorrect`: the session is perfectly good and the client must not react by
 * signing the user out. What failed is the second proof, and the remedy is to type it again.
 *
 * The login challenge does *not* use this — see {@link MfaService.verify}'s callers in T21, which
 * answer with the same generic `unauthorized` a wrong password answers with, because at that point
 * distinguishing "wrong code" from "wrong password" would be an oracle rather than a courtesy.
 */
export class IncorrectMfaCodeError extends DomainError {
  constructor() {
    super('mfa-code-incorrect', 'That code is not valid for this account.');
  }
}

/**
 * Where a scanned-but-unconfirmed enrolment waits.
 *
 * In the session Redis role rather than in Postgres, and deliberately: the value is short-lived,
 * belongs to no committed state, and must vanish on its own if the user closes the tab. Putting it
 * on `users` would mean a column whose only job is to be null, plus a sweeper for the rows where it
 * is not.
 *
 * Namespaced away from `s:` and `u:` — the keys `session.service.ts` owns — so a pending enrolment
 * can never be read as a session or counted as a device. The user id is validated for the reason
 * `sessionIndexKey` validates it: a key assembled from an unchecked string is a key an attacker
 * chooses.
 */
export function pendingEnrolmentKey(userId: string): string {
  if (!USER_ID.test(userId)) {
    throw new TypeError(
      `invalid pending enrolment key: user id ${JSON.stringify(userId)} is not a uuid`,
    );
  }

  return `mfa:enrol:${userId}`;
}

/**
 * TOTP enrolment, the drift window, and the one-time recovery codes (§11, criterion 8).
 *
 * Three properties are structural rather than conventional:
 *
 * **Enrolment is inert until it is confirmed.** `beginEnrolment` writes nothing to `users`. It
 * mints a seed, seals it, and parks the ciphertext in the session store under a TTL; only
 * `confirmEnrolment`, holding a code that seed produced, copies it into `users.mfa_secret_enc`. The
 * failure this prevents is the common one and the worst one: a user photographs a QR code their
 * camera read badly, the account requires a factor they cannot produce, and the only way back in is
 * a support ticket.
 *
 * **The seed is never legible except in the provisioning URI.** RFC 6238 has no other way to move a
 * shared secret onto a phone, so that one rendering is unavoidable — and it is the whole of the
 * exposure. The seed is not returned again, not logged at any level, not put on a DTO, and at rest
 * it is envelope ciphertext bound to this account and to the purpose `mfa_seed`.
 *
 * **Time comes from {@link ClockPort}.** There is no `new Date()` here, which is what lets
 * `mfa.service.spec.ts` prove the drift window from both sides instead of asserting a tolerance.
 *
 * ## What is deliberately not here
 *
 * A used-code cache. RFC 6238 §5.2 recommends refusing a code that has already been accepted within
 * its window, and this does not: a code stays valid for its whole window even after it is used.
 * Doing it properly needs a per-account, per-counter marker in Redis with the same TTL as the
 * window, and neither §11 nor spec 001 asks for one. Recorded rather than silently skipped — the
 * exposure is that an attacker who reads a code over somebody's shoulder has the rest of the window
 * to use it, which is the same exposure as reading the phone itself.
 */
@Injectable()
export class MfaService {
  private readonly digits: number;
  private readonly driftSteps: number;
  private readonly enrolmentTtlSeconds: number;
  private readonly issuer: string;
  private readonly logger = new Logger(MfaService.name);
  private readonly maxChallengeAttempts: number;
  private readonly periodSeconds: number;

  constructor(
    @Inject(APP_DATABASE) private readonly database: ForgeDatabase,
    @Inject(SESSION_REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly accountSecrets: AccountSecretService,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionService,
    config: ConfigService<Environment, true>,
  ) {
    this.maxChallengeAttempts = config.get('MFA_CHALLENGE_MAX_ATTEMPTS', { infer: true });
    this.digits = config.get('MFA_TOTP_DIGITS', { infer: true });
    this.driftSteps = config.get('MFA_TOTP_DRIFT_STEPS', { infer: true });
    this.enrolmentTtlSeconds = config.get('MFA_ENROLMENT_TTL_SECONDS', { infer: true });
    this.issuer = config.get('MFA_ISSUER', { infer: true });
    this.periodSeconds = config.get('MFA_TOTP_PERIOD_SECONDS', { infer: true });
  }

  /**
   * Mint a seed and hand back the URI a QR code is rendered from. Changes nothing about the account.
   *
   * Calling it again replaces the pending enrolment rather than refusing. Scanning onto the wrong
   * phone is the ordinary way this goes wrong, and "start over" has to be a button rather than a
   * support ticket; the previous seed stops being claimable the moment this returns, which is what
   * the spec asserts.
   */
  async beginEnrolment(userId: string): Promise<PendingEnrolment> {
    const user = await this.accountFor(userId);

    if (user.mfaSecretEnc !== null) {
      throw new ConflictError(
        'This account already has an authenticator app enrolled. Remove it before enrolling another.',
      );
    }

    const seed = new Secret({ size: SEED_BYTES });
    const sealed = await this.accountSecrets.seal(
      { purpose: MFA_SEED_PURPOSE, userId },
      plaintext(seed.base32),
    );

    await this.redis.set(pendingEnrolmentKey(userId), sealed, 'EX', this.enrolmentTtlSeconds);

    this.logger.log(`MFA enrolment started [user=${userId}]`);

    return { otpauthUri: this.totpFor(seed, user.email).toString() };
  }

  /**
   * Make a pending enrolment real, and issue the ten codes that are the way back in when the phone
   * is not.
   *
   * The ciphertext moved into `users.mfa_secret_enc` is the *same* ciphertext that was parked — not
   * a re-seal. It is already bound to this account and this purpose, so re-sealing would buy nothing
   * and would put the seed through one more plaintext round trip than the flow requires.
   */
  async confirmEnrolment(userId: string, code: string): Promise<ConfirmedEnrolment> {
    const sealed = await this.redis.getBuffer(pendingEnrolmentKey(userId));

    if (sealed === null) {
      throw new ConflictError(
        'There is no enrolment waiting to be confirmed. Start again to get a fresh QR code.',
      );
    }

    const seed = await this.unseal(userId, sealed);

    if (!this.matchesTotp(seed, code)) {
      // The pending seed is left in place. A wrong code here is a typo or a phone whose clock has
      // drifted past the window, and throwing the enrolment away would make the user rescan.
      this.logger.warn(`MFA enrolment refused: wrong confirming code [user=${userId}]`);

      throw new IncorrectMfaCodeError();
    }

    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());

    await this.database.transaction(async (tx) => {
      await tx
        .update(schema.users)
        .set({ mfaSecretEnc: sealed })
        .where(eq(schema.users.id, userId));
      await tx.delete(schema.mfaRecoveryCodes).where(eq(schema.mfaRecoveryCodes.userId, userId));
      await tx.insert(schema.mfaRecoveryCodes).values(
        await Promise.all(
          codes.map(async (recovery) => ({
            codeHash: await this.hasher.hash(normaliseCode(recovery)),
            userId,
          })),
        ),
      );
    });

    await this.redis.del(pendingEnrolmentKey(userId));

    this.logger.log(`MFA enrolled [user=${userId} recovery_codes=${codes.length}]`);

    // The only time these leave this process. Returned rather than stored anywhere readable, and
    // the caller's one job is to render them and forget them.
    return { recoveryCodes: codes };
  }

  /**
   * Answer the challenge a sign-in stopped at, and turn the half-authenticated session into a real
   * one (criterion 4).
   *
   * The account is read from the pending session rather than from anything the caller sent, which
   * is the whole reason `mfaChallengeRequestSchema` has no `userId`: a body that named an account
   * would let anyone holding one stolen code complete somebody else's challenge.
   *
   * Every refusal is the same {@link InvalidChallengeError}. A caller at this point has presented a
   * password and a code, and a response that told "wrong code" from "that sign-in expired" from
   * "there is no challenge" would sort those states for whoever is guessing at them.
   */
  async completeChallenge(token: string, code: string): Promise<ChallengeCompleted> {
    const pending = await this.sessions.authenticate(token);

    if (pending?.pendingMfa !== true) {
      throw new InvalidChallengeError();
    }

    const factor = await this.verify(pending.userId, code);

    if (factor === null) {
      await this.chargeFailedAttempt(token, pending.sessionId, pending.userId);

      throw new InvalidChallengeError();
    }

    // Rotation is inside `completeMfa`, and it is what makes this a privilege change rather than a
    // flag flip: the identifier the challenge was answered on is retired here (§11, criterion 5).
    const promoted = await this.sessions.completeMfa(token);

    if (promoted === null) {
      // The session went between the read above and this line — revoked from another device, or a
      // second request answering the same challenge and getting there first. Either way this
      // request did not promote it, and must not pretend it did.
      throw new InvalidChallengeError();
    }

    const user = await this.accountFor(pending.userId);

    this.logger.log(`MFA challenge completed [user=${pending.userId} factor=${factor}]`);

    return {
      session: promoted,
      user: {
        email: user.email,
        emailVerified: user.emailVerifiedAt !== null,
        id: pending.userId,
        // A literal: `verify` just accepted a factor, and there is no factor to accept on an
        // account whose seed is null.
        mfaEnabled: true,
      },
    };
  }

  /**
   * Re-prove a second factor on a session that is already signed in (criterion 12).
   *
   * Keyed by the session hash the guard resolved, so the stamp lands on *this* device and not on
   * the account: a step-up performed on a laptop must not authorise a sensitive change somebody is
   * attempting from a phone.
   */
  async stepUp(sessionId: string, userId: string, code: string): Promise<void> {
    const factor = await this.verify(userId, code);

    if (factor === null) {
      this.logger.warn(`Step-up refused: wrong code [user=${userId}]`);

      throw new IncorrectMfaCodeError();
    }

    await this.sessions.recordStepUp(sessionId);

    this.logger.log(`Stepped up [user=${userId} factor=${factor}]`);
  }

  /** Whether the account has a live second factor — what the login leg branches on (criterion 4). */
  async isEnrolled(userId: string): Promise<boolean> {
    const [user] = await this.database
      .select({ mfaSecretEnc: schema.users.mfaSecretEnc })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    return user?.mfaSecretEnc != null;
  }

  /**
   * Check a presented second factor, and spend it if it was a recovery code.
   *
   * Answers `null` for every way of being wrong — a bad code, an account with no MFA, an account
   * that does not exist — because the caller must not turn the difference into a response. Throwing
   * a distinguishable error here would put "this address has MFA" behind a wrong guess, which is
   * exactly what the enumeration-safe login leg withholds.
   *
   * TOTP is tried first and the recovery codes are only reached when the presented value is not
   * shaped like a TOTP code. That ordering is what bounds the work: a wrong six-digit guess costs
   * one HMAC across the window rather than ten Argon2id verifications at 64 MB. It leaks only the
   * shape of what the caller typed, which the caller already knows.
   */
  async verify(userId: string, presented: string): Promise<MfaFactor | null> {
    const [user] = await this.database
      .select({ mfaSecretEnc: schema.users.mfaSecretEnc })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (user?.mfaSecretEnc == null) {
      return null;
    }

    if (this.looksLikeTotp(presented)) {
      const seed = await this.unseal(userId, user.mfaSecretEnc);

      return this.matchesTotp(seed, presented) ? 'totp' : null;
    }

    return (await this.claimRecoveryCode(userId, presented)) ? 'recovery' : null;
  }

  /**
   * Turn MFA off: the seed and every recovery code go together (criterion 12's subject).
   *
   * In one transaction, and the codes go with the seed rather than being left as history. A code
   * that survived removal is a second factor nobody remembers exists, and it would be honoured by
   * the next enrolment's lookup — which is a login that succeeds on a credential the user believes
   * they destroyed.
   */
  async disable(userId: string): Promise<void> {
    const user = await this.accountFor(userId);

    if (user.mfaSecretEnc === null) {
      throw new ConflictError('This account does not have an authenticator app enrolled.');
    }

    await this.database.transaction(async (tx) => {
      await tx.update(schema.users).set({ mfaSecretEnc: null }).where(eq(schema.users.id, userId));
      await tx.delete(schema.mfaRecoveryCodes).where(eq(schema.mfaRecoveryCodes.userId, userId));
    });

    await this.redis.del(pendingEnrolmentKey(userId));

    this.logger.log(`MFA removed [user=${userId}]`);
  }

  /**
   * Count one wrong code against the challenge, and throw the challenge away once the budget is
   * spent.
   *
   * The counter lives on the session hash rather than in a bucket of its own, so it dies exactly
   * when the challenge does and there is nothing to clean up. `HINCRBY` rather than read-then-write
   * because concurrent guesses are precisely the case this bounds — two requests that each read
   * "two so far" and each wrote "three" would give an attacker a free attempt per parallel
   * connection.
   *
   * Revoking rather than merely refusing is what makes the bound real: with the pending session
   * gone, the next attempt has no challenge to answer and the caller has to present the password
   * again, which is itself throttled per account and per IP (T16).
   */
  private async chargeFailedAttempt(
    token: string,
    sessionId: string,
    userId: string,
  ): Promise<void> {
    const attempts = await this.redis.hincrby(sessionKey(sessionId), CHALLENGE_ATTEMPTS_FIELD, 1);

    if (attempts < this.maxChallengeAttempts) {
      return;
    }

    this.logger.warn(`MFA challenge abandoned after ${attempts} wrong codes [user=${userId}]`);

    await this.sessions.revoke(token);
  }

  private async accountFor(userId: string) {
    const [user] = await this.database
      .select({
        email: schema.users.email,
        emailVerifiedAt: schema.users.emailVerifiedAt,
        mfaSecretEnc: schema.users.mfaSecretEnc,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (user === undefined) {
      // Reachable only when an account is deleted while one of its sessions is still live.
      throw new NotFoundError('That account no longer exists.');
    }

    return user;
  }

  /**
   * Spend one recovery code, or answer that none matched.
   *
   * Single use survives a race because it is one `update` guarded by `consumed_at is null`, exactly
   * as `token.service.ts` requires of the three token tables: two requests presenting the same code
   * at the same moment are two updates against that predicate, and one of them matches no row. A
   * read-then-write would let both through, and the window is as wide as a double-clicked button.
   *
   * `user_id` is in both the select and the update. These rows carry no `org_id` and take no RLS
   * policy (ADR 015), so the predicate is the whole of the isolation: without it the question would
   * be "is this anybody's recovery code", and one leaked code would be a key to every account.
   */
  private async claimRecoveryCode(userId: string, presented: string): Promise<boolean> {
    const candidate = normaliseCode(presented);

    if (candidate.length === 0) {
      return false;
    }

    const live = await this.database
      .select({ codeHash: schema.mfaRecoveryCodes.codeHash, id: schema.mfaRecoveryCodes.id })
      .from(schema.mfaRecoveryCodes)
      .where(
        and(eq(schema.mfaRecoveryCodes.userId, userId), isNull(schema.mfaRecoveryCodes.consumedAt)),
      );

    for (const row of live) {
      const { valid } = await this.hasher.verify(row.codeHash, candidate);

      if (!valid) {
        continue;
      }

      const claimed = await this.database
        .update(schema.mfaRecoveryCodes)
        .set({ consumedAt: this.clock.now() })
        .where(
          and(
            eq(schema.mfaRecoveryCodes.id, row.id),
            eq(schema.mfaRecoveryCodes.userId, userId),
            isNull(schema.mfaRecoveryCodes.consumedAt),
          ),
        )
        .returning({ id: schema.mfaRecoveryCodes.id });

      if (claimed.length > 0) {
        // The count, never the code. An operator reading this during an incident needs to know the
        // account is running low, and nothing else in the line would be safe to write down.
        this.logger.log(`Recovery code spent [user=${userId} remaining=${live.length - 1}]`);

        return true;
      }

      // Claimed by a concurrent request between the read and the update. The code is spent either
      // way, and this request is not the one that spent it.
      return false;
    }

    return false;
  }

  /**
   * Whether a presented value has the shape of a TOTP code rather than a recovery code.
   *
   * The two cannot collide: a recovery code is {@link RECOVERY_CODE_SYMBOLS} symbols long and a TOTP
   * code is {@link MfaService.digits}, and the environment schema bounds the second at ten while the
   * first is exactly ten — so a same-length pair would have to be all digits, which
   * {@link RECOVERY_ALPHABET} makes a one-in-a-billion draw rather than an impossibility. Even then
   * the fallback below would simply refuse it, which is the safe direction.
   */
  private looksLikeTotp(presented: string): boolean {
    const digits = presented.replaceAll(/\s/gu, '');

    return digits.length === this.digits && /^\d+$/u.test(digits);
  }

  private matchesTotp(seed: Secret, presented: string): boolean {
    return (
      TOTP.validate({
        algorithm: TOTP_ALGORITHM,
        digits: this.digits,
        period: this.periodSeconds,
        secret: seed,
        // The one source of "now" (§11's no `new Date()` in a service). `otpauth` would otherwise
        // read the host clock, and the drift window would be untestable without sleeping.
        timestamp: this.clock.now().getTime(),
        token: presented.replaceAll(/\s/gu, ''),
        window: this.driftSteps,
      }) !== null
    );
  }

  private totpFor(seed: Secret, label: string): TOTP {
    return new TOTP({
      algorithm: TOTP_ALGORITHM,
      digits: this.digits,
      issuer: this.issuer,
      label,
      period: this.periodSeconds,
      secret: seed,
    });
  }

  /** The seed, back out of the envelope. The only place a stored seed becomes readable. */
  private async unseal(userId: string, sealed: Buffer): Promise<Secret> {
    const opened: Plaintext = await this.accountSecrets.open(
      { purpose: MFA_SEED_PURPOSE, userId },
      sealed,
    );

    return Secret.fromBase32(revealPlaintext(opened).toString('utf8'));
  }
}

/**
 * What a user types, reduced to what is compared.
 *
 * Uppercased and stripped of everything outside the alphabet, so the separator we printed, the
 * spaces a paste carried and the lower case a keyboard was in all reach the hasher as the same
 * value. Normalising on the way *in* as well as on the way out is what makes that true — the stored
 * digest is of the normalised form, so there is one canonical spelling and no second one to forget.
 */
function normaliseCode(presented: string): string {
  return presented.toUpperCase().replaceAll(new RegExp(`[^${RECOVERY_ALPHABET}]`, 'gu'), '');
}

/**
 * One recovery code, from the CSPRNG.
 *
 * `randomInt` rather than `randomBytes(1) % 32`: the modulo is uniform only because the alphabet
 * happens to be a power of two, and the next person to shorten the alphabet would introduce a bias
 * that no test would catch.
 */
function generateRecoveryCode(): string {
  const symbols = Array.from(
    { length: RECOVERY_CODE_SYMBOLS },
    () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]!,
  ).join('');

  return `${symbols.slice(0, RECOVERY_GROUP)}-${symbols.slice(RECOVERY_GROUP)}`;
}
