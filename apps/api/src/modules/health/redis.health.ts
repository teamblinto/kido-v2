import { Inject, Injectable } from '@nestjs/common';
import type { HealthIndicatorResult } from '@nestjs/terminus';
import { HealthIndicatorService } from '@nestjs/terminus';
import type { Redis } from 'ioredis';

import {
  CACHE_REDIS,
  QUEUE_REDIS,
  SESSION_REDIS,
  STREAM_REDIS,
} from '../../common/redis/redis.constants';
import { describeProbeFailure, withProbeTimeout } from './probe';

/**
 * The four Redis roles, reported separately.
 *
 * Separately because they fail separately and mean different things: losing the session instance
 * signs users out, losing the cache instance costs a Postgres query per miss, losing the queue
 * instance stops the outbox relay publishing, and losing the stream instance costs live tails
 * only — runs still complete, viewers get `503` (§09, 009). Reporting one `redis` indicator would collapse
 * those into one word and lose the distinction §09 exists to make — and `docker compose stop
 * redis-cache` would then look identical to losing sessions.
 *
 * All four are gates on the container. The cache role is the softest failure, but a container that
 * cannot reach it is degraded, and §09's caching contract ("explicit delete on write") assumes an
 * instance that is there to receive the delete. A container that cannot reach the queue should not
 * be taking traffic that produces events (FR-024).
 */
@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly health: HealthIndicatorService,
    @Inject(SESSION_REDIS) private readonly session: Redis,
    @Inject(CACHE_REDIS) private readonly cache: Redis,
    @Inject(QUEUE_REDIS) private readonly queue: Redis,
    @Inject(STREAM_REDIS) private readonly stream: Redis,
  ) {}

  async checkSession(): Promise<HealthIndicatorResult<'redis_session'>> {
    return this.ping('redis_session', this.session);
  }

  async checkCache(): Promise<HealthIndicatorResult<'redis_cache'>> {
    return this.ping('redis_cache', this.cache);
  }

  async checkQueue(): Promise<HealthIndicatorResult<'redis_queue'>> {
    return this.ping('redis_queue', this.queue);
  }

  async checkStream(): Promise<HealthIndicatorResult<'redis_stream'>> {
    return this.ping('redis_stream', this.stream);
  }

  private async ping<Key extends string>(
    key: Key,
    client: Redis,
  ): Promise<HealthIndicatorResult<Key>> {
    const indicator = this.health.check(key);

    try {
      // A `PING` and not `status === 'ready'`: the status says what the client believes about a
      // socket, and a half-open socket believes it is fine. The round trip is the only answer.
      await withProbeTimeout(client.ping(), key);

      return indicator.up();
    } catch (error) {
      return indicator.down(describeProbeFailure(error));
    }
  }
}
