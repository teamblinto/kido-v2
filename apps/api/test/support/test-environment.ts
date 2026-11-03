/**
 * Boot-time configuration is required, not defaulted, so that a real deployment fails fast on a
 * missing variable. The suite therefore has to supply its own set before any module compiles.
 *
 * These values decide *where* integration tests connect, not *whether* they run: a test that needs
 * Postgres or Redis still connects for real and skips loudly when the service is unreachable, so
 * the suite stays green on a machine with no Docker.
 *
 * Applied from two places — the per-worker setup file and the once-per-run global setup, which is
 * a separate process and does not inherit what the workers do.
 */
const defaults: Readonly<Record<string, string>> = {
  DATABASE_MIGRATION_URL: 'postgres://forge_migrator:forge_migrator@localhost:5432/forge',
  DATABASE_URL: 'postgres://forge_app:forge_app@localhost:5432/forge',
  DATABASE_URL_BYPASS_RLS: 'postgres://forge_bypass:forge_bypass@localhost:5432/forge',
  DEPLOY_ENV: 'local',
  GITHUB_WEBHOOK_SECRET: 'local-example-webhook-secret',
  KEK_ENV_MASTER_KEY: Buffer.alloc(32).toString('base64'),
  KEK_PROVIDER: 'env',
  NODE_ENV: 'test',
  RUN_PROFILES: 'api',
  SANDBOX_OWNER: 'forge-test',
  OUTBOX_RELAY_TICK_MS: '50',
  REDIS_CACHE_URL: 'redis://localhost:6380',
  REDIS_QUEUE_URL: 'redis://localhost:6381',
  REDIS_SESSION_URL: 'redis://localhost:6379',
  REDIS_STREAM_URL: 'redis://localhost:6382',
  SWAGGER_ENABLED: 'false',
};

/** Every assignment is conditional so CI, which provides its own service containers, wins. */
export function applyTestEnvironmentDefaults(): void {
  for (const [key, value] of Object.entries(defaults)) {
    process.env[key] ??= value;
  }
}

export function testDatabaseUrls(): string[] {
  applyTestEnvironmentDefaults();

  return [process.env.DATABASE_URL!, process.env.DATABASE_URL_BYPASS_RLS!];
}

export function testRedisUrls(): string[] {
  applyTestEnvironmentDefaults();

  return [
    process.env.REDIS_SESSION_URL!,
    process.env.REDIS_CACHE_URL!,
    process.env.REDIS_QUEUE_URL!,
    process.env.REDIS_STREAM_URL!,
  ];
}
