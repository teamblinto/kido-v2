import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { DomainError } from '../../../common/errors/domain-error';
import type { ProblemTypeSlug } from '../../../common/errors/problem-types';

/** 32 bytes, as §11 requires: far past any guessing budget, and 43 characters in a link. */
const TOKEN_BYTES = 32;

/** What a mint produces. The caller stores two of these three and mails the other. */
export interface IssuedToken {
  readonly expiresAt: Date;
  /**
   * The raw value. It goes into exactly one place — the link in the mail — and into nothing else:
   * not the row, not a log line, not a response body, not an audit entry. Everything that needs to
   * *recognise* it later uses {@link IssuedToken.tokenHash}.
   */
  readonly token: string;
  /** The SHA-256 digest, hex-encoded. This is the value a `token_hash` column holds. */
  readonly tokenHash: string;
}

/**
 * The columns {@link TokenService.verdict} reasons about, and the whole of what the three token
 * tables have in common. `email_verification_tokens`, `password_reset_tokens` and T29's invitations
 * each satisfy it structurally, so none of them has to be named here.
 */
export interface TokenRecord {
  readonly consumedAt: Date | null;
  readonly expiresAt: Date;
}

/**
 * What a presented token is worth. Four answers, because a caller — and the person reading the
 * response — can act on the difference between all four, and criterion 2 requires three of them to
 * be distinguishable in the response.
 */
export type TokenVerdict = 'consumed' | 'expired' | 'unknown' | 'valid';

/** The ways a presented token is refused — every verdict except the one that lets a caller through. */
export type DeadToken = Exclude<TokenVerdict, 'valid'>;

/**
 * The slug each refusal answers with. Shared across the three flows on purpose: the route already
 * says which kind of link it was, so `token-expired` on `/auth/verify` needs no further
 * qualification, and three flows inventing nine slugs would be a vocabulary no client could learn.
 */
const REFUSAL_SLUG: Readonly<Record<DeadToken, ProblemTypeSlug>> = Object.freeze({
  consumed: 'token-already-used',
  expired: 'token-expired',
  unknown: 'token-invalid',
});

/**
 * What the reader is told, composed from the noun the flow supplies — "verification link" here,
 * "password reset link" in T19, "invitation link" in T29.
 *
 * Each sentence names the next action, because that is the only thing the difference between these
 * three is worth to the person reading it.
 */
const REFUSAL_DETAIL: Readonly<Record<DeadToken, (subject: string) => string>> = Object.freeze({
  consumed: (subject) => `That ${subject} has already been used.`,
  expired: (subject) => `That ${subject} has expired. Request a new one.`,
  unknown: (subject) =>
    `That ${subject} is not one we recognise. Check that you copied the whole link.`,
});

/**
 * A token that will not work, and why — criterion 2's three distinct slugs, in one class so that
 * three flows cannot drift into three vocabularies.
 *
 * It carries no extension member naming the token, the account or the address. The caller of these
 * endpoints is whoever holds a link, which is not the same person as whoever holds the account.
 */
export class DeadTokenError extends DomainError {
  readonly verdict: DeadToken;

  constructor(verdict: DeadToken, subject: string) {
    super(REFUSAL_SLUG[verdict], REFUSAL_DETAIL[verdict](subject));
    this.verdict = verdict;
  }
}

/**
 * The single-use credential primitive: how one is minted, how it is recognised, and when it stops
 * working (§11, criterion 2).
 *
 * Written for three callers rather than for the one that needed it first. Email verification (T14),
 * password reset (T19) and invitations (T29) differ in which table they write, how long a token
 * lives and what consuming one does — and in nothing else. The parts that are identical are here:
 * the entropy, the digest, the expiry arithmetic against {@link ClockPort}, and the four-way verdict
 * whose ordering is easy to get subtly wrong in three separate places.
 *
 * ## What is deliberately not here
 *
 * The row I/O, including the statement that enforces single use. Drizzle's update-set type does not
 * resolve through a generic table parameter, and the only way to write one `claim` for three tables
 * is a cast around precisely the statement single-use depends on — which is the last place in this
 * module worth trading a compile-time check for a shared line.
 *
 * So each flow writes its own two statements, and every one of them must have this shape:
 *
 * ```sql
 * update <table> set consumed_at = :now
 *  where token_hash = :hash and consumed_at is null and expires_at > :now
 *  returning *
 * ```
 *
 * followed, when that returns nothing, by a plain `select … where token_hash = :hash` fed to
 * {@link verdict} to find out *why*. Three properties come out of that order and no other:
 *
 * - **Single use survives a race.** Two clicks on the same link at the same moment are two updates
 *   against `consumed_at is null`; one matches a row and one does not. A read-then-write would let
 *   both through, and the window is exactly as wide as a double-clicked mail link.
 * - **`now` is the same instant in both halves**, so a token cannot be refused by the update for
 *   being expired and then reported valid by the select a millisecond later.
 * - **The three slugs stay distinguishable**, which is only true because consumption is a column
 *   and not a `delete`: a deleted row makes a used token indistinguishable from one that never
 *   existed.
 *
 * ## Why SHA-256 and not Argon2id
 *
 * The input is 256 bits of `randomBytes`, not a password. There is no dictionary to slow an
 * attacker down against, and the digest is computed on the request path of a link somebody just
 * clicked. `session.service.ts` makes the same call for the same reason.
 */
@Injectable()
export class TokenService {
  constructor(@Inject(CLOCK) private readonly clock: ClockPort) {}

  /**
   * Mint one, valid for `lifetimeSeconds` from now.
   *
   * The lifetime is an argument rather than configuration this class reads, because it is the one
   * thing the three callers genuinely disagree about — 24 hours for a verification link, an hour
   * for a password reset, a week for an invitation — and each owns its own environment variable.
   */
  issue(lifetimeSeconds: number): IssuedToken {
    if (!Number.isFinite(lifetimeSeconds) || lifetimeSeconds <= 0) {
      // A zero or negative lifetime mints a token that is already dead; `NaN` mints one whose
      // expiry compares false against every instant, which is a token that never expires at all.
      // Both are silent, and the second is the one worth throwing for.
      throw new RangeError(
        `token lifetime must be a finite, positive number of seconds, got ${String(lifetimeSeconds)}`,
      );
    }

    const token = randomBytes(TOKEN_BYTES).toString('base64url');

    return {
      expiresAt: new Date(this.clock.now().getTime() + lifetimeSeconds * 1_000),
      token,
      tokenHash: this.fingerprint(token),
    };
  }

  /**
   * The digest to look a presented token up by.
   *
   * Named for what it is used for rather than `hash`, because the one thing a caller must never do
   * with it is store it as though it were a password digest, and `fingerprint(token)` does not read
   * like an invitation to.
   */
  fingerprint(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Why a token that did not claim a row did not claim it — the three distinct answers criterion 2
   * asks for, on the record the follow-up select found.
   *
   * The ordering is the part worth arguing about. Consumption outranks expiry: "you have already
   * used this link" is truer and more actionable than "it expired", and it is *stable*, where the
   * other order would turn one used link into a `consumed` answer today and an `expired` one
   * tomorrow. A missing row is `unknown` rather than `expired` because we genuinely do not know —
   * saying "expired" about a token that was never minted invites the reader to wait for a resend of
   * something nobody ever sent.
   */
  verdict(record: TokenRecord | null | undefined): TokenVerdict {
    if (record === null || record === undefined) {
      return 'unknown';
    }

    if (record.consumedAt !== null) {
      return 'consumed';
    }

    // Strictly before, matching the `expires_at > :now` in the claim statement. The two comparisons
    // must agree or a token is live to one of them and dead to the other for one millisecond.
    return this.clock.now().getTime() < record.expiresAt.getTime() ? 'valid' : 'expired';
  }
}
