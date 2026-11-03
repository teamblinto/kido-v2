import { postgresReachable } from './support/integration-database';
import { assertIntegrationSuitesRan } from './support/integration-guard';
import { redisReachable } from './support/integration-redis';
import { testDatabaseUrls, testRedisUrls } from './support/test-environment';

/** Only the part of Vitest's `TestProject` this file uses. */
interface ProvidingProject {
  provide(key: 'postgresReachable' | 'redisReachable', value: boolean): void;
}

/**
 * Probes Postgres and both Redis roles once for the whole run and hands the answers to every worker
 * through `inject()`.
 *
 * Once, rather than once per file, for two reasons. It is faster — a connection attempt against a
 * host that is not listening is not instant. And it is the single place the skip policy lives: the
 * spec allows integration suites to skip loudly on a machine with no Docker, and requires CI, which
 * sets `EXPECT_INTEGRATION=1`, to treat the same silence as a failure.
 *
 * A synchronous answer is also what the specs need. `apps/api` compiles as CommonJS under Node16
 * resolution, where top-level `await` is a type error, so `describe.skipIf(...)` cannot await a
 * probe of its own.
 */
export default async function setup(project: ProvidingProject): Promise<void> {
  const postgres = await postgresReachable('integration', testDatabaseUrls());
  const redis = await redisReachable('integration', testRedisUrls());

  // Before a single suite runs, and only when `EXPECT_INTEGRATION=1`. The probes above already
  // throw on an unreachable service; this adds the half they cannot see — a suite that would not
  // have run whatever the services were doing, and therefore leaves no banner for CI to grep
  // (T33). `process.cwd()` is `apps/api`, exactly as `append-only.spec.ts` assumes.
  await assertIntegrationSuitesRan(process.cwd(), { postgres, redis });

  project.provide('postgresReachable', postgres);
  project.provide('redisReachable', redis);
}
