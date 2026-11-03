import type { DomainRecord, RouteRecord, SiteRecord } from './route-verify.ts';

/**
 * What the cache holds: preview routes by label, site records under `site:{label}`, domain
 * records under `domain:{hostname}` (contracts/domain-serving.md § 2).
 */
export type CachedRecord = DomainRecord | RouteRecord | SiteRecord;

/**
 * A bounded in-process cache of verified routes keyed by label (research R5). An entry is usable
 * for `min(ttlMs, exp - now)`: the TTL is what makes a rotation stop resolving within seconds, and
 * `exp` is the floor that keeps a stale cache from outliving the route's own window.
 */
export class RouteCache {
  readonly #entries = new Map<string, { expiresAt: number; route: CachedRecord }>();
  readonly #max: number;
  readonly #ttlMs: number;

  constructor(options: { max: number; ttlMs: number }) {
    this.#max = options.max;
    this.#ttlMs = options.ttlMs;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(label: string): CachedRecord | undefined {
    const entry = this.#entries.get(label);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.#entries.delete(label);
      return undefined;
    }
    return entry.route;
  }

  /**
   * Stores `route` under `key`, its label by default. Sites pass `site:{label}` and domains
   * `domain:{hostname}`, so no two kinds can collide (contracts/site-serving.md § 3).
   */
  set(route: RouteRecord, key?: string): void;
  set(route: CachedRecord, key: string): void;
  set(route: CachedRecord, key: string = (route as RouteRecord).label): void {
    // Delete first so a refreshed key moves to the back of the insertion order.
    this.#entries.delete(key);
    // ponytail: evict by insertion order (oldest set), not LRU; upgrade if hit rates ever matter.
    if (this.#entries.size >= this.#max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) {
        this.#entries.delete(oldest);
      }
    }
    const expiresAt = Math.min(Date.now() + this.#ttlMs, route.exp * 1000);
    this.#entries.set(key, { expiresAt, route });
  }

  delete(label: string): void {
    this.#entries.delete(label);
  }
}
