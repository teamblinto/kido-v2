import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { FakeClock } from '../../../common/clock/fake-clock';
import { TokenService } from './token.service';

const ISSUED_AT = '2026-03-01T09:00:00.000Z';
const DAY_SECONDS = 24 * 60 * 60;

/**
 * Built by hand rather than through Nest. This class takes one dependency and the whole point of
 * the clock port is that the test supplies it — a testing module here would add a container to a
 * suite whose subject is arithmetic.
 */
function subject(at: string = ISSUED_AT): { clock: FakeClock; tokens: TokenService } {
  const clock = new FakeClock(at);

  return { clock, tokens: new TokenService(clock) };
}

describe('TokenService', () => {
  describe('issue', () => {
    it('mints 32 bytes of randomness, which is what §11 asks the token to be worth', () => {
      const { tokens } = subject();

      expect(Buffer.from(tokens.issue(DAY_SECONDS).token, 'base64url')).toHaveLength(32);
    });

    /**
     * base64url for the reason `session.service.ts` gives: the value rides in a URL query parameter
     * and must survive it without encoding. A `+`, `/` or `=` would round-trip through a mail
     * client, a redirect and a form as something else, and the token that came back would not hash
     * to the one that went out.
     */
    it('encodes it as base64url, so the mail link needs no escaping', () => {
      const { tokens } = subject();

      expect(tokens.issue(DAY_SECONDS).token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('never mints the same token twice', () => {
      const { tokens } = subject();
      const minted = new Set(Array.from({ length: 500 }, () => tokens.issue(DAY_SECONDS).token));

      expect(minted.size).toBe(500);
    });

    /**
     * The property the schema comment calls load-bearing: a database disclosure must not be a valid
     * link. What the caller stores is the digest, and the digest cannot be pasted into a URL.
     */
    it('returns a sha-256 digest of the token, and never the token, for the row', () => {
      const { tokens } = subject();
      const { token, tokenHash } = tokens.issue(DAY_SECONDS);

      expect(tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
      expect(tokenHash).not.toBe(token);
      expect(tokenHash).not.toContain(token);
    });

    it('dates the expiry from the injected clock, never from the host clock', () => {
      const { clock, tokens } = subject('2019-11-05T00:00:00.000Z');

      expect(tokens.issue(DAY_SECONDS).expiresAt.toISOString()) //
        .toBe('2019-11-06T00:00:00.000Z');
      expect(clock.now().toISOString()).toBe('2019-11-05T00:00:00.000Z');
    });

    /**
     * A lifetime that is zero, negative or `NaN` produces a token that is already dead or one whose
     * expiry compares false against everything — and the second never expires at all. Refused where
     * the value is still traceable to the line that wrote it, exactly as `FakeClock` refuses an
     * invalid instant.
     */
    it.each([
      ['zero', 0],
      ['negative', -1],
      ['not a number', Number.NaN],
      ['infinite', Number.POSITIVE_INFINITY],
    ])('refuses a %s lifetime rather than minting a token that cannot expire', (_name, seconds) => {
      const { tokens } = subject();

      expect(() => tokens.issue(seconds)).toThrow(RangeError);
    });
  });

  describe('fingerprint', () => {
    it('reproduces the digest a mint stored, which is what makes the lookup possible', () => {
      const { tokens } = subject();
      const { token, tokenHash } = tokens.issue(DAY_SECONDS);

      expect(tokens.fingerprint(token)).toBe(tokenHash);
    });

    it('gives different tokens different digests', () => {
      const { tokens } = subject();

      expect(tokens.fingerprint('one')).not.toBe(tokens.fingerprint('two'));
    });
  });

  /**
   * The three distinct answers criterion 2 requires, plus the one that means "go ahead".
   *
   * Every boundary here is asserted on both sides against a clock the test moves. A suite that
   * `sleep`s past an expiry is slow and flaky; one that asserts a tolerance is how an off-by-an-hour
   * survives review.
   */
  describe('verdict', () => {
    it('calls a token with no row unknown, never expired', () => {
      const { tokens } = subject();

      expect(tokens.verdict(null)).toBe('unknown');
      expect(tokens.verdict(undefined)).toBe('unknown');
    });

    it('calls a fresh, unconsumed token valid', () => {
      const { tokens } = subject();
      const { expiresAt } = tokens.issue(DAY_SECONDS);

      expect(tokens.verdict({ consumedAt: null, expiresAt })).toBe('valid');
    });

    it('is still valid one millisecond before it expires', () => {
      const { clock, tokens } = subject();
      const { expiresAt } = tokens.issue(DAY_SECONDS);

      clock.advance(DAY_SECONDS * 1_000 - 1);

      expect(tokens.verdict({ consumedAt: null, expiresAt })).toBe('valid');
    });

    /**
     * `expiresAt` is the instant it expires, not the last instant it works — the same reading the
     * `expires_at > now` in the claim statement takes. The two must agree or a token is valid to one
     * of them and dead to the other for exactly one millisecond.
     */
    it('is expired at the instant named by expiresAt, not one millisecond later', () => {
      const { clock, tokens } = subject();
      const { expiresAt } = tokens.issue(DAY_SECONDS);

      clock.advance(DAY_SECONDS * 1_000);

      expect(tokens.verdict({ consumedAt: null, expiresAt })).toBe('expired');
    });

    it('is expired one millisecond after it expires', () => {
      const { clock, tokens } = subject();
      const { expiresAt } = tokens.issue(DAY_SECONDS);

      clock.advance(DAY_SECONDS * 1_000 + 1);

      expect(tokens.verdict({ consumedAt: null, expiresAt })).toBe('expired');
    });

    it('calls a consumed token consumed', () => {
      const { clock, tokens } = subject();
      const { expiresAt } = tokens.issue(DAY_SECONDS);

      expect(tokens.verdict({ consumedAt: clock.now(), expiresAt })).toBe('consumed');
    });

    /**
     * Consumption outranks expiry, and the ordering is the load-bearing part. "You have already used
     * this link" is both truer and more actionable than "it expired", and it is *stable*: an answer
     * that changed from `consumed` to `expired` at midnight would make one used link two different
     * support tickets.
     */
    it('calls a token that was used and has since expired consumed, not expired', () => {
      const { clock, tokens } = subject();
      const { expiresAt } = tokens.issue(DAY_SECONDS);
      const consumedAt = clock.now();

      clock.advance(DAY_SECONDS * 1_000 * 30);

      expect(tokens.verdict({ consumedAt, expiresAt })).toBe('consumed');
    });
  });
});
