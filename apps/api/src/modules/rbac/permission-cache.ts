import { Inject, Injectable, Logger } from '@nestjs/common';

import { OrgCacheKey } from '../../common/redis/cache-key';
import { OrgCache } from '../../common/redis/org-cache';
import type { PermissionEntry } from './permissions';

/**
 * The backstop, and only the backstop (§09: "plus a short TTL … never TTL alone").
 *
 * Five minutes is chosen against what it is for. Every change that moves a permission set deletes
 * the entry explicitly, so in normal operation this expiry is never what ends an entry's life; it
 * exists for the case where an invalidation was lost — a process killed between the commit and the
 * `HDEL`, a Redis that was briefly unreachable. That is the window it bounds, so it wants to be
 * short. It is not shorter because the entry is also what keeps a permission check off the database
 * on the hot path, and an expiry measured in seconds would make the cache decorative.
 */
export const PERMISSION_CACHE_TTL_SECONDS = 300;

/** What T27 hands `readThrough` on a miss: the pure resolver, over rows this class never loads. */
export type PermissionLoader = () => Promise<ReadonlySet<PermissionEntry>>;

/**
 * The resolved permission set for one `(user, org)`, cached on the Redis role §09 gives it (T25).
 *
 * The key is `o:{org_id}:perm:{user_id}`, built through T07's {@link OrgCacheKey} — which is a
 * nominal type with a private constructor, so a raw string key cannot be handed to the cache at
 * all. Per ADR 018 the org prefix is the whole Redis key and the entry is a field of its hash, so
 * `invalidateOrg` is one `UNLINK` of one key rather than a `SCAN` of the keyspace.
 *
 * **Explicit delete on write, plus a short TTL as a backstop. Never TTL alone.** §09 states it and
 * §11 says why: a permission set that only expiry invalidates is a stale authorisation with a timer
 * on it. A user demoted from owner to member would keep changing org settings until the clock ran
 * out. So {@link invalidate} deletes the entry outright on every membership, role and grant change,
 * and {@link PERMISSION_CACHE_TTL_SECONDS} only bounds the damage of an invalidation that was lost.
 *
 * Which call belongs to which change:
 *
 * | Change                                              | Call                       |
 * | --------------------------------------------------- | -------------------------- |
 * | membership created, removed, or its role changed     | {@link invalidate}         |
 * | project grant granted, changed or revoked            | {@link invalidate}         |
 * | workspace role granted, changed or revoked           | {@link invalidate}         |
 * | anything that moves every member at once             | {@link invalidateOrg}      |
 *
 * The invalidation must run in the same transaction as the change that caused it — or immediately
 * after it commits, and never before, or a concurrent read repopulates the entry from rows that are
 * about to change.
 *
 * Failure behaviour is `OrgCache`'s, and it is asymmetric on purpose. A failed read or write is a
 * miss: the set is rebuilt from Postgres, which costs a query, so a Redis outage denies nobody. A
 * failed invalidation propagates, because swallowing it is exactly how a stale set gets served.
 */
@Injectable()
export class PermissionCache {
  private readonly logger = new Logger(PermissionCache.name);

  /**
   * The token is named rather than left to `design:paramtypes`. Nest can infer it from the metadata
   * the transpiler emits, but that emission wraps the class reference in a guard no test can take —
   * which shows up as the single uncovered branch in a module whose point is that it has none.
   * Naming the token costs one import and removes both the inference and the artefact.
   */
  constructor(@Inject(OrgCache) private readonly cache: OrgCache) {}

  /** `o:{org_id}:perm:{user_id}`, through the builder that makes the org prefix structural. */
  static keyFor(orgId: string, userId: string): OrgCacheKey {
    return OrgCacheKey.build(orgId, 'perm', userId);
  }

  /** The cached set, or `null` for a miss — which an unreachable or corrupt cache also is. */
  async read(orgId: string, userId: string): Promise<ReadonlySet<PermissionEntry> | null> {
    const key = PermissionCache.keyFor(orgId, userId);
    const raw = await this.cache.get(key);

    if (raw === null) {
      return null;
    }

    const entries = decode(raw);

    if (entries === null) {
      // Not an error the caller can act on — it will resolve the set again — but it is a corrupt
      // entry on a shared instance, and finding out from a log beats finding out from a denial.
      this.logger.warn(
        `discarding a permission entry that is not a permission set: ${key.toString()}`,
      );

      return null;
    }

    return entries;
  }

  /** Sorted, so the stored value is stable and two identical sets are one string in a diff. */
  async write(
    orgId: string,
    userId: string,
    permissions: ReadonlySet<PermissionEntry>,
  ): Promise<void> {
    await this.cache.set(
      PermissionCache.keyFor(orgId, userId),
      JSON.stringify([...permissions].sort()),
      PERMISSION_CACHE_TTL_SECONDS,
    );
  }

  /**
   * The explicit delete. Loud on failure: an invalidation that did not happen and did not say so is
   * the stale-authorisation bug this whole class is arranged to avoid.
   */
  async invalidate(orgId: string, userId: string): Promise<void> {
    await this.cache.delete(PermissionCache.keyFor(orgId, userId));
  }

  /** Every entry the tenant owns, in one scan-free command — for a change that moves everyone. */
  async invalidateOrg(orgId: string): Promise<void> {
    await this.cache.flushOrg(orgId);
  }

  /**
   * Hit, or resolve and store. `load` is where the database lives: this class never queries, which
   * keeps the cache free of the tenancy schema and the resolver free of Redis.
   */
  async readThrough(
    orgId: string,
    userId: string,
    load: PermissionLoader,
  ): Promise<ReadonlySet<PermissionEntry>> {
    const cached = await this.read(orgId, userId);

    if (cached !== null) {
      return cached;
    }

    const permissions = await load();

    await this.write(orgId, userId, permissions);

    return permissions;
  }
}

/**
 * A stored value that is not an array of slugs is a corrupt entry, not an authorisation decision:
 * it becomes a miss rather than a throw and rather than whatever it happened to contain.
 */
function decode(raw: string): ReadonlySet<PermissionEntry> | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  return isEntryArray(parsed) ? new Set(parsed) : null;
}

function isEntryArray(value: unknown): value is PermissionEntry[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
