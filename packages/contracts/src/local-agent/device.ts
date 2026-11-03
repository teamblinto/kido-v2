import { z } from 'zod';

import {
  LOCAL_AGENT_DEVICE_TOKEN_PREFIX,
  localAgentProviderStatusSchema,
  localAgentWorkspaceSchema,
} from './provider';

/**
 * Paired devices and the pairing handshake (spec 040 § 3 decision 3, § 5), modelled on the OAuth
 * device authorization grant (RFC 8628): the companion holds the secret `deviceCode`, the person
 * approves the short `userCode` in BAIOS, and the companion receives its token exactly once.
 */

export const LOCAL_AGENT_PLATFORMS = ['windows', 'macos', 'linux'] as const;

export const localAgentPlatformSchema = z.enum(LOCAL_AGENT_PLATFORMS);

export type LocalAgentPlatform = z.output<typeof localAgentPlatformSchema>;

/** RFC 8628 § 6.1: consonants only, so a code cannot spell a word or mix up 0/O and 1/I. */
export const LOCAL_AGENT_USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

/** `XXXX-XXXX` over the alphabet above; typed by a person, so case and whitespace are forgiven. */
export const localAgentUserCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);

/** 32 random bytes, base64url and unpadded: the companion's secret half of a pairing. */
export const localAgentDeviceCodeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** `bld_` and 32 random bytes, base64url and unpadded; stored server-side only as its SHA-256. */
export const localAgentDeviceTokenSchema = z
  .string()
  .regex(new RegExp(`^${LOCAL_AGENT_DEVICE_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`));

const deviceName = z.string().trim().min(1).max(100);
const companionVersion = z.string().trim().min(1).max(64);

/** A paired device as its owner sees it (`GET /me/local-agents`). */
export const localAgentDeviceSchema = z.strictObject({
  companionVersion,
  createdAt: z.iso.datetime(),
  id: z.uuid(),
  lastSeenAt: z.iso.datetime().nullable(),
  name: deviceName,
  online: z.boolean(),
  platform: localAgentPlatformSchema,
  providers: z.array(localAgentProviderStatusSchema),
  workspaces: z.array(localAgentWorkspaceSchema),
});

export type LocalAgentDevice = z.output<typeof localAgentDeviceSchema>;

export const localAgentDeviceListSchema = z.strictObject({
  devices: z.array(localAgentDeviceSchema),
});

export type LocalAgentDeviceList = z.output<typeof localAgentDeviceListSchema>;

/** `POST /local-agent/pairings`, unauthenticated: the companion introduces itself. */
export const startPairingRequestSchema = z.strictObject({
  companionVersion,
  name: deviceName,
  platform: localAgentPlatformSchema,
});

export type StartPairingRequest = z.output<typeof startPairingRequestSchema>;

export const startPairingResponseSchema = z.strictObject({
  deviceCode: localAgentDeviceCodeSchema,
  expiresAt: z.iso.datetime(),
  intervalSeconds: z.number().int().min(1),
  userCode: localAgentUserCodeSchema,
  verificationUri: z.url(),
});

export type StartPairingResponse = z.output<typeof startPairingResponseSchema>;

/** `POST /local-agent/pairings/token`: the companion's poll. */
export const pairingTokenRequestSchema = z.strictObject({ deviceCode: localAgentDeviceCodeSchema });

export type PairingTokenRequest = z.output<typeof pairingTokenRequestSchema>;

/** The token is in exactly one answer, once; every other poll says where the pairing stands. */
export const pairingTokenResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.enum(['pending', 'denied', 'expired']) }),
  z.strictObject({
    deviceId: z.uuid(),
    deviceToken: localAgentDeviceTokenSchema,
    status: z.literal('approved'),
  }),
]);

export type PairingTokenResponse = z.output<typeof pairingTokenResponseSchema>;

/**
 * `GET /me/local-agents/pairings/:userCode`: what the person is about to approve. When and from
 * where it was requested, so a code someone else sent them (phishing) looks like what it is. The
 * address is coarse — an IPv4 /24 or an IPv6 /48, the rest zeroed — and `null` when unknown.
 */
export const pairingPreviewSchema = z.strictObject({
  companionVersion,
  expiresAt: z.iso.datetime(),
  name: deviceName,
  platform: localAgentPlatformSchema,
  requestedAt: z.iso.datetime(),
  requesterIp: z.string().max(64).nullable(),
});

export type PairingPreview = z.output<typeof pairingPreviewSchema>;

/** `POST /me/local-agents/pairings/approve` and `…/deny` take the same body. */
export const approvePairingRequestSchema = z.strictObject({ userCode: localAgentUserCodeSchema });

export type ApprovePairingRequest = z.output<typeof approvePairingRequestSchema>;
