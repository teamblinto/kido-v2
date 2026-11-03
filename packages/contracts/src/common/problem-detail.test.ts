import { describe, expect, it } from 'vitest';

import {
  PROBLEM_TYPE_BASE_URI,
  PROBLEM_TYPE_SLUGS,
  problemDetailSchema,
  problemTypeSlugFromUri,
  problemTypeUri,
} from './problem-detail';

const validationFailed = {
  detail: 'The request body failed validation.',
  errors: [{ code: 'invalid_format', detail: 'Invalid email address', pointer: '#/email' }],
  instance: '/api/v1/auth/signup',
  requestId: '018f4a1c-0000-7000-8000-000000000000',
  status: 422,
  title: 'Validation Failed',
  type: 'https://forge.dev/problems/validation-failed',
};

describe('PROBLEM_TYPE_SLUGS', () => {
  it('is a closed, kebab-case, duplicate-free vocabulary', () => {
    expect(new Set(PROBLEM_TYPE_SLUGS).size).toBe(PROBLEM_TYPE_SLUGS.length);

    for (const slug of PROBLEM_TYPE_SLUGS) {
      expect(slug, `${slug} must be kebab-case`).toMatch(/^[a-z]+(-[a-z]+)*$/);
    }
  });

  it('carries the slug the validation pipe reports', () => {
    expect(PROBLEM_TYPE_SLUGS).toContain('validation-failed');
  });
});

describe('problemTypeUri', () => {
  it('builds an absolute URI whose last segment is the slug', () => {
    expect(problemTypeUri('validation-failed')).toBe(`${PROBLEM_TYPE_BASE_URI}validation-failed`);
    expect(problemTypeUri('not-found')).toMatch(/^https:\/\/\S+\/not-found$/);
  });
});

describe('problemTypeSlugFromUri', () => {
  it('round-trips every slug in the catalogue', () => {
    for (const slug of PROBLEM_TYPE_SLUGS) {
      expect(problemTypeSlugFromUri(problemTypeUri(slug))).toBe(slug);
    }
  });

  /**
   * A client that meets a newer server must reach its generic branch, not throw. This is the whole
   * reason the function returns `undefined` rather than asserting.
   */
  it('returns undefined for a type this version of the contract does not know', () => {
    expect(problemTypeSlugFromUri(`${PROBLEM_TYPE_BASE_URI}invented-later`)).toBeUndefined();
    expect(problemTypeSlugFromUri('https://example.com/problems/not-found')).toBeUndefined();
    expect(problemTypeSlugFromUri('not-found')).toBeUndefined();
  });
});

describe('problemDetailSchema', () => {
  it('parses the document the validation pipe produces, per-field paths included', () => {
    expect(problemDetailSchema.parse(validationFailed)).toStrictEqual(validationFailed);
  });

  /**
   * Extension members are how a specific failure says more than its class. Stripping them would
   * remove `retryAfter` from a throttle and `errors` from a rejected body — the parts a client
   * needs most.
   */
  it('preserves extension members it has no field for', () => {
    const throttled = {
      detail: 'Too many verification attempts.',
      instance: '/api/v1/auth/login',
      requestId: 'req-1',
      retryAfter: 30,
      status: 429,
      title: 'Too Many Requests',
      type: 'https://forge.dev/problems/rate-limited',
    };

    expect(problemDetailSchema.parse(throttled)).toStrictEqual(throttled);
  });

  it('rejects a document that is not RFC 9457', () => {
    expect(problemDetailSchema.safeParse({ ...validationFailed, status: 200 }).success).toBe(false);
    expect(problemDetailSchema.safeParse({ ...validationFailed, type: 'oops' }).success).toBe(
      false,
    );
    expect(
      problemDetailSchema.safeParse({ ...validationFailed, errors: [{ pointer: '#/email' }] })
        .success,
    ).toBe(false);
  });
});
