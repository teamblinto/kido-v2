import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { assertOrgCacheKey, OrgCacheKey } from './cache-key';
import { CACHE_REDIS } from './redis.constants';

/**
 * The org-scoped cache: the only way anything writes to the cache Redis role.
 *
 * Every entry point takes an {@link OrgCacheKey}, so a raw string is a compile error and a cast is a
 * runtime one. That is the whole design — §11 claims "key collision impossible by construction" for
 * this layer, and a builder that callers are merely asked to remember would not deliver it.
 *
 * Failure behaviour is deliberately asymmetric, and it is the part worth reading twice. §09 puts
 * nothing in this instance that Postgres cannot rebuild, so a failed read or write is a cache miss
 * and costs one query. A failed **invalidation** is not comparable: swallowing it serves a stale
 * permission set after a role change, which is the one thing §11 does not allow. So reads and writes
 * degrade quietly and loudly log; `delete` and `flushOrg` propagate.
 */
@Injectable()
export class OrgCache {
  private readonly logger = new Logger(OrgCache.name);

  constructor(@Inject(CACHE_REDIS) private readonly redis: Redis) {}

  /** A miss and an unreachable cache are the same answer to the caller: `null`. */
  async get(key: OrgCacheKey): Promise<string | null> {
    assertOrgCacheKey(key);

    try {
      return await this.redis.hget(key.tenant, key.field);
    } catch (error) {
      this.logger.warn(`cache read degraded for ${key.toString()}: ${describe(error)}`);

      return null;
    }
  }

  /**
   * §09: "Explicit delete on write, plus a short TTL as a backstop. Never TTL alone." The TTL is a
   * required argument for that reason — there is no overload that stores an entry which only an
   * eviction will ever remove. It is set on the field, not the key, so one org's whole cache does
   * not expire on the clock of whichever entry was written first.
   */
  async set(key: OrgCacheKey, value: string, ttlSeconds: number): Promise<void> {
    assertOrgCacheKey(key);

    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new TypeError(
        `cache ttl must be a positive whole number of seconds, got ${String(ttlSeconds)}`,
      );
    }

    try {
      const replies = await this.redis
        .multi()
        .hset(key.tenant, key.field, value)
        .hexpire(key.tenant, ttlSeconds, 'FIELDS', 1, key.field)
        .exec();

      const failure = replies?.find(([error]) => error !== null)?.[0];

      if (failure) {
        throw failure;
      }
    } catch (error) {
      this.logger.warn(`cache write degraded for ${key.toString()}: ${describe(error)}`);
    }
  }

  /** The explicit delete §09 asks for on write. Never quiet: see the class comment. */
  async delete(key: OrgCacheKey): Promise<boolean> {
    assertOrgCacheKey(key);

    return (await this.redis.hdel(key.tenant, key.field)) > 0;
  }

  /**
   * Everything cached for one org, gone, in one command over one key — no `SCAN`, no `KEYS`, no
   * pattern, and nothing left behind for a later eviction to remove. `UNLINK` rather than `DEL` so
   * that reclaiming a large tenant's hash happens off the command thread.
   */
  async flushOrg(orgId: string): Promise<boolean> {
    return (await this.redis.unlink(OrgCacheKey.tenantKey(orgId))) > 0;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
