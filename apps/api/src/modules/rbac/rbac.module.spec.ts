import type { ModuleMetadata } from '@nestjs/common';
import { Injectable, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { AppModule } from '../../app.module';
import { RedisModule } from '../../common/redis/redis.module';
import { validateEnvironment } from '../../config/environment';
import { DatabaseModule } from '../../database/database.module';
import { IdentityModule } from '../identity/identity.module';
import { RequirePermissionGuard } from './guards/require-permission.guard';
import { PermissionCache } from './permission-cache';
import { RbacModule } from './rbac.module';

@Injectable()
class NeedsPermissions {
  constructor(readonly cache: PermissionCache) {}
}

@Module({ imports: [RbacModule], providers: [NeedsPermissions] })
class ConsumerModule {}

describe('RbacModule', () => {
  let moduleRef: TestingModule | undefined;

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
  });

  async function compile(...extra: NonNullable<ModuleMetadata['imports']>): Promise<TestingModule> {
    return Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          isGlobal: true,
          validate: validateEnvironment,
        }),
        RedisModule,
        // Global, and needed since T26: `PermissionResolutionService` opens its own read-only
        // tenant transaction on a cache miss, so the runner has to be bound for this module to
        // build at all. A `pg` pool connects lazily, so nothing here needs Postgres running.
        DatabaseModule,
        ...extra,
      ],
    }).compile();
  }

  it('provides the permission cache', async () => {
    moduleRef = await compile(RbacModule);

    expect(moduleRef.get(PermissionCache)).toBeInstanceOf(PermissionCache);
  });

  it('exports it, so a consumer that imports the module can inject it', async () => {
    moduleRef = await compile(ConsumerModule);

    expect(moduleRef.get(NeedsPermissions, { strict: false }).cache).toBeInstanceOf(
      PermissionCache,
    );
  });

  /**
   * The cache is not optional and has no fallback: without the Redis role bound, the container has
   * an unresolvable dependency and refuses to build, which is the failure worth having.
   */
  it('refuses to build without the Redis roles bound', async () => {
    await expect(Test.createTestingModule({ imports: [RbacModule] }).compile()).rejects.toThrow();
  });

  it('registers RequirePermissionGuard as an APP_GUARD', () => {
    // Read off the module metadata rather than resolved from the container, for the reason
    // `identity.module.spec.ts` gives: Nest rewrites an `APP_GUARD` entry onto a generated token
    // when it builds the application, so `get(APP_GUARD)` answers nothing even when the
    // registration is there. The declaration is the invariant.
    const providers = Reflect.getMetadata('providers', RbacModule) as unknown[];

    expect(providers).toContainEqual({ provide: APP_GUARD, useClass: RequirePermissionGuard });
  });

  /**
   * `RequirePermissionGuard` reads the principal `SessionGuard` resolves, and Nest runs `APP_GUARD`s
   * in the order the modules declaring them are resolved. `IdentityModule` therefore has to be
   * imported before `RbacModule`.
   *
   * Getting this backwards fails closed — the permission guard refuses a request with no principal
   * rather than admitting it — so the symptom would be every guarded route answering 403
   * unconditionally, with nothing in any unit test to say why. Asserted rather than commented, for
   * the same reason the identity module asserts its own pair.
   */
  it('is imported after IdentityModule, whose guard resolves the principal it reads', () => {
    const imports = Reflect.getMetadata('imports', AppModule) as unknown[];

    expect(imports).toContain(RbacModule);
    expect(imports.indexOf(IdentityModule)).toBeLessThan(imports.indexOf(RbacModule));
  });
});
