import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { versionResponseSchema, VERSION_LOCAL_PLACEHOLDER } from '@repo/contracts';

import type { ConfigService } from '@nestjs/config';

import type { Environment } from '../../config/environment';
import { validateEnvironment } from '../../config/environment';
import { IS_PUBLIC } from '../identity/decorators/public.decorator';
import { VersionController } from './version.controller';

/** The values a deployed image bakes in, and the ones `local` fills for itself. */
const BAKED = {
  BUILD_AT: '2026-09-22T11:04:19.000Z',
  BUILD_COMMIT: '38c99c8f1ab4e0c6d2f5a7b9c1e3d5f7a9b1c3d5',
  BUILD_DIGEST: 'sha256:9c1f0ab2cd3ef45678901234567890abcdef1234567890abcdef1234567890ab',
};

function localEnvironment(overrides: Record<string, unknown> = {}): Environment {
  return validateEnvironment({
    DATABASE_MIGRATION_URL: 'postgres://forge_migrator:dev@localhost:5432/forge',
    DATABASE_URL: 'postgres://forge_app:dev@localhost:5432/forge',
    DATABASE_URL_BYPASS_RLS: 'postgres://forge_bypass:dev@localhost:5432/forge',
    DEPLOY_ENV: 'local',
    // Required since spec 026 put the inbound webhook's signing secret in the schema; the value is
    // the published local example, which the schema refuses outside a local deployment (R10).
    GITHUB_WEBHOOK_SECRET: 'local-example-webhook-secret',
    KEK_ENV_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    NODE_ENV: 'test',
    REDIS_CACHE_URL: 'redis://localhost:6380',
    REDIS_QUEUE_URL: 'redis://localhost:6381',
    REDIS_SESSION_URL: 'redis://localhost:6379',
    REDIS_STREAM_URL: 'redis://localhost:6382',
    RUN_PROFILES: 'api',
    ...overrides,
  });
}

/** The real schema's resolution, read the way `ConfigService` reads it. */
function configFor(environment: Environment): ConfigService<Environment, true> {
  return {
    get: (key: keyof Environment) => environment[key],
  } as unknown as ConfigService<Environment, true>;
}

describe('VersionController', () => {
  it('answers the three fields the contract declares and nothing else', () => {
    const controller = new VersionController(configFor(localEnvironment(BAKED)));
    const body = controller.read();

    expect(body).toStrictEqual({
      builtAt: BAKED.BUILD_AT,
      commit: BAKED.BUILD_COMMIT,
      digest: BAKED.BUILD_DIGEST,
    });
    expect(versionResponseSchema.parse(body)).toStrictEqual(body);
  });

  /**
   * The route has to answer before a session exists — the reader is an on-call engineer correlating
   * an incident to a deploy — and `SessionGuard` is an `APP_GUARD`, so this declaration is the only
   * thing that opens it (research R7).
   */
  it('declares itself public', () => {
    expect(new Reflector().get(IS_PUBLIC, VersionController)).toBe(true);
  });

  /**
   * A working tree has no digest, so `local` fills these itself. Without that the route would be a
   * deployment-only endpoint nobody ever exercises, and the compose probe could not run at all.
   */
  it('answers dev, dev and a boot time under DEPLOY_ENV=local', () => {
    const before = Date.now();
    const controller = new VersionController(configFor(localEnvironment()));
    const body = controller.read();

    expect(body.digest).toBe(VERSION_LOCAL_PLACEHOLDER);
    expect(body.commit).toBe(VERSION_LOCAL_PLACEHOLDER);
    expect(Date.parse(body.builtAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(versionResponseSchema.parse(body)).toStrictEqual(body);
  });

  it('reads the values once, so a deploy check is not fresh work per request', () => {
    const controller = new VersionController(configFor(localEnvironment(BAKED)));

    expect(controller.read()).toStrictEqual(controller.read());
  });
});
