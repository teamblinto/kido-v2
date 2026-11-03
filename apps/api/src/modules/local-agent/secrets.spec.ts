import { localAgentDeviceTokenSchema } from '@repo/contracts';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { mintDeviceToken, sha256 } from './secrets';

describe('secrets', () => {
  it('mints device tokens the contract accepts, never the same twice', () => {
    const token = mintDeviceToken();

    expect(token.startsWith('bld_')).toBe(true);
    expect(localAgentDeviceTokenSchema.safeParse(token).success).toBe(true);
    expect(mintDeviceToken()).not.toBe(token);
  });

  it('keeps only the hex SHA-256 of a secret', () => {
    const token = mintDeviceToken();

    expect(sha256(token)).toBe(createHash('sha256').update(token).digest('hex'));
    expect(sha256(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(token)).not.toContain(token);
  });
});
