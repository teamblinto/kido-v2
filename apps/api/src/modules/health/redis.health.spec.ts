import { HealthIndicatorService } from '@nestjs/terminus';
import { Redis } from 'ioredis';
import { afterEach, describe, expect, inject, it } from 'vitest';

import { openClient } from '../../../test/support/integration-redis';
import { RedisHealthIndicator } from './redis.health';

const reachable = inject('redisReachable');

const clients: Redis[] = [];

function track(client: Redis): Redis {
  clients.push(client);

  return client;
}

/** A client that gives up at once — the shape of the probe clients used elsewhere in the suite. */
function deadFailFast(): Redis {
  return track(openClient('redis://127.0.0.1:1'));
}

/**
 * Connected before the probe runs, because these clients have no offline queue: the runtime clients
 * from `RedisModule` do, so for them the first command is the connect.
 */
async function live(url: string): Promise<Redis> {
  const client = track(openClient(url));

  await client.connect();

  return client;
}

/**
 * A client with the runtime session role's settings: an offline queue and ioredis' default retry
 * strategy, which reconnects forever. A command issued through it while the instance is down does
 * not fail — it waits — which is the trap a health check has to be immune to.
 */
function deadReconnectingForever(): Redis {
  const client = track(new Redis('redis://127.0.0.1:1', { lazyConnect: true }));

  client.on('error', () => undefined);

  return client;
}

function indicator(
  session: Redis,
  cache: Redis,
  queue: Redis = deadFailFast(),
  stream: Redis = deadFailFast(),
): RedisHealthIndicator {
  return new RedisHealthIndicator(new HealthIndicatorService(), session, cache, queue, stream);
}

describe('RedisHealthIndicator', () => {
  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.disconnect();
    }
  });

  it('reports the two roles under the keys the spec names', async () => {
    const health = indicator(deadFailFast(), deadFailFast());

    expect(Object.keys(await health.checkSession())).toEqual(['redis_session']);
    expect(Object.keys(await health.checkCache())).toEqual(['redis_cache']);
  });

  it('reports the queue role under redis_queue', async () => {
    const health = indicator(deadFailFast(), deadFailFast(), deadFailFast());

    expect(Object.keys(await health.checkQueue())).toEqual(['redis_queue']);
  });

  /**
   * FR-024: an unreachable queue instance fails the container the same way the other two roles do.
   * A relay that cannot reach its queue is not publishing, and a container that is not publishing
   * should not be taking traffic that produces events.
   */
  it('reports redis_queue down when the queue instance is unreachable', async () => {
    const health = indicator(deadFailFast(), deadFailFast(), deadFailFast());

    const result = await health.checkQueue();

    expect(result).toMatchObject({ redis_queue: { status: 'down' } });
    expect(String(result.redis_queue.message)).toMatch(/w/);
  });

  it('reports the stream role under redis_stream, down when unreachable', async () => {
    const health = indicator(deadFailFast(), deadFailFast(), deadFailFast(), deadFailFast());

    const result = await health.checkStream();

    expect(Object.keys(result)).toEqual(['redis_stream']);
    expect(result).toMatchObject({ redis_stream: { status: 'down' } });
  });

  it.skipIf(!reachable)('reports the stream role up when its instance answers', async () => {
    const health = indicator(
      deadFailFast(),
      deadFailFast(),
      deadFailFast(),
      await live(process.env.REDIS_STREAM_URL!),
    );

    expect(await health.checkStream()).toMatchObject({ redis_stream: { status: 'up' } });
  });

  it.skipIf(!reachable)('reports the queue role up when its instance answers', async () => {
    const health = indicator(
      deadFailFast(),
      deadFailFast(),
      await live(process.env.REDIS_QUEUE_URL!),
    );

    expect(await health.checkQueue()).toMatchObject({ redis_queue: { status: 'up' } });
  });

  it.skipIf(!reachable)('reports both roles up when both instances answer', async () => {
    const health = indicator(
      await live(process.env.REDIS_SESSION_URL!),
      await live(process.env.REDIS_CACHE_URL!),
    );

    expect(await health.checkSession()).toMatchObject({ redis_session: { status: 'up' } });
    expect(await health.checkCache()).toMatchObject({ redis_cache: { status: 'up' } });
  });

  /**
   * The acceptance criterion in prose: one role down does not take the other with it. The docker
   * proof of the same thing is `docker compose stop redis-cache`.
   */
  it.skipIf(!reachable)('reports one role down while the other stays up', async () => {
    const health = indicator(await live(process.env.REDIS_SESSION_URL!), deadFailFast());

    expect(await health.checkSession()).toMatchObject({ redis_session: { status: 'up' } });
    expect(await health.checkCache()).toMatchObject({ redis_cache: { status: 'down' } });
  });

  it('reports down, with a reason, when the instance refuses the connection', async () => {
    const health = indicator(deadFailFast(), deadFailFast());

    const result = await health.checkCache();

    expect(result).toMatchObject({ redis_cache: { status: 'down' } });
    expect(String(result.redis_cache.message)).toMatch(/\w/);
  });

  /**
   * §14's standing rule — "every outbound call has a timeout … an unbounded call is a latent
   * outage" — applied to the probe itself. Without a timeout this call never settles, the compose
   * healthcheck times out with no answer, and the indicator reports nothing at all.
   */
  it('reports down within the probe timeout even when the client would reconnect forever', async () => {
    const health = indicator(deadReconnectingForever(), deadFailFast());
    const started = process.hrtime.bigint();

    const result = await health.checkSession();
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(result).toMatchObject({ redis_session: { status: 'down' } });
    expect(elapsedMs).toBeLessThan(2_500);
  }, 10_000);
});
