/**
 * The destination policy for outbound webhooks (spec 029 research R8, FR-003).
 *
 * One module-level `node:net` `BlockList` holds every IANA special-purpose range for IPv4 and IPv6.
 * `BlockList.check` matches an IPv4-mapped IPv6 address (`::ffff:10.0.0.1`) against the IPv4 rules,
 * so the mapped forms need no rule of their own.
 *
 * Two checks use it:
 *
 * - `parseEndpointUrl`, at save time, refuses a URL whose host is a literal special-use address. It
 *   is a courtesy that tells the user early; it is not the protection.
 * - `SafeTransport`, at connect time, classifies every resolved address through the injected
 *   `DestinationPolicy` on every attempt, and pins the connection to an allowed one.
 *
 * Rejected alternatives:
 *
 * - `ipaddr.js`: a new dependency for what the `BlockList` builtin already does (Principle I).
 * - Checking only at save time: that is the DNS-rebinding hole §12 names. A host that resolved to a
 *   public address when saved can resolve to `127.0.0.1` when sent, so the check that matters runs
 *   after resolution, on every attempt.
 */
import { BlockList, isIP } from 'node:net';

const IPV4_RANGES: readonly (readonly [network: string, prefix: number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
  ['255.255.255.255', 32],
];

const IPV6_RANGES: readonly (readonly [network: string, prefix: number])[] = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];

const REFUSED = new BlockList();
for (const [network, prefix] of IPV4_RANGES) REFUSED.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of IPV6_RANGES) REFUSED.addSubnet(network, prefix, 'ipv6');

/** True when `ip` is an IPv4 or IPv6 address outside every special-use range. */
export function isAllowedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return false;
  return !REFUSED.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

/** What the transport asks of the policy. E2E suites replace it through DI to admit loopback. */
export interface DestinationPolicy {
  isAllowedAddress(ip: string): boolean;
}

export const DESTINATION_POLICY = Symbol('forge.webhooks.destination-policy');

/** The real policy, as a provider value. */
export const specialUseDestinationPolicy: DestinationPolicy = { isAllowedAddress };

export const MAX_ENDPOINT_URL_LENGTH = 2048;

export type EndpointUrlRefusal = 'destination-not-allowed' | 'invalid-url';

export type ParsedEndpointUrl =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: EndpointUrlRefusal };

/**
 * Parse and normalise an endpoint URL. `invalid-url` when it is unparseable, longer than 2,048
 * characters, carries user info, or is not `https:` (`http:` too when `allowHttp`, local only).
 * `destination-not-allowed` when the host is a literal special-use address, in any form the WHATWG
 * parser normalises (`[::1]`, `0x7f.1`, `2130706433`).
 */
export function parseEndpointUrl(
  input: string,
  options: { readonly allowHttp: boolean },
): ParsedEndpointUrl {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ENDPOINT_URL_LENGTH) return invalid();

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return invalid();
  }

  const schemeAllowed =
    url.protocol === 'https:' || (options.allowHttp && url.protocol === 'http:');
  if (!schemeAllowed || url.username !== '' || url.password !== '' || url.hostname === '') {
    return invalid();
  }

  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  if (isIP(host) !== 0 && !isAllowedAddress(host)) {
    return { ok: false, reason: 'destination-not-allowed' };
  }

  const normalised = url.href;
  if (normalised.length > MAX_ENDPOINT_URL_LENGTH) return invalid();
  return { ok: true, url: normalised };
}

function invalid(): ParsedEndpointUrl {
  return { ok: false, reason: 'invalid-url' };
}
