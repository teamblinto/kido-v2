import { Inject, Injectable } from '@nestjs/common';
import type { HealthIndicatorResult } from '@nestjs/terminus';
import { HealthIndicatorService } from '@nestjs/terminus';
import type pg from 'pg';

import { APP_POOL } from '../../database/database.constants';
import { describeProbeFailure, withProbeTimeout } from './probe';

/**
 * Postgres, probed through the pool the request path actually uses.
 *
 * Through `APP_POOL` rather than a connection of its own for a reason: §14 says "the platform is
 * down" is only an acceptable answer for Postgres, so this indicator is what decides whether the
 * container is in the load balancer. A probe on a private connection can succeed while the pool that
 * serves traffic is exhausted or holding dead sockets, and it would report health the requests do
 * not have. `select 1` is cheap and takes a connection from the same pool, so it fails when the
 * request path fails.
 */
@Injectable()
export class PostgresHealthIndicator {
  constructor(
    private readonly health: HealthIndicatorService,
    @Inject(APP_POOL) private readonly pool: pg.Pool,
  ) {}

  async check(): Promise<HealthIndicatorResult<'postgres'>> {
    const indicator = this.health.check('postgres');

    try {
      await withProbeTimeout(this.pool.query('select 1'), 'postgres');

      return indicator.up();
    } catch (error) {
      return indicator.down(describeProbeFailure(error));
    }
  }
}
