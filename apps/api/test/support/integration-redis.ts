import { Redis } from 'ioredis';

import { redactUrl } from './integration-database';

/**
 * A probe client, not a runtime one: it gives up immediately instead of reconnecting, because the
 * question being asked is "is this instance there right now?" and a retry loop answers it slowly.
 */
export function openClient(url: string): Redis {
  const client = new Redis(url, {
    connectTimeout: 2_000,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });

  // An `error` event with no listener is an unhandled error, which would take the worker down
  // rather than answer the question.
  client.on('error', () => undefined);

  return client;
}

async function isReachable(client: Redis): Promise<boolean> {
  try {
    await client.connect();
    await client.ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * The Redis half of the skip policy in `integration-database.ts`, and deliberately identical to it:
 * a suite may skip loudly on a machine with no Docker, and CI, which sets `EXPECT_INTEGRATION=1`,
 * treats the same silence as a failure.
 */
export async function redisReachable(suite: string, urls: readonly string[]): Promise<boolean> {
  const clients = urls.map((url) => openClient(url));
  const probes = await Promise.all(clients.map(isReachable));

  for (const client of clients) {
    client.disconnect();
  }

  if (probes.every(Boolean)) {
    return true;
  }

  const unreachable = urls.filter((_, index) => !probes[index]).map(redactUrl);

  if (process.env.EXPECT_INTEGRATION === '1') {
    throw new Error(
      `EXPECT_INTEGRATION=1 but Redis is unreachable at ${unreachable.join(', ')} — ` +
        `CI must not skip "${suite}".`,
    );
  }

  console.warn(
    [
      '',
      '='.repeat(100),
      `SKIPPING "${suite}": Redis is unreachable at ${unreachable.join(', ')}.`,
      'Start both roles with `docker compose up -d redis-session redis-cache`.',
      'CI runs this suite with EXPECT_INTEGRATION=1, where an unreachable Redis is a failure.',
      '='.repeat(100),
      '',
    ].join('\n'),
  );

  return false;
}
