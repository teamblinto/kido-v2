import { LOCAL_AGENT_DEVICE_TOKEN_PREFIX } from '@repo/contracts';
import { createHash, randomBytes } from 'node:crypto';

/**
 * The runner's secret (spec 040 § 3 decision 3). A 256-bit random value needs no slow hash: the
 * server keeps only its SHA-256, and a lookup by digest is an index probe, so no secret is ever
 * compared in the clear.
 */

/** `bld_` + 32 random bytes, base64url: handed to the runner once, stored only as its digest. */
export function mintDeviceToken(): string {
  return `${LOCAL_AGENT_DEVICE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
