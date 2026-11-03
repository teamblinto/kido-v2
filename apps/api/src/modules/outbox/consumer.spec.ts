import { describe, expect, it } from 'vitest';

import { classifyHttpStatus, RetryableFailure } from './consumer';

/**
 * FR-017: classification is the consumer's, and the base retries exactly one class. The helper
 * exists so every consumer that talks HTTP draws the same line: a 429 and any 5xx are the
 * upstream's problem for a while; everything else is ours and retrying it would only repeat it.
 */
describe('classifyHttpStatus', () => {
  it('classifies 429 and every 5xx as retryable', () => {
    for (const status of [429, 500, 502, 503, 504, 599]) {
      expect(classifyHttpStatus(status), `status ${status}`).toBe('retryable');
    }
  });

  it('classifies every other status as terminal', () => {
    for (const status of [200, 400, 401, 403, 404, 422]) {
      expect(classifyHttpStatus(status), `status ${status}`).toBe('terminal');
    }
  });
});

describe('RetryableFailure', () => {
  it('carries the reason and the cause and names itself', () => {
    const cause = new Error('ETIMEDOUT');
    const failure = new RetryableFailure('timeout', cause);

    expect(failure).toBeInstanceOf(Error);
    expect(failure.cause).toBe(cause);
    expect(failure.name).toBe('RetryableFailure');
    expect(failure.reason).toBe('timeout');
  });
});
