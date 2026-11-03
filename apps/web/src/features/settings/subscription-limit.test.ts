import { PROBLEM_TYPE_BASE_URI } from '@repo/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiProblem } from '@/lib/api/problem';
import { limitOfModel, limitOfRefusal, limitSentence } from './subscription-limit';

function conflict(extensions: Record<string, unknown>): ApiProblem {
  return new ApiProblem(409, {
    detail: 'Your subscription is rate-limited.',
    instance: '/api/v1/orgs/o/projects/p/runs',
    requestId: 'req_1',
    status: 409,
    title: 'Conflict',
    type: `${PROBLEM_TYPE_BASE_URI}conflict`,
    ...extensions,
  });
}

/** Spec 032 T048: the limit, from the catalogue or from a `409 subscription-limited`. */
describe('subscription limit', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-24T08:00:00.000Z'));
    vi.stubEnv('TZ', 'UTC');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('reads a 409 subscription-limited refusal the same way as the catalogue entry', () => {
    const limit = limitOfRefusal(
      conflict({
        alternativeMode: 'PLATFORM',
        provider: 'anthropic',
        reason: 'subscription-limited',
        resetsAt: '2026-09-24T09:22:00.000Z',
      }),
    );

    expect(limit).toEqual({
      alternativeMode: 'PLATFORM',
      provider: 'anthropic',
      resetsAt: '2026-09-24T09:22:00.000Z',
    });
    expect(limitSentence(limit!)).toMatch(/^Your Claude subscription is limited until 09:22/);
  });

  it('a refusal with no organisation credential offers none; other refusals are not limits', () => {
    expect(
      limitOfRefusal(
        conflict({ alternativeMode: null, provider: 'openai', reason: 'subscription-limited' }),
      ),
    ).toEqual({ provider: 'openai' });
    expect(limitSentence({ provider: 'openai' })).toBe(
      'Your OpenAI subscription is limited — try again later',
    );
    expect(limitOfRefusal(conflict({ reason: 'subscription-needs-reauth' }))).toBeUndefined();
    expect(limitOfRefusal(new Error('boom'))).toBeUndefined();
  });

  it('a catalogue entry without limitedUntil is not limited', () => {
    expect(limitOfModel(undefined)).toBeUndefined();
    expect(
      limitOfModel({
        available: true,
        credentialMode: 'BYOS',
        description: 'd',
        id: 'm',
        name: 'M',
        provider: 'anthropic',
        shortName: 'M',
      }),
    ).toBeUndefined();
  });
});
