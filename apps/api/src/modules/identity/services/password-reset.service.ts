import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { schema } from '@repo/db';
import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import { createHash } from 'node:crypto';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { RateLimitedError } from '../../../common/errors/domain-error';
import type { ThrottlePolicy } from '../../../common/ratelimit/progressive-delay';
import {
  type ThrottleBucket,
  RedisThrottleStorage,
  throttleKey,
} from '../../../common/ratelimit/redis-throttler.storage';
import type { Environment } from '../../../config/environment';
import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase } from '../../../database/database.types';
import { OutboxWriter } from '../../outbox/outbox-writer';
import { NewPasswordService } from '../password/new-password';
import { SessionService } from './session.service';
import { DeadTokenError, TokenService } from './token.service';

/** The noun {@link DeadTokenError} composes its sentence from, for this flow's three refusals. */
const LINK = 'password reset link';

/** Deliberately says nothing about which bucket ran out; `Retry-After` carries what is actionable. */
const THROTTLED = 'Too many password reset requests. Try again shortly.';

/** What asking for a reset link is: an address somebody typed, and where they typed it from. */
export interface ResetRequest {
  readonly email: string;
  /** The real client, which it is only because `bootstrap.ts` configures `trust proxy` (T15). */
  readonly ip: string;
}

/** What spending one is: the token out of the link, and the password being chosen. */
export interface ResetCompletion {
  readonly password: string;
  readonly token: string;
}

/**
 * Password reset: handing out a link that says nothing, and spending it in a way that ends
 * everything (§11, criterion 7).
 *
 * ## Why the request costs the same either way
 *
 * Criterion 7 asks for a response that is identical for a known and an unknown address, and the
 * response is two things a caller can measure: the bytes and the clock. The bytes are guaranteed by
 * `requestPasswordResetResponseSchema`, which has no member that could differ. The clock is
 * guaranteed here, by removing both places the work could branch:
 *
 * - **The lookup is the same on both branches.** {@link request} selects the user by address and,
 *   when there is one, appends one outbox row — an indexed select both branches pay, and one insert
 *   the known branch pays on top of it (spec 006 research R4). That insert is the same "one row and
 *   its index entries" class `password.e2e-spec.ts` measured at ~1.2 ms and budgets for; a design
 *   that wrote a junk row for strangers to close it would be a write amplifier aimed at our own
 *   table.
 * - **Nothing renders and nothing is sent here.** The token is minted by `IdentityMailConsumer`
 *   when the job is drained, off the request path entirely (spec 006, ADR 030). A response that
 *   awaited a transactional mail provider would take an extra round trip on exactly the branch
 *   where an account exists, which is an enumeration oracle measured in hundreds of milliseconds
 *   and visible through any amount of caution about the body. `password.e2e-spec.ts` proves this
 *   with a mailer that is deliberately slow: if the response ever starts waiting for delivery, the
 *   timing comparison fails.
 *
 * Both throttle buckets are charged before the statement runs, on every branch. A bucket that only
 * filled for real accounts makes "this address never throttles" a perfectly good enumeration oracle,
 * and one no wording of the 202 could cover.
 *
 * ## Why spending one ends everything
 *
 * §11: "Resetting revokes every session and every refresh token." Every, including the session the
 * request arrives on. Somebody resets their password precisely when they think another device is
 * not theirs — a reset that spared any session would leave that device signed in behind a password
 * that no longer opens it. There are no refresh tokens in this system to revoke; sessions are opaque
 * and server-side (ADR 001), so the session index is the whole of the state that grants access.
 *
 * The account's *other* outstanding links die at the same instant, for the same reason. If an
 * attacker asked for a reset before the owner did, leaving their link live would hand the account
 * over a minute after the owner had just taken it back.
 */
@Injectable()
export class PasswordResetService {
  private readonly accountPolicy: ThrottlePolicy;
  private readonly addressPolicy: ThrottlePolicy;
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    @Inject(APP_DATABASE) private readonly database: ForgeDatabase,
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly outbox: OutboxWriter,
    private readonly passwords: NewPasswordService,
    private readonly sessions: SessionService,
    private readonly throttle: RedisThrottleStorage,
    private readonly tokens: TokenService,
    config: ConfigService<Environment, true>,
  ) {
    const decaySeconds = config.get('PASSWORD_RESET_DECAY_SECONDS', { infer: true });
    const firstDelaySeconds = config.get('PASSWORD_RESET_DELAY_SECONDS', { infer: true });
    const maxDelaySeconds = config.get('PASSWORD_RESET_MAX_DELAY_SECONDS', { infer: true });

    this.accountPolicy = {
      burst: config.get('PASSWORD_RESET_ACCOUNT_BURST', { infer: true }),
      decaySeconds,
      firstDelaySeconds,
      maxDelaySeconds,
    };
    this.addressPolicy = {
      burst: config.get('PASSWORD_RESET_IP_BURST', { infer: true }),
      decaySeconds,
      firstDelaySeconds,
      maxDelaySeconds,
    };
  }

  /**
   * `POST /auth/password/reset`. Resolves either way; the caller learns nothing it could pass on.
   *
   * It throws only for the throttle, which is the same 429 for an address that exists and one that
   * does not — see the class comment on why both buckets are charged before anything is looked at.
   */
  async request(attempt: ResetRequest): Promise<void> {
    const buckets = this.bucketsFor(attempt);
    const decision = await this.throttle.check(buckets);

    if (!decision.allowed) {
      // Before the statement and before the mail: a throttle that still does the work it is
      // throttling is an amplifier, and this one would aim it at a mailbox the caller does not own.
      this.logger.warn(
        `Password reset refused by the throttle after ${decision.failures} requests ` +
          `[ip=${attempt.ip}]`,
      );

      throw new RateLimitedError(THROTTLED, decision.retryAfterSeconds);
    }

    // Charged on both branches below, including the one that appends nothing.
    await this.throttle.penalise(buckets);

    // A transaction because `OutboxWriter.append` needs one to be atomic with (spec 005 FR-005).
    // The unknown branch does the same indexed select and returns; see the class comment on what
    // the known branch's one extra insert costs and why it is the floor.
    await this.database.transaction(async (tx) => {
      const [owner] = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, attempt.email))
        .limit(1);

      if (owner === undefined) {
        return;
      }

      await this.outbox.append(tx, {
        aggregateId: owner.id,
        payload: { recipient: attempt.email, userId: owner.id },
        type: 'mail.password-reset',
      });
    });
  }

  /**
   * `POST /auth/password/reset/confirm`. Spend a link, or say precisely why it will not spend.
   *
   * @returns how many sessions the reset ended — a number for the log line, never for the body.
   * @throws {DeadTokenError} for a token that is unknown, expired or already used — three slugs.
   * @throws {WeakPasswordError | PersonalInformationPasswordError | BreachedPasswordError} for a
   * password §11 refuses, and **without spending the link**.
   */
  async complete(attempt: ResetCompletion): Promise<number> {
    const hash = this.tokens.fingerprint(attempt.token);

    // A read-only look first, before anything expensive. It is not what makes the token single-use —
    // the conditional update below is, and it has to be, because two clicks on one link arrive
    // together — but it is what stops a stranger spending an Argon2id hash and an HIBP lookup on
    // this unauthenticated endpoint by posting a token nobody ever minted.
    const refusal = await this.refusalFor(hash);

    if (refusal !== null) {
      throw refusal;
    }

    // Vetted *before* the claim, so a password the policy refuses does not burn the link. The
    // alternative leaves somebody who chose a weak password holding a dead link and waiting for
    // another mail, over a mistake they could fix by typing a better password. The window this
    // opens — a token claimed by a concurrent request while we hash — closes on the next line,
    // which refuses exactly as it would have refused a moment earlier.
    const passwordHash = await this.passwords.vet(attempt.password);
    // One instant for the claim and for the verdict, so the two cannot disagree about the boundary.
    const now = this.clock.now();

    const [claimed] = await this.database
      .update(schema.passwordResetTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(schema.passwordResetTokens.tokenHash, hash),
          isNull(schema.passwordResetTokens.consumedAt),
          // Strictly greater, matching `TokenService.verdict`. At exactly `expires_at` the token has
          // expired: that is the instant it names, not the last one it works at.
          gt(schema.passwordResetTokens.expiresAt, now),
        ),
      )
      .returning({ userId: schema.passwordResetTokens.userId });

    if (claimed === undefined) {
      throw (await this.refusalFor(hash)) ?? new DeadTokenError('consumed', LINK);
    }

    await this.database
      .update(schema.users)
      .set({ passwordHash })
      .where(eq(schema.users.id, claimed.userId));

    // Every other live link for this account, spent at the same instant and for the same reason the
    // sessions are: one of them may be an attacker's, requested before the owner noticed.
    await this.database
      .update(schema.passwordResetTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(schema.passwordResetTokens.userId, claimed.userId),
          ne(schema.passwordResetTokens.tokenHash, hash),
          isNull(schema.passwordResetTokens.consumedAt),
        ),
      );

    // No exception: the session that made this request dies with the rest (§11).
    const revoked = await this.sessions.revokeAll(claimed.userId);

    this.logger.log(`Password reset [user=${claimed.userId} sessions_revoked=${revoked}]`);

    return revoked;
  }

  /**
   * Why a token will not work, or `null` when it would.
   *
   * Read-only, and therefore advisory: between this and the claim a concurrent request may consume
   * the row. That is why it is called twice — once to refuse the cheap cases early, and once after
   * a claim that matched nothing, to say which of the three it was.
   *
   * A row that reads `valid` on the second call is one another request consumed and this one lost
   * the race for; `complete` answers `consumed`, which is what that caller would be told a moment
   * later anyway.
   */
  private async refusalFor(hash: string): Promise<DeadTokenError | null> {
    const [record] = await this.database
      .select({
        consumedAt: schema.passwordResetTokens.consumedAt,
        expiresAt: schema.passwordResetTokens.expiresAt,
      })
      .from(schema.passwordResetTokens)
      .where(eq(schema.passwordResetTokens.tokenHash, hash))
      .limit(1);

    const verdict = this.tokens.verdict(record);

    return verdict === 'valid' ? null : new DeadTokenError(verdict, LINK);
  }

  /**
   * The two buckets one request is charged to (§11: per address **and** per IP).
   *
   * Keyed on the address that was *typed*, not on a user that was found — the same distinction
   * `LoginService.bucketsFor` makes, and for the same reason. The address is hashed first, so a dump
   * of the session instance is not a list of the mailboxes somebody has been asking for reset links
   * for; the IP is not, because an operator reading these keys during an incident needs to know what
   * to block.
   */
  private bucketsFor(attempt: ResetRequest): ThrottleBucket[] {
    const mailbox = createHash('sha256').update(attempt.email).digest('hex');

    return [
      { key: throttleKey('password-reset-account', mailbox), policy: this.accountPolicy },
      { key: throttleKey('password-reset-ip', attempt.ip), policy: this.addressPolicy },
    ];
  }
}
