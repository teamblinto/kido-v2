/**
 * The resolver the webhook transport asks for a host's addresses (spec 029 research R8). One
 * adapter, `NodeResolverAdapter`, over `node:dns/promises` `Resolver` pinned to `DNS_RESOLVERS`;
 * tests bind `FakeResolver` (`test/support/fake-resolver.ts`), which can script rebinding.
 *
 * - `answer`: the A and AAAA addresses together, at least one.
 * - `empty`: an authoritative "no address" (NXDOMAIN, or NODATA for both families).
 * - `unavailable`: every resolver failed or the lookup timed out.
 *
 * The transport treats `empty` and `unavailable` alike, as the retryable `dns-failed`.
 */
export type WebhookResolution =
  | { readonly kind: 'answer'; readonly addresses: readonly string[] }
  | { readonly kind: 'empty' }
  | { readonly kind: 'unavailable' };

export interface WebhookResolverPort {
  resolve(host: string): Promise<WebhookResolution>;
}

export const WEBHOOK_RESOLVER = Symbol('forge.webhooks.resolver');
