import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isSameOriginRelativePath } from '@repo/contracts';
import { schema } from '@repo/db';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { createHash } from 'node:crypto';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { DomainError, RateLimitedError } from '../../../common/errors/domain-error';
import type { ThrottlePolicy } from '../../../common/ratelimit/progressive-delay';
import {
  type ThrottleBucket,
  RedisThrottleStorage,
  throttleKey,
} from '../../../common/ratelimit/redis-throttler.storage';
import type { Environment } from '../../../config/environment';
import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../../database/database.types';
import { OutboxWriter } from '../../outbox/outbox-writer';
import { DeadTokenError, TokenService } from './token.service';

/** The noun {@link DeadTokenError} composes its sentence from, for this flow's three refusals. */
const LINK = 'verification link';

/** Deliberately says nothing about which bucket ran out; `Retry-After` carries what is actionable. */
const THROTTLED = 'Too many verification mails requested. Try again shortly.';

/** What a resend request is: an address somebody typed, and where they typed it from. */
export interface ResendAttempt {
  readonly email: string;
  /** Spec 031: the return address to carry into the link, if any. */
  readonly next?: string;
  /** The real client, which it is only because `bootstrap.ts` configures `trust proxy` (T15). */
  readonly ip: string;
}

/**
 * A token that named an address the account no longer has (criterion 2).
 *
 * Not one of {@link DeadTokenError}'s three: the link was real and the reader did copy it
 * correctly, and it is the only refusal here whose remedy involves a different mailbox. Folding it
 * into `token-invalid` would tell somebody to check they pasted the whole link when the link was
 * never the problem.
 */
export class VerificationAddressChangedError extends DomainError {
  constructor() {
    super(
      'verification-address-changed',
      'That link was sent to an address this account no longer uses. ' +
        'A new link has to be requested for the current address.',
    );
  }
}

/**
 * Email verification: minting the link, and spending it exactly once (§11, criterion 2).
 *
 * ## The two statements that make it single-use
 *
 * {@link confirm} claims the row with a conditional update — `consumed_at is null and expires_at >
 * now` — and only asks *why* when the claim matches nothing. That order is the whole of the
 * concurrency story: two clicks on the same link at the same instant are two updates against the
 * same predicate, exactly one of which matches a row. A select-then-update would let both through,
 * and the window is as wide as the gap between a double click.
 *
 * Both halves read one `now` taken from {@link ClockPort} before either runs, so a token cannot be
 * refused by the update for being expired and then reported live by the follow-up select. The
 * boundary that instant decides is asserted on both sides in `email-verification.service.spec.ts`,
 * against a clock the test moves rather than one the suite waits for.
 *
 * ## Why an address change invalidates a link
 *
 * The row records the address the token was minted for, and {@link confirm} compares it against
 * `users.email` at consumption — the mechanism `schema/tokens.ts` prescribes, and the reason there
 * is no second table to keep in step. Without it, a link mailed to an address a user has since
 * given up would still confirm the account, which is somebody proving control of a mailbox they no
 * longer own.
 *
 * The token is spent even when that comparison refuses it. The refusal is not a reason to leave a
 * live credential in the table, and it stops a change to `b` and back to `a` reviving a link that
 * has already been presented once.
 *
 * ## Why a resend says nothing
 *
 * Signup is enumeration-safe (ADR 007), and {@link resend} is a second endpoint taking the same
 * input. An address with no account, one already confirmed and one genuinely waiting all resolve
 * the same way and answer the same bytes. Both buckets are charged before the lookup on every one
 * of those branches — a bucket that only filled for real accounts would make "this address never
 * throttles" a working enumeration oracle, and one no wording of the response could cover.
 *
 * The residual asymmetry is one outbox row: the waiting branch appends the event and the other two
 * do not, because the alternative is mailing strangers on the say-so of anyone who can type an
 * address. ADR 007 already accepts that difference for signup, on the ground that the caller cannot
 * observe it in the response — and an append is one insert, not a transport call.
 *
 * ## Where the token is minted
 *
 * Not here (spec 006, ADR 030). {@link request} appends `mail.email-verification` carrying the
 * user id and the address; `IdentityMailConsumer` issues the token, writes its hash row and
 * renders when the job is drained, so the request path holds no token and renders nothing.
 * {@link confirm} is the other half of that credential and stays here beside it.
 */
@Injectable()
export class EmailVerificationService {
  private readonly accountPolicy: ThrottlePolicy;
  private readonly addressPolicy: ThrottlePolicy;
  private readonly logger = new Logger(EmailVerificationService.name);

  constructor(
    @Inject(APP_DATABASE) private readonly database: ForgeDatabase,
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly outbox: OutboxWriter,
    private readonly throttle: RedisThrottleStorage,
    private readonly tokens: TokenService,
    config: ConfigService<Environment, true>,
  ) {
    const decaySeconds = config.get('VERIFICATION_RESEND_DECAY_SECONDS', { infer: true });
    const firstDelaySeconds = config.get('VERIFICATION_RESEND_DELAY_SECONDS', { infer: true });
    const maxDelaySeconds = config.get('VERIFICATION_RESEND_MAX_DELAY_SECONDS', { infer: true });

    this.accountPolicy = {
      burst: config.get('VERIFICATION_RESEND_ACCOUNT_BURST', { infer: true }),
      decaySeconds,
      firstDelaySeconds,
      maxDelaySeconds,
    };
    this.addressPolicy = {
      burst: config.get('VERIFICATION_RESEND_IP_BURST', { infer: true }),
      decaySeconds,
      firstDelaySeconds,
      maxDelaySeconds,
    };
  }

  /**
   * Ask for a link. Called by signup for a new account, and by {@link resend} — each on the
   * transaction its own write is on, so the mail is accepted exactly when that write commits and
   * never for a state change that rolled back (spec 006 FR-002).
   *
   * One row, no token: the consumer mints when it drains the job, against the address recorded
   * here. Outstanding tokens are deliberately *not* superseded. Two live links for one address are
   * two links that each work once and both die within the window, whereas invalidating the older
   * one would refuse the mail a user clicked first — a worse answer to the more common mistake.
   */
  async request(
    tx: TenantTransaction,
    userId: string,
    email: string,
    next?: string,
  ): Promise<void> {
    await this.outbox.append(tx, {
      aggregateId: userId,
      payload: { ...returnAddress(next), recipient: email, userId },
      type: 'mail.email-verification',
    });
  }

  /**
   * `POST /auth/verify/resend`. Resolves either way; the caller learns nothing it could pass on.
   *
   * It throws only for the throttle, which is the same 429 for an address that exists and one that
   * does not — see the class comment on why both buckets are charged before the lookup.
   */
  async resend(attempt: ResendAttempt): Promise<void> {
    const buckets = this.bucketsFor(attempt);
    const decision = await this.throttle.check(buckets);

    if (!decision.allowed) {
      // Before the lookup and before the send: a throttle that still does the work it is throttling
      // is an amplifier, and this one would aim it at a mailbox the caller does not own.
      this.logger.warn(
        `Verification resend refused by the throttle after ${decision.failures} requests ` +
          `[ip=${attempt.ip}]`,
      );

      throw new RateLimitedError(THROTTLED, decision.retryAfterSeconds);
    }

    // Charged on every branch below, including the two that send nothing.
    await this.throttle.penalise(buckets);

    // A transaction because `OutboxWriter.append` needs one to be atomic with (spec 005 FR-005);
    // the lookup rides in it so the event names a row that existed when it was appended.
    await this.database.transaction(async (tx) => {
      const [user] = await tx
        .select({ emailVerifiedAt: schema.users.emailVerifiedAt, id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, attempt.email))
        .limit(1);

      // Two reasons to send nothing, kept apart because they are different facts even though the
      // caller is told the same thing about both: there is no account for this address, or there
      // is one and it has already confirmed.
      if (user === undefined) {
        return;
      }

      if (user.emailVerifiedAt !== null) {
        return;
      }

      await this.request(tx, user.id, attempt.email, attempt.next);
    });
  }

  /**
   * `POST /auth/verify`. Spend a link, or say precisely why it will not spend.
   *
   * @throws {DeadTokenError} for a token that is unknown, expired or already used — three slugs.
   * @throws {VerificationAddressChangedError} for one whose address the account has since changed.
   */
  async confirm(token: string): Promise<void> {
    const hash = this.tokens.fingerprint(token);
    // One instant for the claim and for the verdict, so the two cannot disagree about the boundary.
    const now = this.clock.now();

    const [claimed] = await this.database
      .update(schema.emailVerificationTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(schema.emailVerificationTokens.tokenHash, hash),
          isNull(schema.emailVerificationTokens.consumedAt),
          // Strictly greater, matching `TokenService.verdict`. At exactly `expires_at` the token
          // has expired: that is the instant it names, not the last one it works at.
          gt(schema.emailVerificationTokens.expiresAt, now),
        ),
      )
      .returning({
        email: schema.emailVerificationTokens.email,
        userId: schema.emailVerificationTokens.userId,
      });

    if (claimed === undefined) {
      throw await this.refusalFor(hash);
    }

    const [user] = await this.database
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, claimed.userId))
      .limit(1);

    // `citext`, so the comparison the database would make is not the one `===` makes. Lower-cased
    // here rather than trusted to the caller: T13 normalises through `emailSchema`, but a token
    // minted by a later flow that does not would fail open, which is the wrong direction.
    //
    // A user that is gone entirely — deleted between the claim and this read — takes the same
    // branch, because `undefined?.email` matches nothing. The address this token proves control of
    // is not the account's current address in that case either, which is what the refusal says.
    if (user?.email.toLowerCase() !== claimed.email.toLowerCase()) {
      throw new VerificationAddressChangedError();
    }

    await this.database
      .update(schema.users)
      .set({ emailVerifiedAt: now })
      // Only when it is not already set, so a replay cannot rewrite when the address was *first*
      // confirmed — the field an audit reads.
      .where(and(eq(schema.users.id, claimed.userId), isNull(schema.users.emailVerifiedAt)));
  }

  /**
   * Why the claim matched nothing, asked only once it has.
   *
   * A row that has become `valid` between the two statements is one a concurrent request consumed
   * and this one lost the race for — `consumed` is what that caller should be told, and it is what
   * they will be told a moment later anyway once the winner's write is visible.
   */
  private async refusalFor(hash: string): Promise<DeadTokenError> {
    const [record] = await this.database
      .select({
        consumedAt: schema.emailVerificationTokens.consumedAt,
        expiresAt: schema.emailVerificationTokens.expiresAt,
      })
      .from(schema.emailVerificationTokens)
      .where(eq(schema.emailVerificationTokens.tokenHash, hash))
      .limit(1);

    const verdict = this.tokens.verdict(record);

    return new DeadTokenError(verdict === 'valid' ? 'consumed' : verdict, LINK);
  }

  /**
   * The two buckets one request is charged to (T14: per address **and** per IP).
   *
   * Keyed on the address that was *typed*, not on a user that was found — the distinction is the
   * whole point, and the same one `LoginService.bucketsFor` makes. The address is hashed first, so
   * a dump of the session instance is not a list of the mailboxes somebody has been mailing; the
   * IP is not, because an operator reading these keys during an incident needs to know what to
   * block.
   */
  private bucketsFor(attempt: ResendAttempt): ThrottleBucket[] {
    const mailbox = createHash('sha256').update(attempt.email).digest('hex');

    return [
      {
        key: throttleKey('verification-resend-account', mailbox),
        policy: this.accountPolicy,
      },
      { key: throttleKey('verification-resend-ip', attempt.ip), policy: this.addressPolicy },
    ];
  }
}

/**
 * Spec 031 (R7): a return address on a mail event, or nothing. A value that is not a same-origin
 * relative path is dropped rather than refused — the caller is told the same thing either way.
 */
export function returnAddress(next: string | undefined): { next?: string } {
  return next !== undefined && isSameOriginRelativePath(next) ? { next } : {};
}
