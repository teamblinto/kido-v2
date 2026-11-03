import type { WebhookConflictReason } from '@repo/contracts';

import { ConflictError } from '../../common/errors/domain-error';
import type { WEBHOOK_ENDPOINTS_PER_ORG } from './webhooks.constants';

const DETAIL: Record<WebhookConflictReason, string> = {
  'delivery-expired': 'This delivery is too old to redeliver.',
  'delivery-in-flight': 'This delivery is already being sent.',
  // FR-003: fixed, and says nothing about which range the address fell in.
  'destination-not-allowed': 'That destination is not allowed.',
  'endpoint-limit': 'This organisation already has the most webhook endpoints it can have.',
  'endpoint-not-enabled': 'Only an enabled endpoint can be sent a test.',
  'invalid-url': 'That is not a valid webhook URL.',
  'project-not-in-org': 'That project is not in this organisation.',
};

/**
 * A refusal before anything is written, following `domain.errors.ts`. `endpoint-limit` carries the
 * `limit` that was reached.
 */
export function webhookConflict(
  reason: WebhookConflictReason,
  extensions: { limit?: typeof WEBHOOK_ENDPOINTS_PER_ORG } = {},
): ConflictError {
  return new ConflictError(DETAIL[reason], { ...extensions, reason });
}
