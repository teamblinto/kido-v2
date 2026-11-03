import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * The shared origin header (contracts/domain-serving.md § 1, research R11): the edge's
 * request-header transform adds `X-Forge-Edge: <EDGE_ORIGIN_SECRET>` to every request it forwards
 * for a custom hostname, so a request that reached the gateway around the edge is refused.
 */
export const EDGE_ORIGIN_HEADER = 'x-forge-edge';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Reads the edge header and deletes it from both of Node's views of the request (`headers` and
 * `rawHeaders`), so nothing that runs afterwards (serving, proxying, logging) can see or echo it.
 */
export function takeEdgeHeader(req: IncomingMessage): string | undefined {
  const value = req.headers[EDGE_ORIGIN_HEADER];
  delete req.headers[EDGE_ORIGIN_HEADER];
  const raw = req.rawHeaders;
  for (let index = raw.length - 2; index >= 0; index -= 2) {
    if (raw[index]!.toLowerCase() === EDGE_ORIGIN_HEADER) {
      raw.splice(index, 2);
    }
  }
  // Node types an unknown header as `string | string[]`; it joins repeats into one string.
  return typeof value === 'string' ? value : undefined;
}

/**
 * Builds the check for one secret. It always removes the header, and it compares SHA-256 digests
 * with `timingSafeEqual`: equal lengths whatever was sent, so neither the length nor the content
 * of the secret leaks through timing, and a missing header costs the same comparison.
 */
export function createEdgeOriginCheck(secret: string): (req: IncomingMessage) => boolean {
  // The config requires 32 characters; an empty secret would accept a request with no header.
  if (secret.length === 0) {
    throw new Error('the edge origin secret must not be empty');
  }
  const expected = digest(secret);
  return (req) => timingSafeEqual(digest(takeEdgeHeader(req) ?? ''), expected);
}
