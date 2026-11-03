import { LOCAL_AGENT_DEVICE_TOKEN_PREFIX, LOCAL_AGENT_USER_CODE_ALPHABET } from '@repo/contracts';
import { createHash, randomBytes, randomInt } from 'node:crypto';

/**
 * The bridge's secrets (spec 040 § 3 decision 3). 256-bit random values need no slow hash: the
 * server keeps only their SHA-256, and a lookup by digest is an index probe, so no secret is ever
 * compared in the clear.
 */

/** `bld_` + 32 random bytes, base64url: shown to the companion once, stored only as its digest. */
export function mintDeviceToken(): string {
  return `${LOCAL_AGENT_DEVICE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** The companion's secret half of a pairing: 32 random bytes, base64url. */
export function mintDeviceCode(): string {
  return randomBytes(32).toString('base64url');
}

/** `XXXX-XXXX` over the consonant alphabet (RFC 8628 § 6.1): what the person types or clicks. */
export function mintUserCode(): string {
  const pick = () =>
    LOCAL_AGENT_USER_CODE_ALPHABET[randomInt(LOCAL_AGENT_USER_CODE_ALPHABET.length)]!;
  const half = () => Array.from({ length: 4 }, pick).join('');

  return `${half()}-${half()}`;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
