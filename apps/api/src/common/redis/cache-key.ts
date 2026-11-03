/** Org ids are `uuid` in every table of the schema, so anything else is a bug, not a tenant. */
const ORG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `:` is excluded because it is the delimiter: allowing it would make `build(org, 'perm', 'a:b')`
 * and `build(org, 'perm:a', 'b')` the same entry. Glob metacharacters and whitespace are excluded
 * because a key that cannot be typed into `redis-cli` is a key nobody can debug.
 */
const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * A cache key that carries its tenant, and the only kind `OrgCache` accepts.
 *
 * §11 lists the cache in the isolation table as "every key prefixed with the org id → key collision
 * impossible by construction; flush is per tenant". Two things follow, and both are structural
 * rather than conventional:
 *
 * The prefix is not a string a key merely starts with. `o:{org_id}` is the whole Redis key and
 * everything after it is a field of that key's hash, so §09's "flushed in one scan-free operation"
 * is literally one `UNLINK` of one key — see {@link OrgCache.flushOrg}. A flat `o:{org}:perm:{user}`
 * key would read the same in a log and would need a `SCAN MATCH o:{org}:*` over the whole keyspace
 * to invalidate, which is the operation §09 rules out. `toString()` renders the flat form, so what
 * appears in a log and in the plan is still `o:{org_id}:perm:{user_id}`.
 *
 * And the type is nominal: the constructor is private, so {@link OrgCacheKey.build} is the only way
 * to obtain one, and `private composed` stops an object literal of the same shape from being
 * assignable. A raw string therefore cannot reach the cache API — the guarantee is a compile error,
 * not a prefix convention that a reviewer has to notice was forgotten.
 */
export class OrgCacheKey {
  /**
   * The flat key, precomputed for `toString()`. Being private is also what makes this class
   * nominally typed: `{ field, tenant }` is not an `OrgCacheKey`, and `tsc` says so.
   */
  private readonly composed: string;

  private constructor(
    /** The Redis key — `o:{org_id}` — which is the tenant, and the unit of flush. */
    readonly tenant: string,
    /** The hash field: everything after the org prefix. */
    readonly field: string,
  ) {
    this.composed = `${tenant}:${field}`;
  }

  /** The Redis key holding every cache entry for one org. Validates the org id the same way. */
  static tenantKey(orgId: string): string {
    if (!ORG_ID.test(orgId)) {
      return failInvalid(`org id ${JSON.stringify(orgId)} is not a uuid`);
    }

    return `o:${orgId}`;
  }

  /**
   * The only way to make a cache key.
   *
   * @param orgId the tenant this entry belongs to — a uuid, checked
   * @param segments at least one, e.g. `('perm', userId)` for `o:{org}:perm:{user}`
   */
  static build(orgId: string, ...segments: [string, ...string[]]): OrgCacheKey {
    const tenant = OrgCacheKey.tenantKey(orgId);

    if (segments.length === 0) {
      return failInvalid('a cache key needs at least one segment after the org prefix');
    }

    for (const segment of segments) {
      if (!SEGMENT.test(segment)) {
        return failInvalid(
          `cache key segment ${JSON.stringify(segment)} must match ${SEGMENT.source}`,
        );
      }
    }

    return new OrgCacheKey(tenant, segments.join(':'));
  }

  /** `o:{org_id}:{segments}` — the logical key, for logs, assertions and the plan's wording. */
  toString(): string {
    return this.composed;
  }
}

/**
 * The same rule for callers the type system does not reach: plain JavaScript, and anyone who casts.
 * Every `OrgCache` entry point calls this before it touches Redis.
 */
export function assertOrgCacheKey(value: unknown): asserts value is OrgCacheKey {
  if (!(value instanceof OrgCacheKey)) {
    throw new TypeError(
      'a cache key must be an OrgCacheKey from OrgCacheKey.build(), so that it carries its org ' +
        'prefix (§09, §11)',
    );
  }
}

/** Typed as returning `never` so the callers above read as expressions rather than early returns. */
function failInvalid(reason: string): never {
  throw new TypeError(`invalid cache key: ${reason}`);
}
