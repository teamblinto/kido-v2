/**
 * The four DNS questions a domain check asks (spec 028 research R6 and R15,
 * contracts/domain-serving.md § 4). One adapter, `NodeDnsAdapter`, over `node:dns/promises`
 * `Resolver` pointed at `DNS_RESOLVERS`, each query bounded by `timeout: 2000, tries: 2`. Tests
 * bind the in-memory `FakeDns` (`test/support/fake-dns.ts`).
 *
 * Every answer is one of three kinds, and the difference between the last two is the point:
 *
 * - `answer`: the name has records of the type asked.
 * - `empty`: an authoritative "nothing here", NXDOMAIN or NODATA. For ownership and routing that
 *   is `missing`; for CAA it is an empty set at that level; for SOA it is "not an apex".
 * - `unavailable`: every resolver answered SERVFAIL or timed out. The check that meets it is
 *   inconclusive: it changes nothing and counts toward neither drift nor expiry (FR-021).
 *
 * Names are ASCII, fully qualified, with no trailing dot, in both directions.
 */

export type DnsAnswer<T> =
  ({ readonly kind: 'answer' } & T) | { readonly kind: 'empty' } | { readonly kind: 'unavailable' };

/** One CAA property (RFC 8659 §4.1). `critical` is the issuer-critical flag (bit 128). */
export interface CaaRecord {
  readonly critical: boolean;
  /** Lowercase property tag: `issue`, `issuewild`, `iodef`, or an unknown one. */
  readonly tag: string;
  readonly value: string;
}

/** The longest CNAME chain the adapter follows before answering with what it has (R6). */
export const MAX_CNAME_HOPS = 8;

export interface DnsPort {
  /** The TXT records at `name`, each record's character-strings joined into one value. */
  resolveTxt(name: string): Promise<DnsAnswer<{ readonly records: readonly string[] }>>;
  /**
   * The CNAME chain starting at `name`: `chain[0]` is `name`'s own target, each next entry the
   * target of the one before, at most `MAX_CNAME_HOPS` long. `empty` when `name` has no CNAME.
   */
  resolveCnameChain(name: string): Promise<DnsAnswer<{ readonly chain: readonly string[] }>>;
  /** The CAA RRset at exactly `name` (no tree climb; `caaVerdict` climbs, R5). */
  resolveCaa(name: string): Promise<DnsAnswer<{ readonly records: readonly CaaRecord[] }>>;
  /**
   * The owner of the SOA answered for `name`. An owner equal to `name` means `name` is a zone apex,
   * where a CNAME cannot sit (R8 add-time probe, R6 apex status). `empty` means not an apex.
   */
  resolveSoaOwner(name: string): Promise<DnsAnswer<{ readonly owner: string }>>;
}

/** Symbol for the reason `database.constants.ts` gives: a string token collides silently. */
export const DNS = Symbol('forge.deploy.dns');
