import type { OnModuleInit } from '@nestjs/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { schema } from '@repo/db';
import { eq } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';

import { DomainError, RateLimitedError } from '../../../common/errors/domain-error';
import type { ThrottlePolicy } from '../../../common/ratelimit/progressive-delay';
import {
  type ThrottleBucket,
  RedisThrottleStorage,
  throttleKey,
} from '../../../common/ratelimit/redis-throttler.storage';
import type { Environment } from '../../../config/environment';
import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase } from '../../../database/database.types';
import type { DeviceFingerprint } from '../device-fingerprint';
import { PasswordHasher } from '../password/hasher';
import { MfaService } from './mfa.service';
import { type IssuedSession, SessionService } from './session.service';

/**
 * The one sentence this endpoint says when it will not sign somebody in.
 *
 * Every cause reaches it: no such address, a password that is wrong, an account that has only ever
 * signed in through GitHub. Which of those it was is exactly the information an attacker is
 * shopping for — "does this address have an account here" is worth more than any single password —
 * and there is nothing a legitimate user can do with the distinction that they cannot do with this.
 */
const INVALID_CREDENTIALS = 'Those credentials are not valid.';

/** Deliberately says nothing about which bucket ran out; `Retry-After` carries what is actionable. */
const THROTTLED = 'Too many sign-in attempts. Try again shortly.';

/** What a caller has to give up before a session exists. */
export interface LoginAttempt {
  /** The session the request arrived holding, if it held one. Revoked on the way through. */
  readonly currentToken?: string;
  readonly device: DeviceFingerprint;
  readonly email: string;
  readonly password: string;
}

/** What the controller needs when the sign-in finished: a cookie to write, and an account. */
export interface SignedIn {
  readonly kind: 'signed-in';
  readonly session: IssuedSession;
  readonly user: {
    readonly email: string;
    readonly emailVerified: boolean;
    readonly id: string;
    readonly mfaEnabled: boolean;
  };
}

/**
 * What it needs when the sign-in stopped at a second factor (criterion 4).
 *
 * A cookie and nothing else. The session it names is half-authenticated — `SessionGuard` refuses
 * every request carrying one — and there is deliberately no account on this arm: naming the user
 * would confirm the address and the password together to somebody who has one of them and is
 * guessing at the other, at the exact moment we have decided not to sign them in.
 */
export interface MfaRequired {
  readonly kind: 'mfa-required';
  readonly session: IssuedSession;
}

/**
 * The two states a password leg can end in.
 *
 * A discriminated union rather than one type with optional members, for the reason the contract
 * gives: a value carrying both an account and "you still owe me a factor" would describe a session
 * that exists and does not, and optional members would let one be built. `kind` is what turns
 * forgetting the second arm into a compile error at every call site rather than a runtime
 * `undefined` somewhere downstream.
 */
export type LoginOutcome = MfaRequired | SignedIn;

/**
 * A `401` with one sentence in it. Thrown for every cause, and carrying no extension members —
 * an `extensions: { reason: 'no-such-user' }` would undo the whole of this class in a line nobody
 * would notice in review.
 */
export class InvalidCredentialsError extends DomainError {
  constructor() {
    super('unauthorized', INVALID_CREDENTIALS);
  }
}

/**
 * Sign-in, sign-out, and the throttle that sits in front of both (§11, criteria 3 and 16).
 *
 * The property worth reading the code for is that **a miss costs exactly what a hit costs**. An
 * address with no account is verified against {@link dummyHash} — a real Argon2id digest of random
 * bytes, made at the configured parameters at boot — so both paths do one full hash before they
 * answer. Returning early on the miss is the bug this is written to make impossible: the message
 * can be as generic as you like and the endpoint still answers "no account here" in forty
 * milliseconds and "wrong password" in a hundred, which is a working account enumerator.
 *
 * `login.e2e-spec.ts` measures both paths over HTTP and asserts they are indistinguishable, and
 * `login.service.spec.ts` asserts the hasher is handed a real digest on the miss — the second
 * because a timing assertion is the slower, noisier way to catch a regression the first catches
 * instantly.
 */
@Injectable()
export class LoginService implements OnModuleInit {
  private readonly accountPolicy: ThrottlePolicy;
  private readonly addressPolicy: ThrottlePolicy;
  /** The short window a half-authenticated session gets, rather than the session's fortnight. */
  private readonly challengeTtlSeconds: number;
  /**
   * A hash of bytes nobody has, verified against on every miss. Built at boot rather than lazily,
   * because a lazy one makes the *first* miss after every deploy the fast one — the timing oracle
   * would be gone from the suite and present in production.
   */
  private dummyHash = '';
  private readonly logger = new Logger(LoginService.name);

  constructor(
    @Inject(APP_DATABASE) private readonly database: ForgeDatabase,
    private readonly hasher: PasswordHasher,
    private readonly mfa: MfaService,
    private readonly sessions: SessionService,
    private readonly throttle: RedisThrottleStorage,
    config: ConfigService<Environment, true>,
  ) {
    this.challengeTtlSeconds = config.get('MFA_CHALLENGE_TTL_SECONDS', { infer: true });

    const decaySeconds = config.get('LOGIN_THROTTLE_DECAY_SECONDS', { infer: true });
    const firstDelaySeconds = config.get('LOGIN_THROTTLE_DELAY_SECONDS', { infer: true });
    const maxDelaySeconds = config.get('LOGIN_THROTTLE_MAX_DELAY_SECONDS', { infer: true });

    this.accountPolicy = {
      burst: config.get('LOGIN_THROTTLE_ACCOUNT_BURST', { infer: true }),
      decaySeconds,
      firstDelaySeconds,
      maxDelaySeconds,
    };
    this.addressPolicy = {
      burst: config.get('LOGIN_THROTTLE_IP_BURST', { infer: true }),
      decaySeconds,
      firstDelaySeconds,
      maxDelaySeconds,
    };
  }

  async onModuleInit(): Promise<void> {
    this.dummyHash = await this.hasher.hash(randomBytes(32).toString('base64url'));
  }

  async authenticate(attempt: LoginAttempt): Promise<LoginOutcome> {
    const { account, address } = this.bucketsFor(attempt);
    const buckets = [account, address];
    const decision = await this.throttle.check(buckets);

    if (!decision.allowed) {
      // Before the lookup and before the hash: a throttle that still does the work it is throttling
      // is an amplifier, and one an unauthenticated caller aims.
      this.logger.warn(
        `Sign-in refused by the throttle after ${decision.failures} failures ` +
          `[ip=${attempt.device.ip} device=${attempt.device.fingerprint}]`,
      );

      throw new RateLimitedError(THROTTLED, decision.retryAfterSeconds);
    }

    if (this.dummyHash === '') {
      // Unreachable through DI — Nest awaits `onModuleInit` before the first request — but the
      // failure it guards against is the one this class exists to prevent, and it would be
      // invisible: `verify('', …)` answers false in microseconds, so every miss would be fast and
      // every hit slow. A 500 is the right way to be wrong about this.
      throw new Error('LoginService was used before onModuleInit built its dummy hash');
    }

    const user = await this.findByEmail(attempt.email);
    // The whole of the constant-time story. `??` rather than an `if`, so there is no branch here
    // for a later edit to put a `return` inside.
    const stored = user?.passwordHash ?? this.dummyHash;
    const { rehashed, valid } = await this.hasher.verify(stored, attempt.password);

    if (!valid || user === null) {
      await this.throttle.penalise(buckets);
      this.logger.warn(
        `Sign-in failed [ip=${attempt.device.ip} device=${attempt.device.fingerprint}]`,
      );

      throw new InvalidCredentialsError();
    }

    // The near misses on the way in were typos: somebody who knows the password is not the attacker
    // the record was kept for, and leaving it would count their next typo against them.
    //
    // The account bucket only. The address bucket is not this account's to forgive — clearing it
    // would hand anybody holding one valid account a way to reset their spray budget on demand:
    // guess to the limit, sign in to their own account, guess to the limit again. It decays on its
    // own, on nobody's say-so.
    await this.throttle.forget([account]);

    if (rehashed !== null) {
      await this.database
        .update(schema.users)
        .set({ passwordHash: rehashed })
        .where(eq(schema.users.id, user.id));
    }

    // Session fixation (criterion 5): whatever the caller was holding stops working here, whether
    // it was their own expired-in-a-tab session or one an attacker planted on a shared machine.
    // Before the branch below, so it happens on both of them — a fixed cookie must not survive a
    // sign-in just because the account turned out to have a second factor.
    if (attempt.currentToken !== undefined) {
      await this.sessions.revoke(attempt.currentToken);
    }

    // Criterion 4. The password was right and it is not enough: the session this establishes is
    // marked pending, `SessionGuard` refuses every request carrying one, and only the challenge
    // route can turn it into a session that does anything.
    if (await this.mfa.isEnrolled(user.id)) {
      this.logger.log(`Sign-in awaiting a second factor [user=${user.id}]`);

      return {
        kind: 'mfa-required',
        session: await this.sessions.create(user.id, attempt.device, {
          pendingMfa: true,
          ttlSeconds: this.challengeTtlSeconds,
        }),
      };
    }

    return {
      kind: 'signed-in',
      session: await this.sessions.create(user.id, attempt.device),
      user: {
        email: user.email,
        emailVerified: user.emailVerifiedAt !== null,
        id: user.id,
        // A literal, not a second read: the `isEnrolled` branch above just returned false, and
        // this arm is only reachable because it did.
        mfaEnabled: false,
      },
    };
  }

  /** `POST /auth/logout`. False when there was nothing to revoke, which is not an error. */
  async signOut(token: string): Promise<boolean> {
    return this.sessions.revoke(token);
  }

  /**
   * The two buckets one attempt is charged to (§11: per-account **and** per-IP).
   *
   * Keyed on the address that was *typed*, not on a user that was found — the distinction is the
   * whole point. A bucket that only exists for real accounts makes "this address never throttles"
   * a perfectly good enumeration oracle, and one that no amount of care over the 401 would cover.
   *
   * The address is hashed first, so a dump of the session instance is not a list of the mailboxes
   * somebody has been guessing passwords for. The IP is not: an operator reading these keys during
   * an incident needs to know which address to block, and it is already stored in clear beside
   * every session it established (T18).
   */
  private bucketsFor(attempt: LoginAttempt): {
    account: ThrottleBucket;
    address: ThrottleBucket;
  } {
    const mailbox = createHash('sha256').update(attempt.email).digest('hex');

    return {
      account: { key: throttleKey('login-account', mailbox), policy: this.accountPolicy },
      address: { key: throttleKey('login-ip', attempt.device.ip), policy: this.addressPolicy },
    };
  }

  private async findByEmail(email: string): Promise<typeof schema.users.$inferSelect | null> {
    const [user] = await this.database
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);

    return user ?? null;
  }
}
