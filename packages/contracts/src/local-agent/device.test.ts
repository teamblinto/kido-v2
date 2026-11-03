import { describe, expect, it } from 'vitest';

import {
  approvePairingRequestSchema,
  localAgentDeviceListSchema,
  localAgentDeviceTokenSchema,
  pairingPreviewSchema,
  pairingTokenResponseSchema,
  startPairingRequestSchema,
  startPairingResponseSchema,
} from './device';

const AT = '2026-11-02T10:00:00.000Z';
const ID = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a';
const CODE = 'a'.repeat(40) + '_-9';

describe('pairing', () => {
  it('starts with a name, platform and version, and refuses anything else', () => {
    const body = { companionVersion: '0.1.0', name: 'Ada laptop', platform: 'windows' };
    expect(startPairingRequestSchema.parse(body)).toEqual(body);
    expect(startPairingRequestSchema.safeParse({ ...body, platform: 'android' }).success).toBe(
      false,
    );
    expect(startPairingRequestSchema.safeParse({ ...body, hostname: 'x' }).success).toBe(false);
  });

  it('answers a device code, a user code and where to approve it', () => {
    const answer = {
      deviceCode: CODE,
      expiresAt: AT,
      intervalSeconds: 5,
      userCode: 'BCDF-GHJK',
      verificationUri: 'https://baios.example/local-agents/pair',
    };
    expect(startPairingResponseSchema.parse(answer)).toEqual(answer);
    expect(startPairingResponseSchema.safeParse({ ...answer, deviceCode: 'short' }).success).toBe(
      false,
    );
  });

  it('forgives case and whitespace in a typed user code but not a vowel', () => {
    expect(approvePairingRequestSchema.parse({ userCode: ' bcdf-ghjk ' })).toEqual({
      userCode: 'BCDF-GHJK',
    });
    expect(approvePairingRequestSchema.safeParse({ userCode: 'ABCD-EFGH' }).success).toBe(false);
  });

  it('hands out a token only with approved', () => {
    for (const status of ['pending', 'denied', 'expired']) {
      expect(pairingTokenResponseSchema.parse({ status })).toEqual({ status });
    }
    const approved = {
      deviceId: ID,
      deviceToken: `bld_${CODE}`,
      status: 'approved',
    };
    expect(pairingTokenResponseSchema.parse(approved)).toEqual(approved);
    expect(pairingTokenResponseSchema.safeParse({ status: 'approved' }).success).toBe(false);
    expect(pairingTokenResponseSchema.safeParse({ ...approved, status: 'pending' }).success).toBe(
      false,
    );
  });

  it('requires the bld_ prefix on a device token', () => {
    expect(localAgentDeviceTokenSchema.safeParse(`bld_${CODE}`).success).toBe(true);
    expect(localAgentDeviceTokenSchema.safeParse(CODE).success).toBe(false);
  });

  it('previews what is about to be approved', () => {
    const preview = {
      companionVersion: '0.1.0',
      expiresAt: AT,
      name: 'Ada',
      platform: 'macos',
      requestedAt: AT,
      requesterIp: '203.0.113.0/24',
    };
    expect(pairingPreviewSchema.parse(preview)).toEqual(preview);
    expect(pairingPreviewSchema.parse({ ...preview, requesterIp: null }).requesterIp).toBeNull();
    // When and from where are part of what a person must see before approving.
    expect(pairingPreviewSchema.safeParse({ ...preview, requestedAt: undefined }).success).toBe(
      false,
    );
  });
});

describe('device list', () => {
  it('parses a device with no providers or workspaces yet', () => {
    const list = {
      devices: [
        {
          companionVersion: '0.1.0',
          createdAt: AT,
          id: ID,
          lastSeenAt: null,
          name: 'Ada laptop',
          online: false,
          platform: 'linux',
          providers: [],
          workspaces: [],
        },
      ],
    };
    expect(localAgentDeviceListSchema.parse(list)).toEqual(list);
    expect(
      localAgentDeviceListSchema.safeParse({
        devices: [{ ...list.devices[0], tokenHash: 'x' }],
      }).success,
    ).toBe(false);
  });
});
