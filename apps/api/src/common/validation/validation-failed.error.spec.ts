import { PROBLEM_TYPES, problemTypeForStatus } from '../errors/problem-types';
import { ValidationFailedError } from './validation-failed.error';

const issue = { code: 'invalid_format', detail: 'Invalid email address', pointer: '#/email' };

describe('ValidationFailedError', () => {
  it('maps through the catalogue to the validation-failed slug', () => {
    const error = new ValidationFailedError('body', [issue]);

    expect(error.type).toBe('validation-failed');
    expect(error.status).toBe(422);
    expect(error.title).toBe('Validation Failed');
  });

  it('names the part of the request that was rejected', () => {
    expect(new ValidationFailedError('body', [issue]).detail).toBe(
      'The request body failed validation.',
    );
    expect(new ValidationFailedError('query', [issue]).detail).toBe(
      'The request query parameters failed validation.',
    );
    expect(new ValidationFailedError('param', [issue]).detail).toBe(
      'The request path parameters failed validation.',
    );
  });

  it('carries the field list as an RFC 9457 extension member', () => {
    const error = new ValidationFailedError('body', [issue]);

    expect(error.extensions).toStrictEqual({ errors: [issue] });
  });

  /**
   * The collision ADR 006 settles, as a test rather than a comment.
   *
   * `problemTypeForStatus` is a `Map` keyed by status, so two slugs sharing 400 would not fail
   * loudly — the later declaration would simply win, and every `BadRequestException` the framework
   * throws would start reporting itself as `validation-failed`. Moving this off 422 has to break
   * this test first.
   */
  it('does not take the status bad-request already owns', () => {
    expect(PROBLEM_TYPES['validation-failed'].status).toBe(422);
    expect(PROBLEM_TYPES['bad-request'].status).toBe(400);
    expect(problemTypeForStatus(400)).toBe('bad-request');
    expect(problemTypeForStatus(422)).toBe('validation-failed');
  });
});
