import type {
  HealthCheckResult,
  HealthCheckService,
  HealthIndicatorFunction,
  HealthIndicatorResult,
  MemoryHealthIndicator,
} from '@nestjs/terminus';
import { describe, expect, it } from 'vitest';

import type { RunProfile } from '../../config/run-profiles';
import { HealthReport } from './health-report';
import type { PostgresHealthIndicator } from './postgres.health';
import type { RedisHealthIndicator } from './redis.health';

const up = <Key extends string>(key: Key): HealthIndicatorResult<Key> =>
  ({ [key]: { status: 'up' } }) as HealthIndicatorResult<Key>;

/** A `HealthCheckService` that runs every indicator and records the names, in order. */
function build(profiles: readonly RunProfile[]): { names: string[]; report: HealthReport } {
  const names: string[] = [];
  const health = {
    async check(indicators: HealthIndicatorFunction[]): Promise<HealthCheckResult> {
      for (const indicator of indicators) {
        names.push(...Object.keys(await indicator()));
      }

      return { details: {}, error: {}, info: {}, status: 'ok' };
    },
  } as unknown as HealthCheckService;
  const memory = {
    checkHeap: (key: string) => Promise.resolve(up(key)),
    checkRSS: (key: string) => Promise.resolve(up(key)),
  } as unknown as MemoryHealthIndicator;
  const postgres = {
    check: () => Promise.resolve(up('postgres')),
  } as unknown as PostgresHealthIndicator;
  const redis = {
    checkCache: () => Promise.resolve(up('redis_cache')),
    checkQueue: () => Promise.resolve(up('redis_queue')),
    checkSession: () => Promise.resolve(up('redis_session')),
    checkStream: () => Promise.resolve(up('redis_stream')),
  } as unknown as RedisHealthIndicator;

  return { names, report: new HealthReport(health, memory, postgres, redis, new Set(profiles)) };
}

describe('HealthReport', () => {
  it('reports the seven indicators the controller served with the api profile', async () => {
    const { names, report } = build(['api']);

    await report.check();

    expect(names).toEqual([
      'memory_heap',
      'memory_rss',
      'postgres',
      'redis_session',
      'redis_cache',
      'redis_queue',
      'redis_stream',
    ]);
  });

  it('reports only the stores a worker uses without the api profile', async () => {
    const { names, report } = build(['agent', 'events']);

    await report.check();

    expect(names).toEqual(['memory_heap', 'memory_rss', 'postgres', 'redis_queue', 'redis_stream']);
  });
});
