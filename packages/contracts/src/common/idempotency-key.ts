import { z } from 'zod';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/**
 * A key shorter than this has too little entropy to be safe as a replay key: §03 stores the key
 * plus a hash of the body for 24 h, so two callers that happen to choose `1` are two callers
 * sharing a replay slot. A UUID — the recommended value — is 36 characters.
 */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 16;

/** Bounds the Redis key the idempotency store derives from this value. */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

/**
 * The value of the `Idempotency-Key` header on every unsafe endpoint (§03). It is opaque to the
 * server — the alphabet is the RFC 3986 unreserved set purely so the key can be interpolated into
 * a Redis key and a log line without escaping, which is the same reason `cursorSchema` is
 * restricted.
 */
export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(IDEMPOTENCY_KEY_MIN_LENGTH)
  .max(IDEMPOTENCY_KEY_MAX_LENGTH)
  .regex(/^[A-Za-z0-9._~-]+$/u)
  .meta({
    description:
      'A client-generated key that makes a repeated unsafe request return the original response ' +
      'rather than repeating its effect. A UUID is the recommended value.',
  });

export type IdempotencyKey = z.output<typeof idempotencyKeySchema>;
