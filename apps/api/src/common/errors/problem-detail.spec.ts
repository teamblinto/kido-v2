import { createProblemDetail, problemDetailSchema } from './problem-detail';
import { PROBLEM_TYPES, problemTypeUri } from './problem-types';

describe('createProblemDetail', () => {
  it('emits every RFC 9457 member plus the correlation id', () => {
    const problem = createProblemDetail({
      detail: 'No workspace matches that identifier.',
      instance: '/api/v1/workspaces/42',
      requestId: '01J0000000000000000000',
      type: 'not-found',
    });

    expect(problem).toStrictEqual({
      detail: 'No workspace matches that identifier.',
      instance: '/api/v1/workspaces/42',
      requestId: '01J0000000000000000000',
      status: 404,
      title: PROBLEM_TYPES['not-found'].title,
      type: problemTypeUri('not-found'),
    });
    expect(problemDetailSchema.safeParse(problem).success).toBe(true);
  });

  it('takes status and title from the catalogue rather than the caller', () => {
    const problem = createProblemDetail({
      detail: 'Slow down.',
      instance: '/api/v1/sessions',
      requestId: 'req-1',
      type: 'rate-limited',
    });

    expect(problem.status).toBe(PROBLEM_TYPES['rate-limited'].status);
    expect(problem.title).toBe(PROBLEM_TYPES['rate-limited'].title);
  });

  it('merges extension members alongside the standard ones', () => {
    const problem = createProblemDetail({
      detail: 'Slow down.',
      extensions: { retryAfter: 30 },
      instance: '/api/v1/sessions',
      requestId: 'req-1',
      type: 'rate-limited',
    });

    expect(problem.retryAfter).toBe(30);
    expect(problemDetailSchema.safeParse(problem).success).toBe(true);
  });

  it('never lets an extension member overwrite a reserved member', () => {
    const problem = createProblemDetail({
      detail: 'Slow down.',
      extensions: { detail: 'leaked', status: 200, type: 'https://evil.example/' },
      instance: '/api/v1/sessions',
      requestId: 'req-1',
      type: 'rate-limited',
    });

    expect(problem.detail).toBe('Slow down.');
    expect(problem.status).toBe(429);
    expect(problem.type).toBe(problemTypeUri('rate-limited'));
  });
});

describe('problemDetailSchema', () => {
  it('rejects a document missing a required member', () => {
    expect(
      problemDetailSchema.safeParse({
        detail: 'x',
        instance: '/api/v1',
        status: 404,
        title: 'Not Found',
        type: problemTypeUri('not-found'),
      }).success,
    ).toBe(false);
  });

  it('rejects a type that is not an absolute URI', () => {
    expect(
      problemDetailSchema.safeParse({
        detail: 'x',
        instance: '/api/v1',
        requestId: 'req-1',
        status: 404,
        title: 'Not Found',
        type: 'not-found',
      }).success,
    ).toBe(false);
  });
});
