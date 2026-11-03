import type { WebhookAttemptFailure, WebhookConflictReason } from '@repo/contracts';

import { ApiProblem, messageFor } from '@/lib/api/problem';

/** Copy for every `WEBHOOK_CONFLICT_REASONS` value (a `409`'s `reason`). */
export const WEBHOOK_CONFLICT_COPY: Readonly<Record<WebhookConflictReason, string>> = {
  'delivery-expired': 'This delivery is too old to replay. Its body is no longer kept.',
  'delivery-in-flight': 'This delivery is being sent right now. Try again in a moment.',
  'destination-not-allowed':
    'That URL points at a private or reserved address. Use a public https address.',
  'endpoint-limit': 'An organisation can have at most 20 endpoints. Remove one first.',
  'endpoint-not-enabled': 'Enable this endpoint before sending a test.',
  'invalid-url':
    'That is not a valid https URL. It must be under 2,048 characters and carry no credentials.',
  'project-not-in-org': 'A selected project is not in this organisation.',
};

/** Copy for every `WEBHOOK_ATTEMPT_FAILURES` value. */
export const WEBHOOK_FAILURE_COPY: Readonly<Record<WebhookAttemptFailure, string>> = {
  'connection-failed': 'The connection could not be made.',
  'destination-refused': 'The address resolved to a private or reserved network.',
  'dns-failed': 'The host name did not resolve.',
  'http-error': 'The receiver answered with an error status.',
  'redirect-not-followed': 'The receiver redirected. Redirects are not followed.',
  'response-too-large': 'The response was over 64 KB.',
  timeout: 'The receiver did not answer within 10 seconds.',
  'tls-failed': 'The TLS handshake failed.',
};

function isConflictReason(value: unknown): value is WebhookConflictReason {
  return typeof value === 'string' && Object.hasOwn(WEBHOOK_CONFLICT_COPY, value);
}

/** A refusal on any webhook route, put into words. */
export function webhookErrorCopy(error: unknown): string {
  const reason = ApiProblem.is(error, 'conflict') ? error.detail?.reason : undefined;

  return isConflictReason(reason) ? WEBHOOK_CONFLICT_COPY[reason] : messageFor(error);
}
