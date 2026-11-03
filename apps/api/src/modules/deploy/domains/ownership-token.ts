import { randomBytes } from 'node:crypto';

/**
 * The per-record ownership proof of spec 028 (research R3, FR-007): the member publishes
 * `forge-verify=<token>` in a TXT record at `_forge-challenge.<hostname>`, and the domain is
 * registered at the edge only once that record is seen.
 *
 * The token is 20 random bytes (160 bits) as 32 lowercase RFC 4648 base32 characters, with no
 * padding. It is generated once per domain record, replaced on retry and never reused, and it is
 * shown only to the member who can manage the domain. Lowercase base32 survives DNS providers that
 * fold case and needs no quoting inside a TXT string.
 */

/** Returns `size` random bytes. Injected so a spec can make the token deterministic. */
export type RandomSource = (size: number) => Buffer;

const TOKEN_BYTES = 20;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const TXT_PREFIX = 'forge-verify=';

/** Bytes as RFC 4648 base32, lowercase, no padding. `bytes.length` is a multiple of 5 here. */
function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(value >>> bits) & 31];
    }
  }
  return out;
}

export function ownershipToken(random: RandomSource = randomBytes): string {
  return base32(random(TOKEN_BYTES));
}

/** The TXT record value that proves ownership for `token`. */
export function ownershipTxtValue(token: string): string {
  return `${TXT_PREFIX}${token}`;
}
