import { ConfigModule } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import { afterEach, describe, expect, inject, it } from 'vitest';

import { validateEnvironment } from '../../config/environment';
import { OrgCache } from './org-cache';
import { CACHE_REDIS, QUEUE_REDIS, SESSION_REDIS, STREAM_REDIS } from './redis.constants';
import { RedisModule } from './redis.module';

const reachable = inject('redisReachable');

async function compile(): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true, validate: validateEnvironment }),
      RedisModule,
    ],
  }).compile();
}

describe('RedisModule', () => {
  let moduleRef: TestingModule | undefined;

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
  });

  /**
   * §09 gives Redis four logical roles and says they "must not share one instance because their
   * eviction policies are mutually contradictory". One client per role is how that separation
   * reaches the application: a service asks for the role it needs and cannot silently get another.
   */
  it('provides a distinct client for each of the four roles', async () => {
    moduleRef = await compile();

    const session = moduleRef.get<Redis>(SESSION_REDIS);
    const cache = moduleRef.get<Redis>(CACHE_REDIS);
    const queue = moduleRef.get<Redis>(QUEUE_REDIS);
    const stream = moduleRef.get<Redis>(STREAM_REDIS);

    expect(session).toBeDefined();
    expect(cache).toBeDefined();
    expect(queue).toBeDefined();
    expect(stream).toBeDefined();
    expect(new Set([session, cache, queue, stream]).size).toBe(4);
  });

  it('points each client at its own instance', async () => {
    moduleRef = await compile();

    expect(moduleRef.get<Redis>(SESSION_REDIS).options.port).toBe(
      Number(new URL(process.env.REDIS_SESSION_URL!).port),
    );
    expect(moduleRef.get<Redis>(CACHE_REDIS).options.port).toBe(
      Number(new URL(process.env.REDIS_CACHE_URL!).port),
    );
    expect(moduleRef.get<Redis>(QUEUE_REDIS).options.port).toBe(
      Number(new URL(process.env.REDIS_QUEUE_URL!).port),
    );
    expect(moduleRef.get<Redis>(STREAM_REDIS).options.port).toBe(
      Number(new URL(process.env.REDIS_STREAM_URL!).port),
    );
  });

  /**
   * BullMQ duplicates this client for its blocking connection and requires
   * `maxRetriesPerRequest: null` on it: a `BZPOPMIN` that gives up after N reconnect attempts
   * mid-outage is a worker that has silently stopped consuming (research R2).
   */
  it('gives the queue role no per-request retry cap', async () => {
    moduleRef = await compile();

    expect(moduleRef.get<Redis>(QUEUE_REDIS).options.maxRetriesPerRequest).toBeNull();
  });

  /**
   * Lazy, so that compiling the module — which every unit test does — is not a network call, and so
   * that a Redis that is briefly absent at boot delays the first command rather than the process.
   */
  it('connects lazily, so nothing dials Redis until something asks it to', async () => {
    moduleRef = await compile();

    expect(moduleRef.get<Redis>(SESSION_REDIS).status).toBe('wait');
    expect(moduleRef.get<Redis>(CACHE_REDIS).status).toBe('wait');
  });

  /**
   * The retry budget is the difference between the two roles under a blip, and §14's standing rule —
   * "an unbounded call is a latent outage" — is why both have one at all. A session command is worth
   * waiting a reconnect for, because the alternative is signing out a user who authenticated a moment
   * ago. A cache command is not: waiting turns a free miss into latency on the request path.
   */
  it('gives the session role a longer retry budget than the cache role', async () => {
    moduleRef = await compile();

    const session = moduleRef.get<Redis>(SESSION_REDIS).options;
    const cache = moduleRef.get<Redis>(CACHE_REDIS).options;

    expect(cache.maxRetriesPerRequest).toBe(1);
    expect(session.maxRetriesPerRequest).toBeGreaterThan(cache.maxRetriesPerRequest!);
    expect(cache.connectTimeout).toBeLessThan(session.connectTimeout!);
  });

  /**
   * A failed append never fails a run and a viewer's tail is replayable from Postgres, so the
   * stream role waits no longer than the cache does (009).
   */
  it('gives the stream role the cache-like retry budget', async () => {
    moduleRef = await compile();

    const stream = moduleRef.get<Redis>(STREAM_REDIS).options;
    const cache = moduleRef.get<Redis>(CACHE_REDIS).options;

    expect(stream.maxRetriesPerRequest).toBe(cache.maxRetriesPerRequest);
    expect(stream.connectTimeout).toBe(cache.connectTimeout);
  });

  /**
   * The retry budget in wall-clock terms: a cache command during an outage costs a miss, not a stall.
   * That bound is what makes the fail-open read in `OrgCache` safe to put on the request path.
   */
  it('gives up on a cache command in well under a second when the instance is unreachable', async () => {
    const configured = process.env.REDIS_CACHE_URL;
    process.env.REDIS_CACHE_URL = 'redis://127.0.0.1:1';

    try {
      moduleRef = await compile();

      const started = process.hrtime.bigint();

      await expect(moduleRef.get<Redis>(CACHE_REDIS).ping()).rejects.toThrow();

      expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(1_000);
    } finally {
      process.env.REDIS_CACHE_URL = configured;
    }
  });

  it('exposes the org-scoped cache API', async () => {
    moduleRef = await compile();

    expect(moduleRef.get(OrgCache)).toBeInstanceOf(OrgCache);
  });

  it('closes all four clients on shutdown', async () => {
    const local = await compile();
    const session = local.get<Redis>(SESSION_REDIS);
    const cache = local.get<Redis>(CACHE_REDIS);
    const queue = local.get<Redis>(QUEUE_REDIS);
    const stream = local.get<Redis>(STREAM_REDIS);

    await local.close();

    expect(session.status, 'the session client outlived the application').toBe('end');
    expect(cache.status, 'the cache client outlived the application').toBe('end');
    expect(queue.status, 'the queue client outlived the application').toBe('end');
    expect(stream.status, 'the stream client outlived the application').toBe('end');
  });

  it.skipIf(!reachable)('closes both clients on shutdown after they have connected', async () => {
    const local = await compile();
    const session = local.get<Redis>(SESSION_REDIS);
    const cache = local.get<Redis>(CACHE_REDIS);

    await Promise.all([session.ping(), cache.ping()]);

    expect(session.status).toBe('ready');
    expect(cache.status).toBe('ready');

    await local.close();

    expect(session.status).toBe('end');
    expect(cache.status).toBe('end');
  });

  /**
   * The two roles are two servers, not two databases on one, and their configuration is what proves
   * it: one instance cannot be both `noeviction` and `allkeys-lru` (§09).
   */
  it.skipIf(!reachable)(
    'talks to instances configured with the two policies §09 requires',
    async () => {
      moduleRef = await compile();

      const policyOf = (client: Redis) => client.config('GET', 'maxmemory-policy');

      expect(await policyOf(moduleRef.get<Redis>(SESSION_REDIS))).toEqual([
        'maxmemory-policy',
        'noeviction',
      ]);
      expect(await policyOf(moduleRef.get<Redis>(CACHE_REDIS))).toEqual([
        'maxmemory-policy',
        'allkeys-lru',
      ]);
      expect(await policyOf(moduleRef.get<Redis>(STREAM_REDIS))).toEqual([
        'maxmemory-policy',
        'noeviction',
      ]);
    },
  );
});
