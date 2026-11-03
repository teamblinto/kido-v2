import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENCY_KEY_MIN_LENGTH } from '@repo/contracts';

import { DomainError } from '../errors/domain-error';

/**
 * The header was not a key this server can store.
 *
 * 400 rather than 422: the value is part of the request's framing, not of the document being
 * validated, and `validation-failed` is what `ValidationPipe` answers about a body (ADR 006).
 */
export class IdempotencyKeyMalformedError extends DomainError {
  constructor() {
    super(
      'bad-request',
      `\`${IDEMPOTENCY_KEY_HEADER}\` must be a single value of at least ` +
        `${IDEMPOTENCY_KEY_MIN_LENGTH} characters from the set A-Z a-z 0-9 . _ ~ - — a UUID is the ` +
        'recommended value.',
    );
  }
}

/**
 * The key has already been used, for a different request.
 *
 * Its own slug rather than a bare `conflict`, because the client cannot act on "conflict": this one
 * says the fault is on its side and names the fix, which is to generate a key per request. Replying
 * with the first response instead would be worse than unhelpful — the caller would read a 2xx as
 * "the second request succeeded", and the effect it asked for would silently never have happened.
 */
export class IdempotencyKeyReusedError extends DomainError {
  constructor() {
    super(
      'idempotency-key-reused',
      `This \`${IDEMPOTENCY_KEY_HEADER}\` was already used for a different request. Use a new key ` +
        'for each distinct request, and reuse a key only to retry the request it was issued for.',
    );
  }
}

/**
 * A request with this key is running right now, and outlasted the time this one was willing to wait.
 *
 * Retryable, and that is the point: the alternative to answering is executing, and two clicks on
 * one button are two requests that must produce one effect. `retryAfter` rides as an RFC 9457
 * extension member — the same name `RateLimitedError` uses — so a client reads the wait from the
 * document without special-casing a header.
 */
export class IdempotencyKeyInFlightError extends DomainError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    const seconds = Math.max(1, Math.ceil(retryAfterSeconds));

    super(
      'idempotency-key-in-flight',
      `An earlier request with this \`${IDEMPOTENCY_KEY_HEADER}\` is still being processed. Retry ` +
        'with the same key to collect its response; it will not be executed twice.',
      { retryAfter: seconds },
    );
    this.retryAfterSeconds = seconds;
  }
}
