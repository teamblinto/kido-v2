import type { OnApplicationShutdown } from '@nestjs/common';
import { Global, Inject, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { schema } from '@repo/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import type { Environment } from '../config/environment';
import { ResourceOrgResolver } from '../modules/rbac/resource-org.resolver';
import {
  APP_DATABASE,
  APP_POOL,
  BYPASS_DATABASE,
  BYPASS_POOL,
  TENANT_SCOPE_RESOLVER,
} from './database.constants';
import type { ForgeDatabase } from './database.types';
import { TenantContext } from './tenant-context';
import { TenantContextInterceptor } from './tenant-context.interceptor';
import { TenantTransactionRunner } from './tenant-transaction';

const { Pool } = pg;

function pool(connectionString: string, max: number): pg.Pool {
  return new Pool({ connectionString, max });
}

/**
 * Two pools, two roles, one tenant transaction per request.
 *
 * §09 separates the roles rather than the credentials: `forge_app` is not the table owner and holds
 * no `BYPASSRLS`, so every policy applies to it; `forge_bypass` holds `BYPASSRLS` for the
 * cross-tenant work §09 permits and lives on its own, much smaller, pool. They are two pools rather
 * than one because the point of the separation is that a request-path query cannot accidentally be
 * issued on the connection that sees everything.
 *
 * Both pools are small on purpose. §09: "application pools are small and PgBouncer does the
 * multiplexing, because a NestJS fleet with generous per-process pools will exhaust max_connections
 * long before it exhausts CPU."
 *
 * `@Global` because `TenantContext` and `TenantTransactionRunner` are imported by every service
 * written after this one; making twenty modules restate the same import buys nothing.
 */
@Global()
@Module({
  exports: [
    APP_DATABASE,
    APP_POOL,
    BYPASS_DATABASE,
    BYPASS_POOL,
    TENANT_SCOPE_RESOLVER,
    TenantContext,
    TenantTransactionRunner,
  ],
  providers: [
    {
      inject: [ConfigService],
      provide: APP_POOL,
      useFactory: (config: ConfigService<Environment, true>) =>
        pool(
          config.get('DATABASE_URL', { infer: true }),
          config.get('DATABASE_POOL_MAX', { infer: true }),
        ),
    },
    {
      inject: [ConfigService],
      provide: BYPASS_POOL,
      useFactory: (config: ConfigService<Environment, true>) =>
        pool(
          config.get('DATABASE_URL_BYPASS_RLS', { infer: true }),
          config.get('DATABASE_BYPASS_POOL_MAX', { infer: true }),
        ),
    },
    {
      inject: [APP_POOL],
      provide: APP_DATABASE,
      useFactory: (appPool: pg.Pool): ForgeDatabase => drizzle(appPool, { schema }),
    },
    {
      inject: [BYPASS_POOL],
      provide: BYPASS_DATABASE,
      useFactory: (bypassPool: pg.Pool): ForgeDatabase => drizzle(bypassPool, { schema }),
    },
    // T26 replaces the placeholder T06 shipped, exactly as `database.constants.ts` said it would:
    // the tenant is derived from the resource the route names, which is the only derivation §11
    // allows. `NoTenantScopeResolver` remains exported from `tenant-context.interceptor.ts` as the
    // documented shape of "answer no tenant" — and that answer is still what this resolver gives
    // every route which has registered no `@ResourceOrg()`.
    //
    // The import points from the infrastructure layer at a feature module, which is the one place
    // that direction is right: the interceptor is registered here, the derivation is policy, and
    // binding a *second* implementation instead would let the transaction's tenant drift from the
    // one the guard checked the permission in.
    { provide: TENANT_SCOPE_RESOLVER, useClass: ResourceOrgResolver },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
    TenantContext,
    TenantTransactionRunner,
  ],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(
    @Inject(APP_POOL) private readonly appPool: pg.Pool,
    @Inject(BYPASS_POOL) private readonly bypassPool: pg.Pool,
  ) {}

  /**
   * Closing both pools is what lets a rolling deploy drain instead of dropping in-flight
   * transactions. `bootstrap.ts` already calls `enableShutdownHooks()`, so this runs on SIGTERM.
   */
  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.appPool.end(), this.bypassPool.end()]);
  }
}
