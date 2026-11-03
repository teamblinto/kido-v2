/**
 * Injection tokens for the four Redis roles §09 keeps apart.
 *
 * Symbols rather than strings, for the reason `database.constants.ts` gives: these are handed to
 * `@Inject()` from every module written from here on, and a string token collides silently.
 *
 * There is a token per role rather than one client with a database index because the roles are
 * separate servers: "one instance cannot be both `noeviction` and `allkeys-lru`" (§09). A service
 * asks for the role it needs and cannot quietly be handed another one.
 */

/**
 * Sessions, preview grants and rate-limit counters. `noeviction` with AOF, "kept apart from the
 * cache precisely because an LRU eviction here signs a user out" (§09).
 */
export const SESSION_REDIS = Symbol('forge.redis.session');

/**
 * Permission sets, org settings and entitlements. `allkeys-lru`, no persistence: everything in it
 * is reconstructible from Postgres. Every key is org-prefixed, which `cache-key.ts` enforces and
 * `OrgCache` is the way to use.
 */
export const CACHE_REDIS = Symbol('forge.redis.cache');

/**
 * BullMQ jobs and locks. `noeviction` with AOF, kept apart from the cache because evicting a job
 * key silently loses work the outbox has already marked published, and from the session instance
 * because a queue that fills up must refuse writes rather than sign users out (§09).
 */
export const QUEUE_REDIS = Symbol('forge.redis.queue');

/**
 * One capped Redis Stream per run (`run:{id}:events`). `noeviction` because the streams are
 * capped by `MAXLEN`, not by memory pressure; no persistence because every entry is replayable
 * from Postgres, so a loss here costs live tails only. Its own instance because a run that
 * streams hard must not share the queue's memory ceiling (§09).
 */
export const STREAM_REDIS = Symbol('forge.redis.stream');
