import { WEBHOOK_ATTEMPT_FAILURES } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { type AttemptOutcome, classifyAttempt } from './classify';

const outcome = (overrides: Partial<AttemptOutcome>): AttemptOutcome => ({
  error: null,
  headers: {},
  status: null,
  ...overrides,
});

/** Research R7's table, row by row, plus a 2xx over 64 KB. */
describe('classifyAttempt', () => {
  it.each([200, 201, 204, 299])('%i within the limits → success, no failure', (status) => {
    expect(classifyAttempt(outcome({ status }))).toEqual({
      failure: null,
      kind: 'success',
      retryAfterMs: null,
    });
  });

  it.each([
    ['timeout', 'timeout'],
    ['connection-failed', 'connection-failed'],
    ['tls-failed', 'tls-failed'],
    ['dns-failed', 'dns-failed'],
  ] as const)('%s → retryable, recorded as %s', (error, failure) => {
    expect(classifyAttempt(outcome({ error }))).toEqual({
      failure,
      kind: 'retryable',
      retryAfterMs: null,
    });
  });

  it('a timeout after the response head arrived is still retryable timeout', () => {
    expect(classifyAttempt(outcome({ error: 'timeout', status: 200 }))).toMatchObject({
      failure: 'timeout',
      kind: 'retryable',
    });
  });

  it.each([429, 500, 502, 503, 504, 599])('%i → retryable http-error', (status) => {
    expect(classifyAttempt(outcome({ status }))).toEqual({
      failure: 'http-error',
      kind: 'retryable',
      retryAfterMs: null,
    });
  });

  it.each([429, 503])('%i with Retry-After in seconds carries it in ms', (status) => {
    expect(classifyAttempt(outcome({ headers: { 'retry-after': '120' }, status }))).toMatchObject({
      kind: 'retryable',
      retryAfterMs: 120_000,
    });
  });

  it('Retry-After as an HTTP date is measured from now', () => {
    const now = new Date('2026-09-23T12:00:00Z');
    expect(
      classifyAttempt(
        outcome({ headers: { 'retry-after': 'Wed, 23 Sep 2026 12:05:00 GMT' }, status: 503 }),
        now,
      ),
    ).toMatchObject({ retryAfterMs: 300_000 });
  });

  it('an unparseable, negative or date-without-now Retry-After is ignored', () => {
    for (const value of ['soon', '-5', 'Wed, 23 Sep 2026 12:05:00 GMT']) {
      expect(
        classifyAttempt(outcome({ headers: { 'retry-after': value }, status: 429 })),
      ).toMatchObject({ retryAfterMs: null });
    }
  });

  it('Retry-After on a 500 is not honoured', () => {
    expect(
      classifyAttempt(outcome({ headers: { 'retry-after': '60' }, status: 500 })),
    ).toMatchObject({ retryAfterMs: null });
  });

  it.each([301, 302, 303, 307, 308])('%i → terminal redirect-not-followed', (status) => {
    expect(classifyAttempt(outcome({ status }))).toEqual({
      failure: 'redirect-not-followed',
      kind: 'terminal',
      retryAfterMs: null,
    });
  });

  it.each([400, 401, 403, 404, 410, 422])('%i → terminal http-error', (status) => {
    expect(classifyAttempt(outcome({ status }))).toEqual({
      failure: 'http-error',
      kind: 'terminal',
      retryAfterMs: null,
    });
  });

  it('every resolved address disallowed → terminal destination-refused', () => {
    expect(classifyAttempt(outcome({ error: 'destination-refused' }))).toEqual({
      failure: 'destination-refused',
      kind: 'terminal',
      retryAfterMs: null,
    });
  });

  it.each([200, 503])('a %i body over 64 KB → terminal response-too-large', (status) => {
    expect(classifyAttempt(outcome({ error: 'response-too-large', status }))).toEqual({
      failure: 'response-too-large',
      kind: 'terminal',
      retryAfterMs: null,
    });
  });

  it('a status outside 100–599, or none without an error, is a retryable connection failure', () => {
    expect(classifyAttempt(outcome({ status: 999 }))).toMatchObject({
      failure: 'connection-failed',
      kind: 'retryable',
    });
    expect(classifyAttempt(outcome({}))).toMatchObject({
      failure: 'connection-failed',
      kind: 'retryable',
    });
  });

  it('every failure it records is in the contract vocabulary', () => {
    const outcomes: AttemptOutcome[] = [
      outcome({ status: 302 }),
      outcome({ status: 404 }),
      outcome({ status: 503 }),
      ...(['timeout', 'connection-failed', 'tls-failed', 'dns-failed'] as const).map((error) =>
        outcome({ error }),
      ),
      outcome({ error: 'destination-refused' }),
      outcome({ error: 'response-too-large', status: 200 }),
    ];
    for (const each of outcomes) {
      expect(WEBHOOK_ATTEMPT_FAILURES).toContain(classifyAttempt(each).failure);
    }
  });
});
