import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import { classify, ProviderError, type ProviderFailureClass, TRANSIENT } from './provider-error';

/** A body string that must never survive classification (FR-023). */
const SENTINEL = 'SENTINEL-body-7f3a9c';
const REQUEST_ID = 'req_0123456789abcdef';

function headers(extra: Record<string, string> = {}): Headers {
  return new Headers({ 'request-id': REQUEST_ID, 'content-type': 'application/json', ...extra });
}

/** The API's error envelope, built the way `APIError.generate` receives it. */
function body(
  type: string,
  message: string,
): { type: 'error'; error: { type: string; message: string } } {
  return { type: 'error', error: { type, message: `${message} ${SENTINEL}` } };
}

/** Constructs an SDK status error exactly as `APIError.generate` does: `(status, body, message, headers, type)`. */
function statusError(
  ctor: new (...args: never[]) => Error,
  status: number,
  type: string,
  message = 'nope',
): Error {
  const Ctor = ctor as new (
    status: number,
    error: unknown,
    message: string | undefined,
    headers: Headers,
    type: string,
  ) => Error;
  return new Ctor(status, body(type, message), undefined, headers(), type);
}

const CASES: readonly {
  readonly name: string;
  readonly error: () => unknown;
  readonly expected: ProviderFailureClass;
}[] = [
  {
    name: 'AuthenticationError',
    error: () => statusError(Anthropic.AuthenticationError, 401, 'authentication_error'),
    expected: 'unauthorised',
  },
  {
    name: 'PermissionDeniedError',
    error: () => statusError(Anthropic.PermissionDeniedError, 403, 'permission_error'),
    expected: 'unauthorised',
  },
  {
    name: 'RateLimitError',
    error: () => statusError(Anthropic.RateLimitError, 429, 'rate_limit_error'),
    expected: 'rate-limited',
  },
  {
    name: 'InternalServerError 529 overloaded_error',
    error: () => statusError(Anthropic.InternalServerError, 529, 'overloaded_error'),
    expected: 'overloaded',
  },
  {
    name: 'InternalServerError 500',
    error: () => statusError(Anthropic.InternalServerError, 500, 'api_error'),
    expected: 'unavailable',
  },
  {
    name: 'APIConnectionTimeoutError',
    error: () => new Anthropic.APIConnectionTimeoutError({ message: SENTINEL }),
    expected: 'timeout',
  },
  {
    name: 'APIConnectionError',
    error: () => new Anthropic.APIConnectionError({ cause: new Error(SENTINEL) }),
    expected: 'connection-lost',
  },
  {
    name: 'BadRequestError',
    error: () => statusError(Anthropic.BadRequestError, 400, 'invalid_request_error'),
    expected: 'rejected',
  },
  {
    name: 'BadRequestError naming the context window',
    error: () =>
      statusError(
        Anthropic.BadRequestError,
        400,
        'invalid_request_error',
        'prompt is too long: 250000 tokens > 200000 maximum',
      ),
    expected: 'context-too-long',
  },
  {
    name: 'NotFoundError',
    error: () => statusError(Anthropic.NotFoundError, 404, 'not_found_error'),
    expected: 'rejected',
  },
  {
    name: 'a plain Error',
    error: () => new Error(SENTINEL),
    expected: 'malformed-response',
  },
];

describe('classify', () => {
  it.each(CASES)('classifies each SDK error class: $name → $expected', ({ error, expected }) => {
    const classified = classify(error());

    expect(classified).toBeInstanceOf(ProviderError);
    expect(classified.class).toBe(expected);
  });

  it('marks exactly the transient classes transient', () => {
    const transient = CASES.filter(({ error }) => classify(error()).transient).map(
      ({ expected }) => expected,
    );

    expect(new Set(transient)).toEqual(
      new Set([
        'rate-limited',
        'overloaded',
        'unavailable',
        'timeout',
        'connection-lost',
        'malformed-response',
      ]),
    );
    expect(new Set(transient)).toEqual(TRANSIENT);
  });

  it('keeps the request id and nothing else', () => {
    for (const { error } of CASES) {
      const raw = error();
      const classified = classify(raw);

      expect(classified.message).not.toContain(SENTINEL);
      for (const key of Object.getOwnPropertyNames(classified)) {
        expect(String((classified as unknown as Record<string, unknown>)[key])).not.toContain(
          SENTINEL,
        );
      }
      expect(JSON.stringify(classified)).not.toContain(SENTINEL);
      expect(classified).not.toHaveProperty('cause');
      expect(classified).not.toHaveProperty('error');
      expect(classified).not.toHaveProperty('headers');

      if (raw instanceof Anthropic.APIError && raw.status !== undefined) {
        expect(classified.requestId).toBe(REQUEST_ID);
        expect(classified.status).toBe(raw.status);
      } else {
        expect(classified.requestId).toBeUndefined();
      }
    }
  });

  it("a ProviderError's message is its class", () => {
    for (const { error, expected } of CASES) {
      expect(classify(error()).message).toBe(expected);
    }
    expect(new ProviderError('refused').message).toBe('refused');
  });
});
