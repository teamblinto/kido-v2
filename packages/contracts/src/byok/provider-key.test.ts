import { describe, expect, it } from 'vitest';

import {
  BYOK_REFUSAL_REASONS,
  LLM_PROVIDERS,
  providerKeyListSchema,
  providerKeySchema,
  putProviderKeyRequestSchema,
} from './provider-key';

const UUID = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a';

const key = {
  addedAt: '2026-09-21T10:00:00.000Z',
  addedBy: { id: UUID, name: 'Ada' },
  fingerprint: 'sha256:abc',
  health: 'healthy',
  id: UUID,
  lastFour: 'x9Qz',
  lastVerifiedAt: '2026-09-21T10:00:00.000Z',
  provider: 'anthropic',
};

describe('byok enums', () => {
  it('match contracts § 1', () => {
    expect(LLM_PROVIDERS).toEqual(['anthropic', 'openai']);
    expect(BYOK_REFUSAL_REASONS).toEqual([
      'wrong-shape',
      'key-rejected',
      'could-not-verify',
      'needs-reauth',
    ]);
  });
});

describe('providerKeySchema', () => {
  it('accepts a key record and never an apiKey field', () => {
    expect(providerKeySchema.safeParse(key)).toEqual({ data: key, success: true });
    expect(providerKeySchema.safeParse({ ...key, apiKey: 'sk-ant-x' }).success).toBe(false);
    expect(providerKeySchema.safeParse({ ...key, addedBy: null }).success).toBe(true);
  });

  it('refuses an unknown provider or health', () => {
    expect(providerKeySchema.safeParse({ ...key, provider: 'github' }).success).toBe(false);
    expect(providerKeySchema.safeParse({ ...key, health: 'broken' }).success).toBe(false);
  });

  it('lists keys strictly', () => {
    expect(providerKeyListSchema.safeParse({ keys: [key] }).success).toBe(true);
    expect(providerKeyListSchema.safeParse({ keys: [key], extra: 1 }).success).toBe(false);
  });
});

describe('putProviderKeyRequestSchema', () => {
  it('trims and bounds the key to 20..512 characters', () => {
    expect(putProviderKeyRequestSchema.parse({ apiKey: `  ${'a'.repeat(20)}  ` })).toEqual({
      apiKey: 'a'.repeat(20),
    });
    expect(putProviderKeyRequestSchema.safeParse({ apiKey: 'a'.repeat(19) }).success).toBe(false);
    expect(putProviderKeyRequestSchema.safeParse({ apiKey: 'a'.repeat(513) }).success).toBe(false);
  });

  it('refuses an undeclared field', () => {
    expect(
      putProviderKeyRequestSchema.safeParse({ apiKey: 'a'.repeat(20), provider: 'openai' }).success,
    ).toBe(false);
  });
});
