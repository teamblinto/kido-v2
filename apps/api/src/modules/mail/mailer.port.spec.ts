import { describe, expect, it } from 'vitest';

import {
  MAIL_FAILURE_REASONS,
  MAIL_TEMPLATE_IDS,
  type MailFailureReason,
  mailFailed,
  mailSent,
} from './mailer.port';

/**
 * The retryable/terminal split is the whole reason the reason exists, and §10 states the rule it
 * encodes: "classify before retrying — a 4xx from a connector, a validation error or a permission
 * denial is terminal. Only timeouts, 5xx and 429 are retried."
 *
 * Asserted as a table rather than derived from the implementation, so flipping one of these is a
 * failing test rather than a silent change to how often a dead address is retried.
 */
const RETRYABLE: Readonly<Record<MailFailureReason, boolean>> = {
  'invalid-recipient': false,
  'not-configured': false,
  rejected: false,
  throttled: true,
  unavailable: true,
};

describe('mail template catalogue', () => {
  it('is frozen, so an adapter cannot add a template id at runtime', () => {
    expect(Object.isFrozen(MAIL_TEMPLATE_IDS)).toBe(true);
  });

  it('has no duplicate ids', () => {
    expect(new Set(MAIL_TEMPLATE_IDS).size).toBe(MAIL_TEMPLATE_IDS.length);
  });

  it('covers the templates of spec 001, the domain notices of 028, the webhook notice of 029 and the BYOS notice of 032', () => {
    expect([...MAIL_TEMPLATE_IDS].sort()).toEqual([
      // T13's enumeration-safe signup: the only channel that tells an existing address it is
      // already registered, because the endpoint will not (ADR 007).
      'account-exists',
      // Spec 032 contracts § 6: a linked subscription needs reconnecting, or was withdrawn.
      'byos-account',
      'domain-drifted',
      'domain-failed',
      'domain-release-warning',
      'domain-released',
      'email-verification',
      'invitation',
      'password-reset',
      'project-invitation',
      'webhook-paused',
    ]);
  });
});

describe('mailSent', () => {
  it('reports an outcome a caller can branch on without a type guard', () => {
    expect(mailSent().outcome).toBe('sent');
  });

  it('carries the provider id when there is one', () => {
    expect(mailSent('re_abc123')).toEqual({ outcome: 'sent', providerMessageId: 're_abc123' });
  });

  /** Console and the fake have no vendor behind them; `undefined` says so rather than inventing one. */
  it('carries undefined when there is no provider behind the send', () => {
    expect(mailSent()).toEqual({ outcome: 'sent', providerMessageId: undefined });
  });
});

describe('mailFailed', () => {
  it.each(MAIL_FAILURE_REASONS)('classifies %s as retryable per §10', (reason) => {
    expect(mailFailed(reason, 'a reason').failure.retryable).toBe(RETRYABLE[reason]);
  });

  it('reports an outcome a caller can branch on without a type guard', () => {
    expect(mailFailed('unavailable', 'a reason').outcome).toBe('failed');
  });

  it('keeps the transport status when there was a response', () => {
    expect(mailFailed('throttled', 'a reason', 429).failure.status).toBe(429);
  });

  it('leaves the status undefined when no response was received', () => {
    expect(mailFailed('unavailable', 'a reason').failure.status).toBeUndefined();
  });

  it('carries the reason so a caller can log the class without the prose', () => {
    expect(mailFailed('rejected', 'a reason').failure.reason).toBe('rejected');
  });

  /**
   * The retryable flag is derived here and nowhere else. If each adapter set it, a Resend 429 and a
   * future SES 429 would eventually disagree about whether a throttle is worth retrying.
   */
  it('does not let a caller choose the retryable flag', () => {
    const failure = mailFailed('rejected', 'a reason').failure;

    expect(Object.isFrozen(failure)).toBe(true);
    expect(failure.retryable).toBe(false);
  });
});

describe('the failure reason catalogue', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(MAIL_FAILURE_REASONS)).toBe(true);
  });

  it('classifies every reason it publishes', () => {
    expect([...MAIL_FAILURE_REASONS].sort()).toEqual(Object.keys(RETRYABLE).sort());
  });

  /**
   * At least one of each, or the classification is decorative: an adapter that can only report
   * retryable failures never surfaces a dead address, and one that can only report terminal ones
   * turns a five-minute outage into a mail nobody ever sends.
   */
  it('contains both retryable and terminal reasons', () => {
    const flags = MAIL_FAILURE_REASONS.map((reason) => RETRYABLE[reason]);

    expect(flags).toContain(true);
    expect(flags).toContain(false);
  });
});
