import { randomUUID } from 'node:crypto';

import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { orgs, schema, workspaces } from '@repo/db';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { defer, firstValueFrom, from } from 'rxjs';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { openPool } from '../../test/support/integration-database';
import type { ForgeDatabase, TenantScope, TenantScopeResolver } from './database.types';
import { TenantContext } from './tenant-context';
import { OwnsTenantTransaction, TenantContextInterceptor } from './tenant-context.interceptor';
import { TenantTransactionRunner } from './tenant-transaction';

const APP_URL = process.env.DATABASE_URL ?? '';

const reachable = inject('postgresReachable');

/** One backend for every request in the file — see `tenant-transaction.spec.ts` for why. */
const appPool = reachable ? openPool(APP_URL, 1) : undefined;

/**
 * The interceptor forwards this to the resolver and reads the handler's metadata, so a marker with
 * a bare handler is the honest stand-in.
 */
const executionContext = {
  getHandler: () =>
    function handler(): undefined {
      return undefined;
    },
  marker: 'execution-context',
} as unknown as ExecutionContext;

function resolverReturning(scope: TenantScope | null): TenantScopeResolver {
  return { resolve: vi.fn().mockReturnValue(scope) };
}

/**
 * One context for the whole file, because `TenantTransactionRunner` now holds it: the runner is
 * what publishes the context and drains the after-commit queue, so a per-test instance would be a
 * context nothing ever populates.
 */
const context = new TenantContext();

/** A route handler, invoked on subscribe the way Nest invokes the real one. */
function handlerRunning<T>(body: () => Promise<T>): CallHandler<T> {
  return { handle: () => defer(() => from(body())) };
}

describe.skipIf(!reachable)('TenantContextInterceptor', () => {
  let db: ForgeDatabase;
  let runner: TenantTransactionRunner;
  let orgA = '';
  let orgB = '';

  beforeAll(async () => {
    db = drizzle(appPool!, { schema });
    runner = new TenantTransactionRunner(db, context);

    const suffix = randomUUID().slice(0, 8);

    const created = await db
      .insert(orgs)
      .values([
        { name: 'Interceptor A', slug: `t06-i-a-${suffix}` },
        { name: 'Interceptor B', slug: `t06-i-b-${suffix}` },
      ])
      .returning({ id: orgs.id });

    orgA = created[0]!.id;
    orgB = created[1]!.id;

    await runner.runInTenantTransaction(orgA, (tx) =>
      tx.insert(workspaces).values({ name: 'A workspace', orgId: orgA }),
    );
    await runner.runInTenantTransaction(orgB, (tx) =>
      tx.insert(workspaces).values({ name: 'B workspace', orgId: orgB }),
    );
  });

  afterAll(async () => {
    if (!reachable) {
      return;
    }

    await db.delete(orgs).where(inArray(orgs.id, [orgA, orgB]));
    await appPool!.end();
  });

  /** Spec 048: the upload reads its body before it opens a transaction of its own. */
  it('runs a handler that owns its transaction outside any tenant transaction', async () => {
    class Routes {
      @OwnsTenantTransaction()
      upload(): undefined {
        return undefined;
      }
    }
    const owning = {
      ...executionContext,
      getHandler: () =>
        Object.getOwnPropertyDescriptor(Routes.prototype, 'upload')!.value as () => void,
    } as unknown as ExecutionContext;
    const interceptor = new TenantContextInterceptor(
      runner,
      resolverReturning({ orgId: orgA, userId: null }),
    );

    const seen = await firstValueFrom(
      interceptor.intercept(
        owning,
        handlerRunning(() => Promise.resolve(context.get())),
      ),
    );

    expect(seen).toBeUndefined();
  });

  it('opens a tenant transaction and makes the org, user and handle readable in the handler', async () => {
    const interceptor = new TenantContextInterceptor(
      runner,
      resolverReturning({ orgId: orgA, userId: 'e2d1b3c4-0000-4000-8000-000000000001' }),
    );

    const seen = await firstValueFrom(
      interceptor.intercept(
        executionContext,
        handlerRunning(async () => ({
          orgId: context.orgId,
          rows: await context.tx.select({ name: workspaces.name }).from(workspaces),
          userId: context.userId,
        })),
      ),
    );

    expect(seen).toMatchObject({
      orgId: orgA,
      rows: [{ name: 'A workspace' }],
      userId: 'e2d1b3c4-0000-4000-8000-000000000001',
    });
  });

  /**
   * Until T15 resolves a session and T26 derives the org from the resource being touched, the
   * default resolver answers `null` for every request. A request with no tenant must run without a
   * transaction rather than guess at one: guessing is how an org id ends up coming from a header.
   */
  it('runs the handler untouched when no tenant can be resolved', async () => {
    const interceptor = new TenantContextInterceptor(runner, resolverReturning(null));

    const seen = await firstValueFrom(
      interceptor.intercept(
        executionContext,
        handlerRunning(() => Promise.resolve(context.get())),
      ),
    );

    expect(seen).toBeUndefined();
  });

  it('rolls the request transaction back when the handler fails', async () => {
    const interceptor = new TenantContextInterceptor(
      runner,
      resolverReturning({ orgId: orgA, userId: null }),
    );
    const name = `interceptor-rollback-${randomUUID().slice(0, 8)}`;

    await expect(
      firstValueFrom(
        interceptor.intercept(
          executionContext,
          handlerRunning(async () => {
            await context.tx.insert(workspaces).values({ name, orgId: orgA });

            throw new Error('the route handler failed');
          }),
        ),
      ),
    ).rejects.toThrow('the route handler failed');

    const survivors = await runner.runInTenantTransaction(orgA, (tx) =>
      tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.name, name)),
    );

    expect(survivors).toEqual([]);
  });

  it('closes the request transaction, leaving no context behind for the next request', async () => {
    const interceptor = new TenantContextInterceptor(
      runner,
      resolverReturning({ orgId: orgA, userId: null }),
    );

    await firstValueFrom(
      interceptor.intercept(
        executionContext,
        handlerRunning(() => Promise.resolve(context.orgId)),
      ),
    );

    expect(context.get()).toBeUndefined();
  });

  /**
   * The fourth architecture requirement, at the layer a reviewer would actually worry about: two
   * requests, one after the other, over a pool holding exactly one connection. In transaction-mode
   * pooling this is the arrangement in which a session-scoped `SET` from request one is still in
   * force for request two.
   */
  it('PROOF 4 · does not leak context across sequential requests on one pooled connection', async () => {
    // `intercept` is typed `Observable<unknown>`, the way Nest types a route's return value.
    const request = async (scope: TenantScope): Promise<{ rows: { orgId: string }[] }> => {
      const interceptor = new TenantContextInterceptor(runner, resolverReturning(scope));

      return (await firstValueFrom(
        interceptor.intercept(
          executionContext,
          handlerRunning(async () => ({
            orgId: context.orgId,
            rows: await context.tx.select({ orgId: workspaces.orgId }).from(workspaces),
          })),
        ),
      )) as { rows: { orgId: string }[] };
    };

    const first = await request({ orgId: orgA, userId: null });
    const second = await request({ orgId: orgB, userId: null });

    expect(first.rows.map((row) => row.orgId)).toEqual([orgA]);
    expect(second.rows.map((row) => row.orgId)).toEqual([orgB]);

    // And a third request that resolves no tenant sees nothing at all, rather than inheriting B.
    const third = await firstValueFrom(
      new TenantContextInterceptor(runner, resolverReturning(null)).intercept(
        executionContext,
        handlerRunning(() => db.select({ orgId: workspaces.orgId }).from(workspaces)),
      ),
    );

    expect(third).toEqual([]);
  });

  /**
   * The after-commit queue (T27), proved against a real transaction rather than a stand-in.
   *
   * The hook asks a *second*, independent connection whether the row is visible. Inside the
   * transaction it would not be — an uncommitted insert is invisible to every other session — so a
   * hook that ran too early would count zero. Seeing the row is what "after the commit" means, and
   * it is the property the permission cache and the session revocation both rest on: invalidating
   * before the commit leaves a window in which a concurrent read repopulates the entry from the
   * rows that are about to change.
   */
  it('runs after-commit hooks once the transaction has committed, not before', async () => {
    const name = `after-commit-${randomUUID().slice(0, 8)}`;
    let visibleToAnotherTransaction: number | undefined;

    const interceptor = new TenantContextInterceptor(
      runner,
      resolverReturning({ orgId: orgA, userId: null }),
    );

    await firstValueFrom(
      interceptor.intercept(
        executionContext,
        handlerRunning(async () => {
          await context.tx.insert(workspaces).values({ name, orgId: orgA });

          context.onCommit(async () => {
            visibleToAnotherTransaction = (
              await runner.runInTenantTransaction(orgA, (tx) =>
                tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.name, name)),
              )
            ).length;
          });

          return 'handled';
        }),
      ),
    );

    expect(visibleToAnotherTransaction).toBe(1);
  });

  /**
   * A handler that threw rolled its transaction back, so there is nothing to invalidate and no hook
   * to run. Running one anyway would be worse than wasteful: the same queue revokes a removed
   * member's sessions, and a rolled-back removal that still signed somebody out would be a
   * denial of service produced by a failed request.
   */
  it('runs no hook when the handler failed and the transaction rolled back', async () => {
    let ran = false;

    const interceptor = new TenantContextInterceptor(
      runner,
      resolverReturning({ orgId: orgA, userId: null }),
    );

    await expect(
      firstValueFrom(
        interceptor.intercept(
          executionContext,
          handlerRunning(async () => {
            context.onCommit(() => {
              ran = true;

              return Promise.resolve();
            });

            await Promise.resolve();

            throw new Error('the route handler failed');
          }),
        ),
      ),
    ).rejects.toThrow('the route handler failed');

    expect(ran).toBe(false);
  });
});
