import { PROBLEM_TYPE_BASE_URI, PROBLEM_TYPE_SLUGS, type ProblemDetail } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { ApiProblem, ApiUnreachableError, messageFor } from './problem';

const FALLBACK = 'Something went wrong. Please try again.';

/** A problem document as the API's exception filter renders one. */
function problem(type: string): ProblemDetail {
  return {
    detail: 'A sentence written for a developer, not for this screen.',
    instance: '/api/v1/test',
    requestId: '01JD0000000000000000000000',
    status: 400,
    title: 'Something',
    type,
  };
}

describe('messageFor', () => {
  /**
   * The claim spec 012 rests on, asserted rather than assumed (R7).
   *
   * `MESSAGES` is exhaustive by type — a slug without a sentence fails `typecheck` — and this is
   * the same claim at runtime: every slug the API can send has something written for a person, so
   * a feature routing its refusals through here adds no wording of its own (FR-021).
   */
  it.each(PROBLEM_TYPE_SLUGS)('has a sentence for %s', (slug) => {
    const sentence = messageFor(new ApiProblem(400, problem(`${PROBLEM_TYPE_BASE_URI}${slug}`)));

    expect(sentence).not.toBe(FALLBACK);
    expect(sentence.length).toBeGreaterThan(0);
  });

  it('has exactly the slugs it was written for (020 T043)', () => {
    // `MESSAGES` is meant to stay untouched by a feature. A slug added to the contract lands
    // here first, so whoever adds one writes its sentence deliberately rather than by accident.
    expect([...PROBLEM_TYPE_SLUGS].sort()).toEqual([
      'attachment-not-found',
      'attachment-rejected',
      'attachment-too-large',
      'bad-gateway',
      'bad-request',
      'conflict',
      'csrf-check-failed',
      'current-password-incorrect',
      'email-not-verified',
      'forbidden',
      'gateway-timeout',
      'gone',
      'idempotency-key-in-flight',
      'idempotency-key-reused',
      'import-branch-not-found',
      'import-empty-repo',
      'import-repo-too-large',
      'internal-server-error',
      'local-agent-revoked',
      'mcp-authorization-invalid',
      'method-not-allowed',
      'mfa-code-incorrect',
      'not-acceptable',
      'not-found',
      'not-implemented',
      'oauth-account-already-linked',
      'oauth-authorization-denied',
      'oauth-email-unverified',
      'oauth-exchange-failed',
      'oauth-provider-not-configured',
      'oauth-state-invalid',
      'password-breached',
      'password-too-weak',
      'password-uses-personal-information',
      'payload-too-large',
      'permission-denied',
      'rate-limited',
      'request-timeout',
      'service-unavailable',
      'step-up-required',
      'subscription-not-connected',
      'subscription-unavailable',
      'token-already-used',
      'token-expired',
      'token-invalid',
      'turnstile-check-failed',
      'unauthorized',
      'unsupported-media-type',
      'validation-failed',
      'verification-address-changed',
    ]);
  });

  it('never shows the API its own words', () => {
    // The `detail` field is written for whoever is reading the logs. Rendering it would be the
    // raw error text FR-021 exists to keep off the screen.
    const raw = problem(`${PROBLEM_TYPE_BASE_URI}not-found`);

    expect(messageFor(new ApiProblem(404, raw))).not.toContain(raw.detail);
  });

  it('falls back for a slug this build does not know', () => {
    // A newer server can name a type this client has never heard of. Degrading to the generic
    // sentence is the point of `slug` being optional — the alternative is throwing inside an
    // error handler.
    expect(
      messageFor(new ApiProblem(400, problem(`${PROBLEM_TYPE_BASE_URI}from-the-future`))),
    ).toBe(FALLBACK);
  });

  /** Spec 031: two `409 conflict` refusals carry a `reason` whose sentence beats the slug's. */
  it.each([
    [
      'queue-full',
      'Five runs are already waiting on this project. Try again when one has started.',
    ],
    ['last-owner', 'A project needs at least one owner. Make someone else an owner first.'],
  ])('speaks for the conflict reason %s', (reason, sentence) => {
    const detail = { ...problem(`${PROBLEM_TYPE_BASE_URI}conflict`), reason, status: 409 };

    expect(messageFor(new ApiProblem(409, detail))).toBe(sentence);
  });

  it('says where to fix a run refused for an unconnected Claude subscription (041)', () => {
    const detail = problem(`${PROBLEM_TYPE_BASE_URI}subscription-not-connected`);

    expect(messageFor(new ApiProblem(409, detail))).toBe(
      'Connect your Claude subscription in Settings.',
    );
  });

  it('keeps the slug sentence for a reason it does not know', () => {
    const detail = { ...problem(`${PROBLEM_TYPE_BASE_URI}conflict`), reason: 'from-the-future' };

    expect(messageFor(new ApiProblem(409, detail))).toBe(
      'That conflicts with something that already exists.',
    );
  });

  it('speaks for a failure that never reached the API', () => {
    expect(messageFor(new ApiUnreachableError(new Error('offline')))).toContain(
      'could not be reached',
    );
  });
});
