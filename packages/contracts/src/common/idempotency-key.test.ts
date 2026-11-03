import { describe, expect, it } from 'vitest';

import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  idempotencyKeySchema,
} from './idempotency-key';

/** A UUID is the recommended value, and the only shape with a hyphen in it. */
const uuid = '018f4a1c-0000-7000-8000-000000000000';

describe('idempotencyKeySchema', () => {
  it('accepts the recommended value', () => {
    expect(idempotencyKeySchema.parse(uuid)).toBe(uuid);
  });

  it('rejects a key with too little entropy to own a replay slot', () => {
    expect(idempotencyKeySchema.safeParse('1').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('a'.repeat(IDEMPOTENCY_KEY_MIN_LENGTH - 1)).success).toBe(
      false,
    );
    expect(idempotencyKeySchema.safeParse('a'.repeat(IDEMPOTENCY_KEY_MIN_LENGTH)).success).toBe(
      true,
    );
  });

  it('bounds the Redis key derived from it', () => {
    expect(idempotencyKeySchema.safeParse('a'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH)).success).toBe(
      true,
    );
    expect(idempotencyKeySchema.safeParse('a'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1)).success).toBe(
      false,
    );
  });

  it('refuses anything that would need escaping in a key or a log line', () => {
    expect(idempotencyKeySchema.safeParse('key:with:colons!!').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('key with spaces!!').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('key/with/slashes').success).toBe(false);
  });

  it('trims the surrounding whitespace a header can pick up', () => {
    expect(idempotencyKeySchema.parse(`  ${'a'.repeat(20)}  `)).toBe('a'.repeat(20));
  });
});
