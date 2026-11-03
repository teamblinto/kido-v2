import type { ExecutionContext } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterEach, describe, expect, inject, it } from 'vitest';

import { ResourceOrgResolver } from '../modules/rbac/resource-org.resolver';
import { validateEnvironment } from '../config/environment';
import {
  APP_DATABASE,
  APP_POOL,
  BYPASS_DATABASE,
  BYPASS_POOL,
  TENANT_SCOPE_RESOLVER,
} from './database.constants';
import { DatabaseModule } from './database.module';
import type { ForgeDatabase, TenantScopeResolver } from './database.types';
import { TenantContext } from './tenant-context';
import { TenantTransactionRunner } from './tenant-transaction';

const reachable = inject('postgresReachable');

/**
 * A `pg` pool connects lazily, so everything except the two role assertions holds with no Postgres
 * running. Only those two are behind the integration gate.
 */
async function compile(): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true, validate: validateEnvironment }),
      DatabaseModule,
    ],
  }).compile();
}

describe('DatabaseModule', () => {
  let moduleRef: TestingModule | undefined;

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
  });

  it('provides a Drizzle instance and a pool for each of the two runtime roles', async () => {
    moduleRef = await compile();

    expect(moduleRef.get<ForgeDatabase>(APP_DATABASE)).toBeDefined();
    expect(moduleRef.get<ForgeDatabase>(BYPASS_DATABASE)).toBeDefined();
    expect(moduleRef.get<ForgeDatabase>(APP_DATABASE)).not.toBe(
      moduleRef.get<ForgeDatabase>(BYPASS_DATABASE),
    );
    expect(moduleRef.get<pg.Pool>(APP_POOL)).not.toBe(moduleRef.get<pg.Pool>(BYPASS_POOL));
  });

  /**
   * §09 plans the connection budget explicitly: "application pools are small and PgBouncer does the
   * multiplexing, because a NestJS fleet with generous per-process pools will exhaust
   * max_connections long before it exhausts CPU." The bypass pool is smaller again — it serves
   * exports and rollups, not the request path.
   */
  it('sizes both pools from the environment, small, and the bypass pool smaller still', async () => {
    moduleRef = await compile();

    const appMax = moduleRef.get<pg.Pool>(APP_POOL).options.max;
    const bypassMax = moduleRef.get<pg.Pool>(BYPASS_POOL).options.max;

    expect(appMax).toBe(Number(process.env.DATABASE_POOL_MAX ?? 10));
    expect(bypassMax).toBe(Number(process.env.DATABASE_BYPASS_POOL_MAX ?? 2));
    expect(appMax).toBeLessThanOrEqual(10);
    expect(bypassMax).toBeLessThan(appMax);
  });

  it('provides the tenant context and the transaction runner', async () => {
    moduleRef = await compile();

    expect(moduleRef.get(TenantContext)).toBeInstanceOf(TenantContext);
    expect(moduleRef.get(TenantTransactionRunner)).toBeInstanceOf(TenantTransactionRunner);
  });

  /**
   * The org is derived from the resource being touched (§11), which `ResourceOrgResolver` (T26) is
   * how a route says. This module is where it is bound, replacing the placeholder T06 shipped.
   *
   * The behaviour asserted is unchanged from that placeholder's and is the one that matters:
   * failing closed means resolving no tenant, so a route that has not been taught to identify its
   * org runs without one and sees zero rows — not one that guesses from a header.
   * `resource-org.resolver.spec.ts` covers the resolver's own decisions; this is about the binding.
   */
  it('binds the resource-derived resolver, which answers no tenant for an unclaimed route', async () => {
    moduleRef = await compile();

    const resolver = moduleRef.get<TenantScopeResolver>(TENANT_SCOPE_RESOLVER);
    const unclaimed = {
      getClass: () => class Unclaimed {},
      getHandler: () =>
        function handler() {
          return 'unclaimed';
        },
      switchToHttp: () => ({ getRequest: () => ({ headers: { 'x-org-id': randomUUID() } }) }),
    } as unknown as ExecutionContext;

    // Synchronous, which `TenantScopeResolver` allows and this one is: deriving the tenant is a
    // metadata lookup and a path parameter, so the guard and the interceptor can both ask without
    // either paying for I/O.
    expect(resolver).toBeInstanceOf(ResourceOrgResolver);
    expect(await resolver.resolve(unclaimed)).toBeNull();
  });

  it('closes both pools on shutdown', async () => {
    const local = await compile();
    const appPool = local.get<pg.Pool>(APP_POOL);
    const bypassPool = local.get<pg.Pool>(BYPASS_POOL);

    expect(appPool.ended).toBe(false);

    await local.close();

    expect(appPool.ended, 'the app pool outlived the application').toBe(true);
    expect(bypassPool.ended, 'the bypass pool outlived the application').toBe(true);
  });

  it.skipIf(!reachable)('connects the two pools as the two roles §09 separates', async () => {
    moduleRef = await compile();

    const identify = async (pool: pg.Pool) =>
      (
        await pool.query<{ bypassesRls: boolean; role: string }>(
          `select current_user as "role",
                  (select rolbypassrls from pg_roles where rolname = current_user) as "bypassesRls"`,
        )
      ).rows[0];

    expect(await identify(moduleRef.get<pg.Pool>(APP_POOL))).toEqual({
      bypassesRls: false,
      role: 'forge_app',
    });
    expect(await identify(moduleRef.get<pg.Pool>(BYPASS_POOL))).toEqual({
      bypassesRls: true,
      role: 'forge_bypass',
    });
  });
});
