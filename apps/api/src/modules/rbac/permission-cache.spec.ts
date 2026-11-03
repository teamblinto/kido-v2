import { ConfigModule } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { openClient } from '../../../test/support/integration-redis';
import { OrgCacheKey } from '../../common/redis/cache-key';
import { OrgCache } from '../../common/redis/org-cache';
import { CACHE_REDIS, SESSION_REDIS } from '../../common/redis/redis.constants';
import { RedisModule } from '../../common/redis/redis.module';
import { validateEnvironment } from '../../config/environment';
import { PERMISSION_CACHE_TTL_SECONDS, PermissionCache } from './permission-cache';
import { ORG_ROLE_PERMISSIONS, PROJECT_ROLE_PERMISSIONS, scoped } from './permissions';
import type { ResolvableOrg, ResolvedMembership, ResolvedProjectGrant } from './resolver';
import { resolve } from './resolver';

const reachable = inject('redisReachable');

const ORG: ResolvableOrg = { deletedAt: null, id: randomUUID() };
const OTHER_ORG: ResolvableOrg = { deletedAt: null, id: randomUUID() };
const PROJECT = randomUUID();

describe('PermissionCache', () => {
  describe('the key', () => {
    it('is the one the plan names, built through T07’s builder', () => {
      const org = randomUUID();
      const user = randomUUID();
      const key = PermissionCache.keyFor(org, user);

      expect(key).toBeInstanceOf(OrgCacheKey);
      expect(key.toString()).toBe(`o:${org}:perm:${user}`);
      expect(key.tenant).toBe(`o:${org}`);
      expect(key.field).toBe(`perm:${user}`);
    });

    it('carries the org id, so one tenant cannot read another’s entry', () => {
      const user = randomUUID();

      expect(PermissionCache.keyFor(ORG.id, user).toString()).not.toBe(
        PermissionCache.keyFor(OTHER_ORG.id, user).toString(),
      );
    });

    it('refuses an org id that is not a uuid', () => {
      expect(() => PermissionCache.keyFor('acme', randomUUID())).toThrow(/org id/i);
    });
  });

  /**
   * §09: "Explicit delete on write, plus a short TTL as a backstop. Never TTL alone." The backstop
   * is a backstop — it bounds how long a *missed* invalidation can hurt, and a value long enough to
   * be the primary mechanism would mean permissions that expire rather than change.
   */
  it('keeps the backstop TTL short', () => {
    expect(Number.isInteger(PERMISSION_CACHE_TTL_SECONDS)).toBe(true);
    expect(PERMISSION_CACHE_TTL_SECONDS).toBeGreaterThan(0);
    expect(PERMISSION_CACHE_TTL_SECONDS).toBeLessThanOrEqual(600);
  });

  /**
   * Against the real cache Redis, not a fake. The claim under test is "a stale set is never served
   * after a role change", and a stub would prove only that the code calls the methods the same stub
   * was written to expect.
   */
  describe.skipIf(!reachable)('against the cache Redis role', () => {
    let moduleRef: TestingModule;
    let cache: PermissionCache;
    let cacheRedis: Redis;
    let sessionRedis: Redis;

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
        providers: [PermissionCache],
      }).compile();

      cache = moduleRef.get(PermissionCache);
      cacheRedis = moduleRef.get<Redis>(CACHE_REDIS);
      sessionRedis = moduleRef.get<Redis>(SESSION_REDIS);
    });

    afterAll(async () => {
      await Promise.all([cache.invalidateOrg(ORG.id), cache.invalidateOrg(OTHER_ORG.id)]);
      await moduleRef.close();
    });

    it('misses for a user it has never seen', async () => {
      await expect(cache.read(ORG.id, randomUUID())).resolves.toBeNull();
    });

    it('round-trips a resolved set', async () => {
      const user = randomUUID();
      const permissions = new Set(ORG_ROLE_PERMISSIONS.admin);

      await cache.write(ORG.id, user, permissions);

      await expect(cache.read(ORG.id, user)).resolves.toEqual(permissions);
    });

    it('round-trips resource-qualified entries unchanged', async () => {
      const user = randomUUID();
      const permissions = new Set(
        PROJECT_ROLE_PERMISSIONS.editor.map((permission) => scoped(permission, PROJECT)),
      );

      await cache.write(ORG.id, user, permissions);

      await expect(cache.read(ORG.id, user)).resolves.toEqual(permissions);
    });

    it('stores an empty set as an entry rather than as a miss', async () => {
      const user = randomUUID();

      await cache.write(ORG.id, user, new Set());

      await expect(cache.read(ORG.id, user)).resolves.toEqual(new Set());
    });

    /** §09 puts permission sets on the `cache` instance, whose `allkeys-lru` policy suits them. */
    it('writes to the cache role and not to the session one', async () => {
      const user = randomUUID();
      const key = PermissionCache.keyFor(ORG.id, user);

      await cache.write(ORG.id, user, new Set(ORG_ROLE_PERMISSIONS.member));

      await expect(cacheRedis.hexists(key.tenant, key.field)).resolves.toBe(1);
      await expect(sessionRedis.exists(key.tenant)).resolves.toBe(0);
    });

    /** One key per tenant, entries as hash fields — ADR 018, so a flush stays scan-free. */
    it('stores the entry as a hash field under the one key its tenant owns', async () => {
      const user = randomUUID();
      const key = PermissionCache.keyFor(ORG.id, user);

      await cache.write(ORG.id, user, new Set(ORG_ROLE_PERMISSIONS.member));

      await expect(cacheRedis.type(key.tenant)).resolves.toBe('hash');
      await expect(cacheRedis.keys(`${key.tenant}*`)).resolves.toEqual([key.tenant]);
    });

    it('puts the backstop TTL on the entry, not on the tenant key', async () => {
      const user = randomUUID();
      const key = PermissionCache.keyFor(ORG.id, user);

      await cache.write(ORG.id, user, new Set(ORG_ROLE_PERMISSIONS.member));

      const [ttl] = await cacheRedis.httl(key.tenant, 'FIELDS', 1, key.field);

      expect(Number(ttl)).toBeGreaterThan(0);
      expect(Number(ttl)).toBeLessThanOrEqual(PERMISSION_CACHE_TTL_SECONDS);
      await expect(cacheRedis.ttl(key.tenant)).resolves.toBe(-1);
    });

    /**
     * The delete is explicit, and it happens now rather than when the TTL runs out. This asserts
     * the entry is gone from Redis immediately — not merely that a later read misses.
     */
    it('deletes the entry outright rather than waiting for the TTL', async () => {
      const user = randomUUID();
      const key = PermissionCache.keyFor(ORG.id, user);

      await cache.write(ORG.id, user, new Set(ORG_ROLE_PERMISSIONS.owner));
      await cache.invalidate(ORG.id, user);

      await expect(cacheRedis.hexists(key.tenant, key.field)).resolves.toBe(0);
      await expect(cache.read(ORG.id, user)).resolves.toBeNull();
    });

    it('invalidates one user without touching the others in the org', async () => {
      const changed = randomUUID();
      const untouched = randomUUID();

      await Promise.all([
        cache.write(ORG.id, changed, new Set(ORG_ROLE_PERMISSIONS.member)),
        cache.write(ORG.id, untouched, new Set(ORG_ROLE_PERMISSIONS.member)),
      ]);
      await cache.invalidate(ORG.id, changed);

      await expect(cache.read(ORG.id, changed)).resolves.toBeNull();
      await expect(cache.read(ORG.id, untouched)).resolves.toEqual(
        new Set(ORG_ROLE_PERMISSIONS.member),
      );
    });

    /** For a change that moves everyone at once — a workspace role, an org-wide setting. */
    it('flushes a whole tenant without touching another', async () => {
      const user = randomUUID();

      await Promise.all([
        cache.write(ORG.id, user, new Set(ORG_ROLE_PERMISSIONS.member)),
        cache.write(OTHER_ORG.id, user, new Set(ORG_ROLE_PERMISSIONS.owner)),
      ]);
      await cache.invalidateOrg(ORG.id);

      await expect(cache.read(ORG.id, user)).resolves.toBeNull();
      await expect(cache.read(OTHER_ORG.id, user)).resolves.toEqual(
        new Set(ORG_ROLE_PERMISSIONS.owner),
      );
    });

    describe('reading through', () => {
      it('resolves on a miss and stores what it resolved', async () => {
        const user = randomUUID();
        const load = vi.fn().mockResolvedValue(new Set(ORG_ROLE_PERMISSIONS.admin));

        await expect(cache.readThrough(ORG.id, user, load)).resolves.toEqual(
          new Set(ORG_ROLE_PERMISSIONS.admin),
        );

        expect(load).toHaveBeenCalledTimes(1);
        await expect(cache.read(ORG.id, user)).resolves.toEqual(
          new Set(ORG_ROLE_PERMISSIONS.admin),
        );
      });

      it('does not resolve again on a hit', async () => {
        const user = randomUUID();
        const load = vi.fn().mockResolvedValue(new Set(ORG_ROLE_PERMISSIONS.admin));

        await cache.readThrough(ORG.id, user, load);
        await expect(cache.readThrough(ORG.id, user, load)).resolves.toEqual(
          new Set(ORG_ROLE_PERMISSIONS.admin),
        );

        expect(load).toHaveBeenCalledTimes(1);
      });

      /**
       * A cache holding something that is not a permission set is a cache with a corrupt entry, not
       * an authorisation decision. It must miss — never throw, and never grant what it found.
       */
      it.each([
        ['a value that is not JSON', 'not json'],
        ['a JSON value that is not an array', '{"org:read":true}'],
        ['an array holding something other than a slug', '["org:read",{"org:read":true}]'],
      ])('treats %s as a miss', async (_, poison) => {
        const user = randomUUID();
        const key = PermissionCache.keyFor(ORG.id, user);
        const load = vi.fn().mockResolvedValue(new Set(ORG_ROLE_PERMISSIONS.member));

        await cacheRedis.hset(key.tenant, key.field, poison);

        await expect(cache.read(ORG.id, user)).resolves.toBeNull();
        await expect(cache.readThrough(ORG.id, user, load)).resolves.toEqual(
          new Set(ORG_ROLE_PERMISSIONS.member),
        );
        expect(load).toHaveBeenCalledTimes(1);
      });
    });

    /**
     * The acceptance criterion, asserted end to end: the real resolver over changing rows, the real
     * cache over real Redis. The first test is the control — it proves the cache genuinely holds
     * the old answer, which is what makes the second one mean something. Without the explicit
     * delete, that first behaviour would persist for the whole TTL: a stale authorisation with a
     * timer on it, which is precisely what §09 rules out.
     */
    describe('a role change', () => {
      const permissionsOf = (rows: readonly ResolvedMembership[], user: string) => () =>
        Promise.resolve(resolve({ id: user }, ORG, rows, [], []));

      it('is not seen while the old answer is still cached', async () => {
        const user = randomUUID();
        const rows: ResolvedMembership[] = [
          {
            acceptedAt: new Date('2026-01-01T00:00:00Z'),
            orgId: ORG.id,
            role: 'member',
            userId: user,
          },
        ];

        await cache.readThrough(ORG.id, user, permissionsOf(rows, user));
        rows[0] = { ...rows[0]!, role: 'admin' };

        await expect(cache.readThrough(ORG.id, user, permissionsOf(rows, user))).resolves.toEqual(
          new Set(ORG_ROLE_PERMISSIONS.member),
        );
      });

      it('is served immediately once the entry is invalidated', async () => {
        const user = randomUUID();
        const rows: ResolvedMembership[] = [
          {
            acceptedAt: new Date('2026-01-01T00:00:00Z'),
            orgId: ORG.id,
            role: 'member',
            userId: user,
          },
        ];

        const before = await cache.readThrough(ORG.id, user, permissionsOf(rows, user));

        expect([...before]).not.toContain('org:members.invite');

        rows[0] = { ...rows[0]!, role: 'admin' };
        await cache.invalidate(ORG.id, user);

        const after = await cache.readThrough(ORG.id, user, permissionsOf(rows, user));

        expect(after).toEqual(new Set(ORG_ROLE_PERMISSIONS.admin));
        expect([...after]).toContain('org:members.invite');
      });

      /**
       * The dangerous direction: a demotion. A stale set here keeps granting what the user has just
       * had taken away, which is the failure §11 calls out by name.
       */
      it('withdraws a permission the moment the role is lowered', async () => {
        const user = randomUUID();
        const rows: ResolvedMembership[] = [
          {
            acceptedAt: new Date('2026-01-01T00:00:00Z'),
            orgId: ORG.id,
            role: 'owner',
            userId: user,
          },
        ];

        const before = await cache.readThrough(ORG.id, user, permissionsOf(rows, user));

        expect([...before]).toContain('org:settings.update');

        rows[0] = { ...rows[0]!, role: 'member' };
        await cache.invalidate(ORG.id, user);

        const after = await cache.readThrough(ORG.id, user, permissionsOf(rows, user));

        expect([...after]).not.toContain('org:settings.update');
        expect(after).toEqual(new Set(ORG_ROLE_PERMISSIONS.member));
      });
    });

    /**
     * "Invalidated on every membership, role and grant change" — the three writes T27 makes, each
     * run against the real resolver so the assertion is on the answer served, not on a spy.
     */
    describe('every change that moves a permission set', () => {
      const load =
        (
          user: string,
          memberships: readonly ResolvedMembership[],
          grants: readonly ResolvedProjectGrant[],
        ) =>
        () =>
          Promise.resolve(resolve({ id: user }, ORG, memberships, [], grants));

      const accepted = (user: string, role: ResolvedMembership['role']): ResolvedMembership => ({
        acceptedAt: new Date('2026-01-01T00:00:00Z'),
        orgId: ORG.id,
        role,
        userId: user,
      });

      const grant = (user: string, role: ResolvedProjectGrant['role']): ResolvedProjectGrant => ({
        orgId: ORG.id,
        projectId: PROJECT,
        role,
        userId: user,
      });

      it('serves the new set after a membership is created', async () => {
        const user = randomUUID();

        await expect(cache.readThrough(ORG.id, user, load(user, [], []))).resolves.toEqual(
          new Set(),
        );

        await cache.invalidate(ORG.id, user);

        await expect(
          cache.readThrough(ORG.id, user, load(user, [accepted(user, 'member')], [])),
        ).resolves.toEqual(new Set(ORG_ROLE_PERMISSIONS.member));
      });

      it('serves the new set after a membership is removed', async () => {
        const user = randomUUID();

        await cache.readThrough(ORG.id, user, load(user, [accepted(user, 'owner')], []));
        await cache.invalidate(ORG.id, user);

        await expect(cache.readThrough(ORG.id, user, load(user, [], []))).resolves.toEqual(
          new Set(),
        );
      });

      it('serves the new set after a project grant is revoked', async () => {
        const user = randomUUID();

        const before = await cache.readThrough(
          ORG.id,
          user,
          load(user, [accepted(user, 'member')], [grant(user, 'editor')]),
        );

        expect([...before]).toContain(scoped('project:files.write', PROJECT));

        await cache.invalidate(ORG.id, user);

        const after = await cache.readThrough(
          ORG.id,
          user,
          load(user, [accepted(user, 'member')], []),
        );

        expect([...after]).not.toContain(scoped('project:files.write', PROJECT));
      });
    });
  });

  /**
   * The asymmetry `OrgCache` documents, restated at this layer because it is what keeps a Redis
   * outage from becoming either an outage or a security hole: reads and writes degrade to "resolve
   * it again", which costs a query; a failed invalidation is reported, because swallowing it serves
   * a stale permission set.
   */
  describe('when the cache Redis is unreachable', () => {
    let dead: PermissionCache;
    let client: Redis;

    beforeAll(() => {
      client = openClient('redis://127.0.0.1:1');
      dead = new PermissionCache(new OrgCache(client));
    });

    afterAll(() => {
      client.disconnect();
    });

    it('reads as a miss rather than an error', async () => {
      await expect(dead.read(ORG.id, randomUUID())).resolves.toBeNull();
    });

    it('treats a failed write as a future miss rather than an error', async () => {
      await expect(
        dead.write(ORG.id, randomUUID(), new Set(ORG_ROLE_PERMISSIONS.member)),
      ).resolves.toBeUndefined();
    });

    it('still serves a freshly resolved set, so an outage denies nobody', async () => {
      const load = vi.fn().mockResolvedValue(new Set(ORG_ROLE_PERMISSIONS.owner));

      await expect(dead.readThrough(ORG.id, randomUUID(), load)).resolves.toEqual(
        new Set(ORG_ROLE_PERMISSIONS.owner),
      );
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('reports a failed invalidation instead of hiding it', async () => {
      await expect(dead.invalidate(ORG.id, randomUUID())).rejects.toThrow();
      await expect(dead.invalidateOrg(ORG.id)).rejects.toThrow();
    });
  });
});
