/**
 * One attempt's class (spec 029 research R7): `success`, `retryable` on the schedule, or
 * `terminal`, with the failure recorded in `WEBHOOK_ATTEMPT_FAILURES`' vocabulary.
 *
 * | Outcome                                            | Class     | Failure                                   |
 * | -------------------------------------------------- | --------- | ----------------------------------------- |
 * | 2xx within the limits                              | success   | none                                      |
 * | timeout, connect error, reset, TLS handshake error | retryable | timeout, connection-failed, tls-failed    |
 * | no address, or DNS failure                         | retryable | dns-failed                                |
 * | 429, 5xx                                           | retryable | http-error (the status is on the attempt) |
 * | 3xx                                                | terminal  | redirect-not-followed                     |
 * | other 4xx                                          | terminal  | http-error                                |
 * | every resolved address disallowed                  | terminal  | destination-refused                       |
 * | response body over 64 KB, whatever the status      | terminal  | response-too-large                        |
 *
 * A `Retry-After` on a 429 or 503 is returned in milliseconds; the schedule decides whether it
 * replaces the next gap.
 */
import type { WebhookAttemptFailure } from '@repo/contracts';

import type { TransportResult } from './safe-transport';

export type AttemptOutcome = Pick<TransportResult, 'error' | 'headers' | 'status'>;

export interface AttemptClass {
  readonly kind: 'retryable' | 'success' | 'terminal';
  readonly failure: WebhookAttemptFailure | null;
  readonly retryAfterMs: number | null;
}

const retryable = (failure: WebhookAttemptFailure, retryAfterMs: number | null = null) =>
  ({ failure, kind: 'retryable', retryAfterMs }) as const satisfies AttemptClass;
const terminal = (failure: WebhookAttemptFailure) =>
  ({ failure, kind: 'terminal', retryAfterMs: null }) as const satisfies AttemptClass;

/** `now` is only needed to read a `Retry-After` given as an HTTP date. */
export function classifyAttempt(outcome: AttemptOutcome, now?: Date): AttemptClass {
  switch (outcome.error) {
    case 'response-too-large':
    case 'destination-refused':
      return terminal(outcome.error);
    case 'timeout':
    case 'connection-failed':
    case 'tls-failed':
    case 'dns-failed':
      return retryable(outcome.error);
    case null:
      break;
  }

  const { status } = outcome;
  if (status === null || !Number.isInteger(status) || status < 100 || status > 599) {
    return retryable('connection-failed');
  }
  if (status >= 200 && status < 300) return { failure: null, kind: 'success', retryAfterMs: null };
  if (status === 429 || status === 503) {
    return retryable('http-error', retryAfterMs(outcome.headers['retry-after'], now));
  }
  if (status >= 500) return retryable('http-error');
  if (status >= 300 && status < 400) return terminal('redirect-not-followed');
  return terminal('http-error');
}

/** `Retry-After` as delay-seconds, or as an HTTP date measured from `now`; null otherwise. */
function retryAfterMs(value: string | undefined, now: Date | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  if (now === undefined) return null;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now.getTime());
}
