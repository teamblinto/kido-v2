import {
  localAgentDeviceCodeSchema,
  localAgentDeviceTokenSchema,
  localAgentUserCodeSchema,
} from '@repo/contracts';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { mintDeviceCode, mintDeviceToken, mintUserCode, sha256 } from './secrets';

describe('secrets', () => {
  it('mints device tokens the contract accepts, never the same twice', () => {
    const token = mintDeviceToken();

    expect(token.startsWith('bld_')).toBe(true);
    expect(localAgentDeviceTokenSchema.safeParse(token).success).toBe(true);
    expect(mintDeviceToken()).not.toBe(token);
  });

  it('mints device codes and user codes the contract accepts', () => {
    expect(localAgentDeviceCodeSchema.safeParse(mintDeviceCode()).success).toBe(true);

    for (let index = 0; index < 50; index += 1) {
      const code = mintUserCode();

      expect(code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
      expect(localAgentUserCodeSchema.parse(code)).toBe(code);
    }
  });

  it('keeps only the hex SHA-256 of a secret', () => {
    const token = mintDeviceToken();

    expect(sha256(token)).toBe(createHash('sha256').update(token).digest('hex'));
    expect(sha256(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(token)).not.toContain(token);
  });
});
