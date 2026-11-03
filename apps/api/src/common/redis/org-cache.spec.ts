import { ConfigModule } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { openClient } from '../../../test/support/integration-redis';
import { validateEnvironment } from '../../config/environment';
import { OrgCacheKey } from './cache-key';
import { OrgCache } from './org-cache';
import { CACHE_REDIS } from './redis.constants';
import { RedisModule } from './redis.module';

const reachable = inject('redisReachable');

const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const USER = randomUUID();

describe('OrgCache', () => {
  /**
   * Nothing here is worth asserting against a fake: the whole point of the design is which Redis
   * commands it uses, and a stub would let the wrong ones pass.
   */
  describe.skipIf(!reachable)('against the cache Redis role', () => {
    let moduleRef: TestingModule;
    let cache: OrgCache;
    let redis: Redis;

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            ignoreEnvFile: true,
            isGlobal: true,
            validate: validateEnvironment,
          }),
          RedisModule,
        ],
      }).compile();

      cache = moduleRef.get(OrgCache);
      redis = moduleRef.get<Redis>(CACHE_REDIS);
    });

    afterAll(async () => {
      await Promise.all([cache.flushOrg(ORG), cache.flushOrg(OTHER_ORG)]);
      await moduleRef.close();
    });

    it('misses on a key that was never written', async () => {
      await expect(cache.get(OrgCacheKey.build(ORG, 'perm', randomUUID()))).resolves.toBeNull();
    });

    it('round-trips a value', async () => {
      const key = OrgCacheKey.build(ORG, 'perm', USER);

      await cache.set(key, 'project:deploy', 60);

      await expect(cache.get(key)).resolves.toBe('project:deploy');
    });

    /**
     * §09: "Explicit delete on write, plus a short TTL as a backstop. Never TTL alone." The backstop
     * has to sit on the entry rather than on the tenant key, or one org's whole cache would expire
     * on the clock of whichever entry was written first.
     */
    it('puts the backstop TTL on the entry, not on the tenant key', async () => {
      const key = OrgCacheKey.build(ORG, 'settings');

      await cache.set(key, '{}', 45);

      const [entryTtl] = await redis.httl(key.tenant, 'FIELDS', 1, key.field);

      expect(Number(entryTtl)).toBeGreaterThan(0);
      expect(Number(entryTtl)).toBeLessThanOrEqual(45);
      await expect(redis.ttl(key.tenant)).resolves.toBe(-1);
    });

    it.each([0, -1, 1.5, Number.NaN])('refuses a ttl of %s', async (ttl) => {
      await expect(cache.set(OrgCacheKey.build(ORG, 'perm', USER), 'x', ttl)).rejects.toThrow(
        /ttl/i,
      );
    });

    it('deletes one entry and leaves its neighbours', async () => {
      const deleted = OrgCacheKey.build(ORG, 'perm', USER);
      const kept = OrgCacheKey.build(ORG, 'entitlements');

      await Promise.all([cache.set(deleted, 'a', 60), cache.set(kept, 'b', 60)]);
      await cache.delete(deleted);

      await expect(cache.get(deleted)).resolves.toBeNull();
      await expect(cache.get(kept)).resolves.toBe('b');
    });

    /**
     * The §11 isolation claim: "Every key prefixed with the org id — key collision impossible by
     * construction; flush is per tenant."
     */
    it('flushes one tenant without touching another', async () => {
      const mine = OrgCacheKey.build(ORG, 'perm', USER);
      const theirs = OrgCacheKey.build(OTHER_ORG, 'perm', USER);

      await Promise.all([cache.set(mine, 'mine', 60), cache.set(theirs, 'theirs', 60)]);
      await cache.flushOrg(ORG);

      await expect(cache.get(mine)).resolves.toBeNull();
      await expect(cache.get(theirs)).resolves.toBe('theirs');
    });

    /**
     * The flush is one `UNLINK` of one key. This is the assertion that keeps it that way: if a later
     * change spread a tenant's entries over several Redis keys, flushing would need a
     * `SCAN MATCH o:{org}:*` over the whole keyspace, and this fails.
     */
    it('keeps a whole tenant under exactly one Redis key, so the flush needs no scan', async () => {
      await Promise.all([
        cache.set(OrgCacheKey.build(ORG, 'perm', USER), 'a', 60),
        cache.set(OrgCacheKey.build(ORG, 'perm', randomUUID()), 'b', 60),
        cache.set(OrgCacheKey.build(ORG, 'settings'), 'c', 60),
        cache.set(OrgCacheKey.build(ORG, 'entitlements', 'seats'), 'd', 60),
      ]);

      await expect(redis.keys(`${OrgCacheKey.tenantKey(ORG)}*`)).resolves.toEqual([
        OrgCacheKey.tenantKey(ORG),
      ]);
      await expect(cache.flushOrg(ORG)).resolves.toBe(true);
    });

    it.each(['', 'acme', '*'])('refuses to flush the org id %j', async (orgId) => {
      await expect(cache.flushOrg(orgId)).rejects.toThrow(/org id/i);
    });
  });

  /**
   * A cast or a plain-JS caller gets past the branded type, so every entry point checks at runtime
   * too. No Redis is needed to prove it: the check happens before the command is issued.
   */
  describe('runtime rejection of an unbranded key', () => {
    const raw = `o:${ORG}:perm:${USER}` as unknown as OrgCacheKey;
    const client = { status: 'end' } as unknown as Redis;

    it('rejects a raw string on get', async () => {
      await expect(new OrgCache(client).get(raw)).rejects.toThrow(/OrgCacheKey/);
    });

    it('rejects a raw string on set', async () => {
      await expect(new OrgCache(client).set(raw, 'x', 60)).rejects.toThrow(/OrgCacheKey/);
    });

    it('rejects a raw string on delete', async () => {
      await expect(new OrgCache(client).delete(raw)).rejects.toThrow(/OrgCacheKey/);
    });
  });

  /**
   * §09 puts nothing in this instance that Postgres cannot rebuild, so a read failure is a miss.
   * An invalidation failure is the opposite: swallowing it serves a stale permission set after a
   * role change, which is the one thing §11 does not allow.
   */
  describe('when the cache Redis is unreachable', () => {
    let dead: Redis;

    beforeAll(() => {
      dead = openClient('redis://127.0.0.1:1');
    });

    afterAll(() => {
      dead.disconnect();
    });

    it('reads as a miss rather than an error', async () => {
      await expect(
        new OrgCache(dead).get(OrgCacheKey.build(ORG, 'perm', USER)),
      ).resolves.toBeNull();
    });

    it('treats a failed write as a future miss rather than an error', async () => {
      await expect(
        new OrgCache(dead).set(OrgCacheKey.build(ORG, 'perm', USER), 'x', 60),
      ).resolves.toBeUndefined();
    });

    it('reports a failed invalidation instead of hiding it', async () => {
      await expect(new OrgCache(dead).flushOrg(ORG)).rejects.toThrow();
      await expect(
        new OrgCache(dead).delete(OrgCacheKey.build(ORG, 'perm', USER)),
      ).rejects.toThrow();
    });
  });
});
