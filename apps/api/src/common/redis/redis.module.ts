import type { OnApplicationShutdown } from '@nestjs/common';
import { Global, Inject, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { once } from 'node:events';

import type { Environment } from '../../config/environment';
import { OrgCache } from './org-cache';
import { CACHE_REDIS, QUEUE_REDIS, SESSION_REDIS, STREAM_REDIS } from './redis.constants';

interface RoleOptions {
  /** How long a single connect attempt may take before it counts as a failure. */
  connectTimeout: number;
  /**
   * How many reconnect attempts a command issued while the instance is unreachable will wait
   * through before it fails. This is the number that decides how long an outage costs a request.
   * `null` is no cap at all — a command waits out the whole outage — and is what BullMQ requires of
   * a blocking connection it duplicates from ours (research R2).
   */
  maxRetriesPerRequest: number | null;
  role: 'cache' | 'queue' | 'session' | 'stream';
  url: string;
}

function client({ connectTimeout, maxRetriesPerRequest, role, url }: RoleOptions): Redis {
  const instance = new Redis(url, {
    connectTimeout,
    // Names the connection in `CLIENT LIST`, so a stray connection on either instance can be traced
    // back to a role rather than to "some node process".
    connectionName: `forge-${role}`,
    // Lazy, so that compiling the application is not a network call and a Redis that is briefly
    // absent at boot delays the first command rather than the process.
    lazyConnect: true,
    maxRetriesPerRequest,
  });

  // An `error` event with no listener is an unhandled error, which would take the process down on a
  // reconnect attempt. Logged at warn because ioredis retries on its own: the interesting signal is
  // the health indicator, not one refused connection.
  const logger = new Logger(`Redis:${role}`);

  instance.on('error', (error: Error) => logger.warn(error.message));

  return instance;
}

/**
 * The four Redis roles §09 keeps on separate instances, and the org-scoped cache API over one of
 * them.
 *
 * §09 gives Redis four logical roles and says they "must not share one instance because their
 * eviction policies are mutually contradictory". The difference between them is not only server
 * configuration — it is how long each will wait during an outage:
 *
 * A session command is worth waiting a reconnect for, because the alternative is an error on a
 * request that was authenticated a moment ago, and signing users out is precisely what that
 * instance's `noeviction` policy exists to prevent. It gets the longer retry budget.
 *
 * A cache command is not. Waiting turns a free miss into latency on the request path, and §09 keeps
 * nothing in that instance which Postgres cannot rebuild — so it gets one attempt and then misses.
 *
 * A queue command has no cap. BullMQ hands a duplicate of this client to every worker as its blocking
 * connection, and a `BZPOPMIN` that dies after N reconnect attempts mid-outage is a worker that has
 * silently stopped consuming — so BullMQ requires `maxRetriesPerRequest: null` there, and warns
 * rather than forces it on a client it did not build itself (research R2).
 *
 * A stream command gets the cache's budget. The publisher never lets a failed append fail a run
 * and a viewer's tail is replayable from Postgres, so waiting out an outage buys nothing but
 * latency on the write path.
 *
 * No client refuses commands while disconnected: with `lazyConnect`, the first command *is* the
 * connect, and a client that rejected it would never make a first call at all.
 *
 * `@Global` for the reason `DatabaseModule` gives: sessions, throttling, idempotency and the
 * permission cache all reach for these, and making a dozen modules restate the same import buys
 * nothing.
 */
@Global()
@Module({
  exports: [CACHE_REDIS, QUEUE_REDIS, SESSION_REDIS, STREAM_REDIS, OrgCache],
  providers: [
    {
      inject: [ConfigService],
      provide: SESSION_REDIS,
      useFactory: (config: ConfigService<Environment, true>) =>
        client({
          connectTimeout: 5_000,
          maxRetriesPerRequest: 5,
          role: 'session',
          url: config.get('REDIS_SESSION_URL', { infer: true }),
        }),
    },
    {
      inject: [ConfigService],
      provide: CACHE_REDIS,
      useFactory: (config: ConfigService<Environment, true>) =>
        client({
          connectTimeout: 2_000,
          maxRetriesPerRequest: 1,
          role: 'cache',
          url: config.get('REDIS_CACHE_URL', { infer: true }),
        }),
    },
    {
      inject: [ConfigService],
      provide: QUEUE_REDIS,
      useFactory: (config: ConfigService<Environment, true>) =>
        client({
          connectTimeout: 5_000,
          maxRetriesPerRequest: null,
          role: 'queue',
          url: config.get('REDIS_QUEUE_URL', { infer: true }),
        }),
    },
    {
      inject: [ConfigService],
      provide: STREAM_REDIS,
      useFactory: (config: ConfigService<Environment, true>) =>
        client({
          connectTimeout: 2_000,
          maxRetriesPerRequest: 1,
          role: 'stream',
          url: config.get('REDIS_STREAM_URL', { infer: true }),
        }),
    },
    OrgCache,
  ],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(
    @Inject(SESSION_REDIS) private readonly session: Redis,
    @Inject(CACHE_REDIS) private readonly cache: Redis,
    @Inject(QUEUE_REDIS) private readonly queue: Redis,
    @Inject(STREAM_REDIS) private readonly stream: Redis,
  ) {}

  /**
   * Every client closes on SIGTERM — `bootstrap.ts` already calls `enableShutdownHooks()` — so a
   * rolling deploy drains instead of leaving the session instance holding connections that will
   * never send another command.
   *
   * `quit()` only for a client that is actually connected: on a lazy client that never dialled, it
   * would open a connection for the sole purpose of closing it.
   */
  async onApplicationShutdown(): Promise<void> {
    await Promise.all([
      close(this.session),
      close(this.cache),
      close(this.queue),
      close(this.stream),
    ]);
  }
}

/** Long enough for a `QUIT` round trip on a healthy instance, short enough not to stall a deploy. */
const SHUTDOWN_TIMEOUT_MS = 2_000;

async function close(instance: Redis): Promise<void> {
  if (instance.status === 'end') {
    return;
  }

  // Attached before anything closes, or a fast `end` would fire before there is anyone to hear it.
  // `once` also rejects on `error`, which on a client that is already failing is not news.
  const ended = once(instance, 'end').catch(() => undefined);

  if (instance.status === 'ready') {
    try {
      await instance.quit();
    } catch {
      // A client that could not say goodbye still has to let go of its socket, below.
    }
  }

  instance.disconnect();

  // `quit()` resolves on the server's reply and the socket closes a tick later, so the wait is what
  // makes "closed" true when this returns rather than shortly afterwards. Bounded, because a
  // shutdown hook that hangs turns a rolling deploy into an outage.
  await Promise.race([ended, delay(SHUTDOWN_TIMEOUT_MS)]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
