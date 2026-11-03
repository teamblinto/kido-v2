import { ConfigModule } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { SESSION_REDIS } from '../../../common/redis/redis.constants';
import { RedisModule } from '../../../common/redis/redis.module';
import { validateEnvironment } from '../../../config/environment';
import { LinkStateStore, linkStateKey } from './link-state.store';

const reachable = inject('redisReachable');

if (!reachable) {
  console.warn('SKIPPING link-state.store.spec.ts: the session Redis is not reachable');
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Spec 032 T021: the link flow's state, bound to the person, their session and the provider, spent
 * once, stored only as a digest — against the real session Redis.
 */
describe('LinkStateStore', () => {
  describe.skipIf(!reachable)('against the session Redis', () => {
    let moduleRef: TestingModule;
    let store: LinkStateStore;
    let redis: Redis;
    const userId = randomUUID();
    const sessionId = sha256(randomUUID());
    const mine = { provider: 'openai' as const, sessionId, userId };
    const issued: string[] = [];

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
        providers: [LinkStateStore],
      }).compile();
      store = moduleRef.get(LinkStateStore);
      redis = moduleRef.get<Redis>(SESSION_REDIS);
    });

    afterAll(async () => {
      await Promise.all(issued.map((state) => redis.del(linkStateKey(sha256(state)))));
      await moduleRef.close();
    });

    async function issue(): Promise<string> {
      const state = await store.issue(userId, sessionId, 'openai', 'the-verifier');
      issued.push(state);
      return state;
    }

    it('issues a 43-character base64url state, stored only under its digest with a TTL', async () => {
      const state = await issue();

      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await redis.exists(`byos:state:${state}`)).toBe(0);
      const key = linkStateKey(sha256(state));
      expect(key).toBe(`byos:state:${sha256(state)}`);
      expect(await redis.hgetall(key)).toEqual({
        pkce: 'the-verifier',
        provider: 'openai',
        sessionHash: sha256(sessionId),
        userId,
      });
      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(600);
      const keys = await redis.keys('byos:state:*');
      expect(keys.some((stored) => stored.includes(state))).toBe(false);
    });

    it('consumes once for the same person, session and provider', async () => {
      const state = await issue();

      expect(await store.consume(state, mine)).toEqual({
        pkce: 'the-verifier',
        provider: 'openai',
        userId,
      });
      expect(await store.consume(state, mine)).toBeUndefined();
    });

    it.each([
      ['another user', { ...mine, userId: randomUUID() }],
      ['the same user in another session', { ...mine, sessionId: sha256('other session') }],
      ['another provider', { ...mine, provider: 'anthropic' as const }],
    ])('refuses %s, and the state is spent anyway', async (_, expectation) => {
      const state = await issue();

      expect(await store.consume(state, expectation)).toBeUndefined();
      expect(await store.consume(state, mine)).toBeUndefined();
    });

    it('refuses an expired state', async () => {
      const state = await issue();
      await redis.del(linkStateKey(sha256(state)));

      expect(await store.consume(state, mine)).toBeUndefined();
    });

    it('keeps a device flow’s code server-side and can put a pending state back', async () => {
      const state = await store.issue(userId, sessionId, 'openai', 'v', {
        deviceCode: 'dc',
        intervalSeconds: 5,
      });
      issued.push(state);

      const first = await store.consume(state, mine);
      expect(first).toEqual({
        deviceCode: 'dc',
        intervalSeconds: 5,
        pkce: 'v',
        provider: 'openai',
        userId,
      });
      await store.restore(state, sessionId, first!);
      expect(await store.consume(state, mine)).toEqual(first);
    });
  });
});
