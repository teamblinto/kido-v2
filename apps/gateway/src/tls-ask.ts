import type { BrokerClient } from './broker-client.ts';
import { resolveHost } from './resolve.ts';

/** Distinct hostnames approved per label while its port is unknown (cold sandbox). */
const UNCONFIRMED_PER_LABEL = 3;
/** Bound on labels tracked for that cap; the oldest is forgotten first. */
const MAX_LABELS = 10_000;

/**
 * Caddy's on-demand TLS `ask` (infra/Caddyfile.vps): may a certificate be issued for `domain`?
 * Yes only for a preview host whose label the broker knows, asked exactly as the gateway asks
 * for a request, so random names never reach the ACME CA. A live route also pins the port. A cold
 * one (`waking`, or `unauthorised` for a private preview without a grant) does not say which port
 * it serves, so a label then gets at most a few distinct hostnames: knowing one label cannot
 * mint a certificate for each of its 64k ports.
 */
export function createTlsAsk(opts: {
  getRoute: BrokerClient['getRoute'];
  previewDomain: string;
}): (domain: string) => Promise<boolean> {
  const unconfirmed = new Map<string, Set<string>>();
  return async (domain) => {
    const host = resolveHost(domain, opts.previewDomain);
    if (!host.ok || host.kind !== undefined) return false;
    const answer = await opts.getRoute(host.label, { host: host.hostname });
    if (answer.kind === 'route') return answer.route.ports.includes(host.port);
    if (answer.kind !== 'waking' && answer.kind !== 'unauthorised') return false;
    const seen = unconfirmed.get(host.label) ?? new Set<string>();
    if (!seen.has(host.hostname) && seen.size >= UNCONFIRMED_PER_LABEL) return false;
    seen.add(host.hostname);
    unconfirmed.delete(host.label);
    unconfirmed.set(host.label, seen);
    if (unconfirmed.size > MAX_LABELS) unconfirmed.delete(unconfirmed.keys().next().value!);
    return true;
  };
}
