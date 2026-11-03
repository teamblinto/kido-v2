import type { ByokRefusalReason } from '@repo/contracts';

import {
  ConflictError,
  DomainError,
  ServiceUnavailableError,
} from '../../../common/errors/domain-error';

/** `Retry-After` when the provider could not be reached to check a key (contracts § 1). */
export const VERIFY_RETRY_AFTER_SECONDS = 30;

/**
 * Research R11: no new problem slug — every BYOK refusal is an existing one carrying `reason`
 * from `BYOK_REFUSAL_REASONS`, which the settings page maps to its sentence.
 */
export function keyRefusal(
  reason: ByokRefusalReason,
  extensions: Record<string, unknown> = {},
): DomainError {
  switch (reason) {
    case 'wrong-shape':
      return new DomainError('validation-failed', 'That is not a key for this provider.', {
        ...extensions,
        reason,
      });
    case 'key-rejected':
      return new DomainError('validation-failed', 'The provider rejected this key.', {
        ...extensions,
        reason,
      });
    case 'could-not-verify':
      return new ServiceUnavailableError(
        'The provider could not be reached to check the key; try again shortly.',
        VERIFY_RETRY_AFTER_SECONDS,
        { ...extensions, reason },
      );
    case 'needs-reauth':
      return new ConflictError('The organisation’s key for this provider needs replacing.', {
        ...extensions,
        reason,
      });
  }
}
