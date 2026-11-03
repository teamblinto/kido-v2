import { HealthIndicatorService } from '@nestjs/terminus';
import type pg from 'pg';
import { afterEach, describe, expect, inject, it } from 'vitest';

import { openPool } from '../../../test/support/integration-database';
import { PostgresHealthIndicator } from './postgres.health';

const reachable = inject('postgresReachable');

const pools: pg.Pool[] = [];

function track(pool: pg.Pool): pg.Pool {
  pools.push(pool);

  return pool;
}

function indicator(pool: pg.Pool): PostgresHealthIndicator {
  return new PostgresHealthIndicator(new HealthIndicatorService(), pool);
}

describe('PostgresHealthIndicator', () => {
  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
  });

  it('reports under the key the spec names', async () => {
    const health = indicator(track(openPool('postgres://forge_app:forge_app@127.0.0.1:1/forge')));

    expect(Object.keys(await health.check())).toEqual(['postgres']);
  });

  it.skipIf(!reachable)('reports up when the query round-trips', async () => {
    const health = indicator(track(openPool(process.env.DATABASE_URL!)));

    expect(await health.check()).toMatchObject({ postgres: { status: 'up' } });
  });

  /**
   * A pool that cannot connect is the interesting case: the check has to answer, with a reason,
   * rather than hang until the compose healthcheck gives up on it.
   */
  it('reports down, with a reason, when the pool cannot connect', async () => {
    const health = indicator(track(openPool('postgres://forge_app:forge_app@127.0.0.1:1/forge')));

    const result = await health.check();

    expect(result).toMatchObject({ postgres: { status: 'down' } });
    expect(String(result.postgres.message)).toMatch(/\w/);
  });

  /** The message names the failure without naming the credentials it used to find it. */
  it('does not put the connection string in the reason', async () => {
    const health = indicator(track(openPool('postgres://forge_app:hunter2@127.0.0.1:1/forge')));

    const result = (await health.check()) as { postgres: { message?: string } };

    expect(result.postgres.message ?? '').not.toContain('hunter2');
  });
});
