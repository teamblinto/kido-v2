/**
 * The `Forge-Signature` header (spec 029 research R10, contracts/webhook-delivery.md § Signature).
 *
 * `t=<unix seconds>,v1=<hex>[,v1=<hex>]`: one `v1` per live secret, newest first, each
 * HMAC-SHA256 over `${t}.${body}` keyed by the full `whsec_…` string as UTF-8. Newest first lets a
 * verifier that checks only the first `v1` switch over at rotation time.
 */
import { createHmac } from 'node:crypto';

export function signPayload(
  secrets: readonly string[],
  timestampSeconds: number,
  body: string,
): string {
  if (secrets.length === 0) throw new Error('signPayload needs at least one secret');
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0) {
    throw new Error('signPayload needs a non-negative integer timestamp');
  }
  const message = `${timestampSeconds}.${body}`;
  const values = secrets.map(
    (secret) => `v1=${createHmac('sha256', secret).update(message, 'utf8').digest('hex')}`,
  );
  return [`t=${timestampSeconds}`, ...values].join(',');
}
