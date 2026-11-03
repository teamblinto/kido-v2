import { describe, expect, it } from 'vitest';

import { VERSION_LOCAL_PLACEHOLDER, versionResponseSchema } from './version';

/** What a deployed image answers: a digest, the commit it was built from, and when. */
const deployed = {
  builtAt: '2026-09-22T11:04:19.000Z',
  commit: '38c99c8f1ab4e0c6d2f5a7b9c1e3d5f7a9b1c3d5',
  digest: 'sha256:9c1f0ab2cd3ef45678901234567890abcdef1234567890abcdef1234567890ab',
};

describe('versionResponseSchema', () => {
  it('accepts the three fields a deployed image answers with', () => {
    expect(versionResponseSchema.parse(deployed)).toStrictEqual(deployed);
  });

  it('accepts what local answers, so the route works everywhere', () => {
    const local = {
      builtAt: new Date().toISOString(),
      commit: VERSION_LOCAL_PLACEHOLDER,
      digest: VERSION_LOCAL_PLACEHOLDER,
    };

    expect(versionResponseSchema.parse(local)).toStrictEqual(local);
  });

  it('refuses an undeclared key rather than passing it on', () => {
    expect(versionResponseSchema.safeParse({ ...deployed, branch: 'main' }).success).toBe(false);
  });

  it('requires every one of the three fields', () => {
    for (const key of ['builtAt', 'commit', 'digest'] as const) {
      const rest: Record<string, unknown> = { ...deployed };

      delete rest[key];

      expect(versionResponseSchema.safeParse(rest).success).toBe(false);
    }
  });

  it('refuses an empty digest or commit — a blank is not an identity', () => {
    expect(versionResponseSchema.safeParse({ ...deployed, digest: '' }).success).toBe(false);
    expect(versionResponseSchema.safeParse({ ...deployed, commit: '' }).success).toBe(false);
  });

  it('refuses a builtAt that is not an ISO 8601 instant', () => {
    expect(versionResponseSchema.safeParse({ ...deployed, builtAt: 'yesterday' }).success).toBe(
      false,
    );
  });
});
