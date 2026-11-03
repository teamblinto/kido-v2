import { describe, expect, it } from 'vitest';

import { ApiProblem } from '@/lib/api/problem';

import { byosRefusalCopy } from './linked-account-copy';

const problem = (extra: Record<string, unknown>) =>
  new ApiProblem(409, {
    detail: 'Your subscription needs reconnecting in Settings › Account.',
    instance: '/api/v1/orgs/o/projects/p/runs',
    requestId: '1',
    status: 409,
    title: 'Conflict',
    type: 'https://forge.dev/problems/conflict',
    ...extra,
  });

describe('byosRefusalCopy', () => {
  it('says whose account needs reconnecting for a 409 subscription-needs-reauth', () => {
    expect(
      byosRefusalCopy(problem({ provider: 'anthropic', reason: 'subscription-needs-reauth' })),
    ).toBe('Your Claude account needs reconnecting before it can be used.');
    expect(
      byosRefusalCopy(problem({ provider: 'openai', reason: 'subscription-needs-reauth' })),
    ).toBe('Your OpenAI account needs reconnecting before it can be used.');
  });

  it('leaves a conflict without a BYOS reason, and a non-problem, to the shared catalogue', () => {
    expect(byosRefusalCopy(problem({}))).toBeUndefined();
    expect(byosRefusalCopy(new Error('network'))).toBeUndefined();
  });
});
