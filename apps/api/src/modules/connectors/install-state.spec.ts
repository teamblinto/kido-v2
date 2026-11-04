import { ConfigModule } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { SESSION_REDIS } from '../../common/redis/redis.constants';
import { RedisModule } from '../../common/redis/redis.module';
import { validateEnvironment } from '../../config/environment';
import { InstallStateStore, installStateKey } from './install-state';

const reachable = inject('redisReachable');

if (!reachable) {
  console.warn('SKIPPING install-state.spec.ts: the session Redis is not reachable');
}

/**
 * Research R8: the install flow's state is the sign-in flow's state dance — a digest key, a TTL,
 * one consume — against the real session Redis, because which commands it uses is the point.
 */
describe('InstallStateStore', () => {
  describe.skipIf(!reachable)('against the session Redis', () => {
    let moduleRef: TestingModule;
    let store: InstallStateStore;
    let redis: Redis;
    const orgId = randomUUID();
    const userId = randomUUID();
    const issued: string[] = [];
    const github = { orgId, provider: 'github' as const, userId };

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
        providers: [InstallStateStore],
      }).compile();

      store = moduleRef.get(InstallStateStore);
      redis = moduleRef.get<Redis>(SESSION_REDIS);
    });

    afterAll(async () => {
      await Promise.all(issued.map((state) => redis.del(installStateKey(digest(state)))));
      await moduleRef.close();
    });

    function digest(state: string): string {
      return createHash('sha256').update(state).digest('hex');
    }

    async function issue(): Promise<string> {
      const state = await store.issue(orgId, userId);

      issued.push(state);

      return state;
    }

    it('issues 32 random bytes as base64url, stored under the digest with the OAuth TTL', async () => {
      const state = await issue();

      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(Buffer.from(state, 'base64url')).toHaveLength(32);
      expect(await issue()).not.toBe(state);

      const key = installStateKey(digest(state));

      await expect(redis.hgetall(key)).resolves.toEqual({ orgId, provider: 'github', userId });

      const ttl = await redis.ttl(key);

      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(600);
    });

    it('never stores the raw state as a key', async () => {
      const state = await issue();

      await expect(redis.exists(state, `cn:state:${state}`)).resolves.toBe(0);
    });

    it('consumes once: the second call answers undefined', async () => {
      const state = await issue();

      await expect(store.consume(state, github)).resolves.toEqual({
        orgId,
        provider: 'github',
        userId,
      });
      await expect(store.consume(state, github)).resolves.toBeUndefined();
      await expect(redis.exists(installStateKey(digest(state)))).resolves.toBe(0);
    });

    it('answers undefined for an expired or unknown state', async () => {
      const state = await issue();

      await redis.del(installStateKey(digest(state)));

      await expect(store.consume(state, github)).resolves.toBeUndefined();
      await expect(store.consume('never-issued', github)).resolves.toBeUndefined();
    });

    // Spec 030 T032: the Supabase install carries its PKCE verifier and its provider in the state.
    it('stores the provider and the PKCE verifier in the state hash', async () => {
      const state = await store.issue(orgId, userId, {
        pkce: 'the-verifier',
        provider: 'supabase',
      });
      issued.push(state);

      await expect(redis.hgetall(installStateKey(digest(state)))).resolves.toEqual({
        orgId,
        pkce: 'the-verifier',
        provider: 'supabase',
        userId,
      });
      await expect(store.consume(state, { orgId, provider: 'supabase', userId })).resolves.toEqual({
        orgId,
        pkce: 'the-verifier',
        provider: 'supabase',
        userId,
      });
    });

    it('spec 044: a create’s state carries the request, for its project and no other, and is spent by a wrong one', async () => {
      const projectId = randomUUID();
      const repoCreate = { name: 'blog', private: false, projectId };
      const issue044 = async () => {
        const state = await store.issue(orgId, userId, { repoCreate });

        issued.push(state);

        return state;
      };
      const state = await issue044();

      await expect(store.consume(state, { ...github, projectId })).resolves.toEqual({
        ...github,
        repoCreate,
      });

      const wrong = await issue044();

      await expect(
        store.consume(wrong, { ...github, projectId: randomUUID() }),
      ).resolves.toBeUndefined();
      await expect(store.consume(wrong, { ...github, projectId })).resolves.toBeUndefined();

      // An install names no project, so a create's state cannot finish one.
      await expect(store.consume(await issue044(), github)).resolves.toBeUndefined();
    });

    it.each([
      ['another provider', { orgId, provider: 'github' as const, userId }],
      ['another organisation', { orgId: randomUUID(), provider: 'supabase' as const, userId }],
      ['another user', { orgId, provider: 'supabase' as const, userId: randomUUID() }],
    ])('refuses a state consumed for %s, and spends it', async (_label, expected) => {
      const state = await store.issue(orgId, userId, { pkce: 'v', provider: 'supabase' });
      issued.push(state);

      await expect(store.consume(state, expected)).resolves.toBeUndefined();
      await expect(
        store.consume(state, { orgId, provider: 'supabase', userId }),
      ).resolves.toBeUndefined();
    });
  });
});
