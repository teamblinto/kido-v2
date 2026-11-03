import { Inject, Injectable } from '@nestjs/common';
import type { HealthCheckResult, HealthIndicatorFunction } from '@nestjs/terminus';
import { HealthCheckService, MemoryHealthIndicator } from '@nestjs/terminus';

import { RUN_PROFILES_TOKEN } from '../../common/run-profiles/run-profiles.constants';
import type { RunProfile } from '../../config/run-profiles';
import { PostgresHealthIndicator } from './postgres.health';
import { RedisHealthIndicator } from './redis.health';

/**
 * The one indicator list, served by `HealthController` through the API pipeline and by
 * `LivenessServer` on a worker (spec 013, research R5), so the two answers cannot drift.
 *
 * The list is profile-aware. A process without `api` never reads the session or cache stores, and
 * a health report is a restart trigger: a worker restarted because the session Redis went away is
 * a worker restarted for a reason that is not its own — §14's bulkhead, in the other direction
 * (FR-024). So a worker reports memory, Postgres, the queue store it drains and the stream store
 * it publishes to, and no other.
 */
@Injectable()
export class HealthReport {
  constructor(
    private readonly health: HealthCheckService,
    private readonly memory: MemoryHealthIndicator,
    private readonly postgres: PostgresHealthIndicator,
    private readonly redis: RedisHealthIndicator,
    @Inject(RUN_PROFILES_TOKEN) private readonly profiles: ReadonlySet<RunProfile>,
  ) {}

  /** Throws Terminus' `ServiceUnavailableException` (body: the report) when an indicator is down. */
  async check(): Promise<HealthCheckResult> {
    const api = this.profiles.has('api');
    const indicators: HealthIndicatorFunction[] = [
      () => this.memory.checkHeap('memory_heap', 300 * 1024 * 1024),
      () => this.memory.checkRSS('memory_rss', 500 * 1024 * 1024),
      () => this.postgres.check(),
      ...(api ? [() => this.redis.checkSession(), () => this.redis.checkCache()] : []),
      () => this.redis.checkQueue(),
      () => this.redis.checkStream(),
    ];

    return this.health.check(indicators);
  }
}
