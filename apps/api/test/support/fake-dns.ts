import {
  MAX_CNAME_HOPS,
  type CaaRecord,
  type DnsAnswer,
  type DnsPort,
} from '../../src/modules/deploy/domains/dns.port';

/**
 * An in-memory DNS for spec 028's checks (research R15): what `NodeDnsAdapter` answers, without a
 * resolver. A test sets records per name and type, marks a name as unreachable, and reads back
 * the questions that were asked.
 *
 * - `set(name, 'TXT', values)`, `set(name, 'CNAME', target)`, `set(name, 'CAA', records)` and
 *   `set(name, 'SOA', owner)` replace that name's records of that type. A name with nothing set
 *   answers `empty` (NXDOMAIN), as does a type that was never set.
 * - `resolveCnameChain` follows `CNAME` entries hop by hop, so a chain is built from one `set` per
 *   hop; at most `MAX_CNAME_HOPS` are followed, which a loop reaches too.
 * - `unavailable(name)` makes every question at `name` answer `unavailable` (SERVFAIL on every
 *   resolver), including a chain that passes through it, until `available(name)` or `reset()`.
 *
 * Names are compared lowercase with any trailing dot dropped, as the adapter normalises them.
 */
export type FakeDnsType = 'CAA' | 'CNAME' | 'SOA' | 'TXT';

interface FakeRecords {
  CAA?: readonly CaaRecord[];
  CNAME?: string;
  SOA?: string;
  TXT?: readonly string[];
}

export interface FakeDnsQuery {
  readonly name: string;
  readonly type: FakeDnsType;
}

function canonical(name: string): string {
  const lower = name.toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

export class FakeDns implements DnsPort {
  /** Every question asked, oldest first; a chain records one `CNAME` question per hop. */
  readonly queries: FakeDnsQuery[] = [];
  private readonly zones = new Map<string, FakeRecords>();
  private readonly down = new Set<string>();

  set(name: string, type: 'TXT', values: readonly string[]): this;
  set(name: string, type: 'CNAME', target: string): this;
  set(name: string, type: 'CAA', records: readonly CaaRecord[]): this;
  set(name: string, type: 'SOA', owner: string): this;
  set(
    name: string,
    type: FakeDnsType,
    answer: readonly CaaRecord[] | readonly string[] | string,
  ): this {
    const key = canonical(name);
    const records = this.zones.get(key) ?? {};
    const value = type === 'CNAME' || type === 'SOA' ? canonical(answer as string) : answer;
    this.zones.set(key, { ...records, [type]: value });
    return this;
  }

  /** Removes `name`'s records of `type`, or all of them: the member deleting a record. */
  delete(name: string, type?: FakeDnsType): this {
    const key = canonical(name);
    if (type === undefined) {
      this.zones.delete(key);
    } else {
      const rest = { ...this.zones.get(key) };
      delete rest[type];
      this.zones.set(key, rest);
    }
    return this;
  }

  unavailable(name: string): this {
    this.down.add(canonical(name));
    return this;
  }

  available(name: string): this {
    this.down.delete(canonical(name));
    return this;
  }

  /** Clears every record, every outage and the query log. */
  reset(): void {
    this.zones.clear();
    this.down.clear();
    this.queries.length = 0;
  }

  resolveTxt(name: string): Promise<DnsAnswer<{ readonly records: readonly string[] }>> {
    return Promise.resolve(
      this.ask(name, 'TXT', (records) => (records.length === 0 ? undefined : { records })),
    );
  }

  resolveCnameChain(name: string): Promise<DnsAnswer<{ readonly chain: readonly string[] }>> {
    const chain: string[] = [];
    let current = name;
    while (chain.length < MAX_CNAME_HOPS) {
      const hop = this.ask(current, 'CNAME', (target) => ({ target }));
      if (hop.kind === 'unavailable') return Promise.resolve(hop);
      if (hop.kind === 'empty') break;
      chain.push(hop.target);
      current = hop.target;
    }
    return Promise.resolve(chain.length === 0 ? { kind: 'empty' } : { kind: 'answer', chain });
  }

  resolveCaa(name: string): Promise<DnsAnswer<{ readonly records: readonly CaaRecord[] }>> {
    return Promise.resolve(
      this.ask(name, 'CAA', (records) => (records.length === 0 ? undefined : { records })),
    );
  }

  resolveSoaOwner(name: string): Promise<DnsAnswer<{ readonly owner: string }>> {
    return Promise.resolve(this.ask(name, 'SOA', (owner) => ({ owner })));
  }

  private ask<K extends FakeDnsType, T extends object>(
    name: string,
    type: K,
    shape: (value: NonNullable<FakeRecords[K]>) => T | undefined,
  ): DnsAnswer<T> {
    const key = canonical(name);
    this.queries.push({ name: key, type });
    if (this.down.has(key)) return { kind: 'unavailable' };
    const value = this.zones.get(key)?.[type];
    const answer = value === undefined ? undefined : shape(value);
    return answer === undefined ? { kind: 'empty' } : { kind: 'answer', ...answer };
  }
}
