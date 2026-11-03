import { ConfigModule } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import type { ApiHealthResponse } from '@repo/types' with { 'resolution-mode': 'import' };
import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';

import { openClient } from '../../../test/support/integration-redis';
import { DomainError } from '../../common/errors/domain-error';
import { CACHE_REDIS } from '../../common/redis/redis.constants';
import { RedisModule } from '../../common/redis/redis.module';
import { validateEnvironment } from '../../config/environment';
import { DatabaseModule } from '../../database/database.module';
import { HealthController } from './health.controller';
import { HealthModule } from './health.module';

const servicesReachable = inject('postgresReachable') && inject('redisReachable');

const INDICATORS = [
  'memory_heap',
  'memory_rss',
  'postgres',
  'redis_cache',
  'redis_queue',
  'redis_session',
  'redis_stream',
];

/**
 * Which indicator said what, from whichever of the two answers arrived — a 200 body or the problem
 * detail of a 503. Both are results here: which one comes back depends on whether Docker is running,
 * and most of what this suite asserts is true either way.
 */
async function indicatorsOf(controller: HealthController): Promise<Record<string, string>> {
  try {
    const report: ApiHealthResponse = await controller.check();

    return Object.fromEntries(
      Object.entries(report.details).map(([name, result]) => [name, result.status]),
    );
  } catch (error) {
    if (error instanceof DomainError) {
      return error.extensions.indicators as Record<string, string>;
    }

    throw error;
  }
}

describe('HealthController', () => {
  let moduleRef: TestingModule;
  let deadCache: Redis | undefined;

  async function compile(): Promise<HealthController> {
    const builder = Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          isGlobal: true,
          validate: validateEnvironment,
        }),
        DatabaseModule,
        RedisModule,
        HealthModule,
      ],
    });

    if (deadCache) {
      builder.overrideProvider(CACHE_REDIS).useValue(deadCache);
    }

    moduleRef = await builder.compile();

    return moduleRef.get(HealthController);
  }

  beforeEach(() => {
    deadCache = undefined;
  });

  afterEach(async () => {
    deadCache?.disconnect();
    await moduleRef.close();
  });

  it('reports the postgres and all three redis indicators alongside memory', async () => {
    expect(Object.keys(await indicatorsOf(await compile())).sort()).toEqual(INDICATORS);
  });

  it.skipIf(!servicesReachable)('is ok when postgres and all redis roles answer', async () => {
    const controller = await compile();

    await expect(controller.check()).resolves.toMatchObject({ status: 'ok' });
  });

  /**
   * The unit-test half of the `docker compose stop redis-cache` proof: one role down, the other role
   * and Postgres up, and the endpoint failing so the container healthcheck fails with it.
   *
   * The failure is a `DomainError` and not Terminus' own `ServiceUnavailableException` because
   * `ProblemDetailsFilter` replaces the body of any other 5xx with a generic one — server-side text
   * is not safe to hand to a client — and that would throw away the only interesting thing about this
   * response: which dependency is missing.
   */
  it.skipIf(!servicesReachable)('names the failing role, and only that one', async () => {
    deadCache = openClient('redis://127.0.0.1:1');

    const controller = await compile();

    await expect(controller.check()).rejects.toThrow(DomainError);
    await expect(indicatorsOf(controller)).resolves.toEqual({
      memory_heap: 'up',
      memory_rss: 'up',
      postgres: 'up',
      redis_cache: 'down',
      redis_queue: 'up',
      redis_session: 'up',
      redis_stream: 'up',
    });
  });

  /**
   * The reason an indicator is down is a driver message: it names hosts, ports and sometimes users.
   * Terminus logs the whole thing server-side, which is where an operator should read it; the public
   * document says which dependency and no more.
   */
  it.skipIf(!servicesReachable)('does not put the driver message in the response', async () => {
    deadCache = openClient('redis://127.0.0.1:1');

    const controller = await compile();
    const error = await controller.check().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(DomainError);
    expect(JSON.stringify((error as DomainError).extensions)).not.toMatch(/127\.0\.0\.1/);
  });
});
