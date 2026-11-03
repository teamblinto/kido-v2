import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resolver } from 'node:dns/promises';

import type { Environment } from '../../../config/environment';
import { type CaaRecord, type DnsAnswer, type DnsPort, MAX_CNAME_HOPS } from './dns.port';

/** Each query's bound (R15): 2 s per try, two tries, per server. */
const RESOLVER_OPTIONS = { timeout: 2000, tries: 2 } as const;

/** The authoritative "nothing here" codes: NODATA and NXDOMAIN. Everything else is unavailable. */
const EMPTY_CODES: ReadonlySet<string> = new Set(['ENODATA', 'ENOTFOUND']);

const EMPTY = { kind: 'empty' } as const;
const UNAVAILABLE = { kind: 'unavailable' } as const;

/** Lowercase, no trailing dot: the port's rule for names, in both directions. */
const bareName = (name: string) => name.toLowerCase().replace(/\.$/, '');

/**
 * `DnsPort` over `node:dns/promises` `Resolver` pointed at `DNS_RESOLVERS` (spec 028 R6, R15), so a
 * check sees what the public internet sees rather than the host's split-horizon or cache.
 *
 * One `Resolver` per server, asked in order: Node runs c-ares with `ARES_FLAG_NOCHECKRESP`, so a
 * single resolver over the whole list answers the first server's SERVFAIL without asking the next.
 * `unavailable` therefore means every server answered SERVFAIL, refused, or timed out.
 */
@Injectable()
export class NodeDnsAdapter implements DnsPort {
  private readonly resolvers: readonly Resolver[];

  constructor(config: ConfigService<Environment, true>) {
    this.resolvers = config.get('DNS_RESOLVERS', { infer: true }).map((server) => {
      const resolver = new Resolver(RESOLVER_OPTIONS);
      resolver.setServers([server]);
      return resolver;
    });
  }

  async resolveTxt(name: string): Promise<DnsAnswer<{ readonly records: readonly string[] }>> {
    return this.ask(
      (resolver) => resolver.resolveTxt(name),
      (records) => ({ records: records.map((strings) => strings.join('')) }),
    );
  }

  async resolveCnameChain(name: string): Promise<DnsAnswer<{ readonly chain: readonly string[] }>> {
    const chain: string[] = [];
    const seen = new Set([bareName(name)]);
    let current = name;

    while (chain.length < MAX_CNAME_HOPS) {
      const hop = await this.ask(
        (resolver) => resolver.resolveCname(current),
        (targets) => ({ target: targets[0] === undefined ? undefined : bareName(targets[0]) }),
      );
      // A later hop that fails leaves the chain unknown, not ended: routing must not read it as
      // `missing` (FR-021).
      if (hop.kind === 'unavailable') return UNAVAILABLE;
      if (hop.kind === 'empty' || hop.target === undefined) break;

      chain.push(hop.target);
      if (seen.has(hop.target)) break; // a loop: the chain so far is the answer
      seen.add(hop.target);
      current = hop.target;
    }

    return chain.length === 0 ? EMPTY : { chain, kind: 'answer' };
  }

  async resolveCaa(name: string): Promise<DnsAnswer<{ readonly records: readonly CaaRecord[] }>> {
    return this.ask(
      (resolver) => resolver.resolveCaa(name),
      (records) => ({
        records: records.flatMap((record): CaaRecord[] => {
          // Node adds `type: 'CAA'` beside the one property; `critical` is the flags byte.
          const critical = (record.critical & 128) !== 0;
          return Object.entries(record).flatMap(([tag, value]) =>
            tag !== 'critical' && tag !== 'type' && typeof value === 'string'
              ? [{ critical, tag: tag.toLowerCase(), value }]
              : [],
          );
        }),
      }),
    );
  }

  /**
   * `resolveSoa` does not say whose SOA it answered, and c-ares takes the first SOA in the answer
   * even behind a CNAME. A name with a CNAME is not an apex (a CNAME cannot sit there), so the
   * owner is taken as the chain's end in that case and as `name` otherwise.
   */
  async resolveSoaOwner(name: string): Promise<DnsAnswer<{ readonly owner: string }>> {
    const [soa, chain] = await Promise.all([
      this.ask(
        (resolver) => resolver.resolveSoa(name),
        () => ({}),
      ),
      this.resolveCnameChain(name),
    ]);
    if (soa.kind !== 'answer') return soa;
    if (chain.kind === 'unavailable') return UNAVAILABLE;

    const owner = chain.kind === 'answer' ? chain.chain[chain.chain.length - 1]! : bareName(name);
    return { kind: 'answer', owner };
  }

  /**
   * One query, server by server until one answers or says authoritatively that nothing is there;
   * the error code sorts into `empty` or, once every server failed, `unavailable`.
   */
  private async ask<R, T extends object>(
    query: (resolver: Resolver) => Promise<R>,
    shape: (result: R) => T,
  ): Promise<DnsAnswer<T>> {
    for (const resolver of this.resolvers) {
      let result: R;
      try {
        result = await query(resolver);
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (typeof code === 'string' && EMPTY_CODES.has(code)) return EMPTY;
        continue;
      }
      if (Array.isArray(result) && result.length === 0) return EMPTY;
      return { kind: 'answer', ...shape(result) };
    }
    return UNAVAILABLE;
  }
}
