import { describe, expect, it } from 'vitest';

import type { TenantTransaction } from './database.types';
import { MissingTenantContextError, TenantContext } from './tenant-context';

/**
 * The context carries the transaction handle rather than pointing at one, so these stand in for it.
 * Nothing here touches the database: the property under test is that one request's tenant cannot be
 * observed from another's, which is a property of `AsyncLocalStorage`, not of Postgres.
 */
const txA = { label: 'tx-a' } as unknown as TenantTransaction;
const txB = { label: 'tx-b' } as unknown as TenantTransaction;

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

describe('TenantContext', () => {
  it('has no context outside a request', () => {
    const context = new TenantContext();

    expect(context.get()).toBeUndefined();
  });

  /**
   * The after-commit queue (T27).
   *
   * Cache invalidation and session revocation are not transactional — they are Redis — so they have
   * to happen *after* the write they follow has committed, never before. Invalidating first leaves a
   * window in which a concurrent read repopulates the entry from rows that are about to change, and
   * the stale set then survives until the backstop TTL, which is the failure §09's "explicit delete
   * on write" exists to prevent.
   */
  describe('the after-commit queue', () => {
    it('collects hooks in the order they were registered, and runs none of them itself', async () => {
      const context = new TenantContext();
      const ran: string[] = [];

      await context.run({ afterCommit: [], orgId: ORG_A, tx: txA, userId: USER_A }, () => {
        context.onCommit(() => {
          ran.push('first');

          return Promise.resolve();
        });
        context.onCommit(() => {
          ran.push('second');

          return Promise.resolve();
        });

        return Promise.resolve();
      });

      expect(ran).toEqual([]);
    });

    it('exposes them on the context so the interceptor can drain them after the commit', async () => {
      const context = new TenantContext();
      const value = { afterCommit: [], orgId: ORG_A, tx: txA, userId: USER_A };

      await context.run(value, () => {
        context.onCommit(() => Promise.resolve());

        return Promise.resolve();
      });

      expect(value.afterCommit).toHaveLength(1);
    });

    /**
     * A service that registers one outside a request has misunderstood where it is, and the hook
     * would simply never run — which for an invalidation means a permission set that is never
     * cleared. Throwing is what turns that into a test failure instead of a stale authorisation.
     */
    it('refuses a hook registered outside a tenant transaction', () => {
      expect(() => new TenantContext().onCommit(() => Promise.resolve())).toThrow(
        MissingTenantContextError,
      );
    });
  });

  /**
   * Failing closed matters more here than anywhere else in the codebase. A service that reads the
   * org id while no context is open must not receive `undefined` and go on to build a query with
   * it — the query would run outside a tenant transaction, where §09's policy returns zero rows and
   * the bug surfaces as "the data disappeared" a long way from its cause.
   */
  it('throws rather than answering with undefined when required outside a request', () => {
    const context = new TenantContext();

    expect(() => context.require()).toThrow(MissingTenantContextError);
    expect(() => context.orgId).toThrow(/outside a tenant transaction/i);
  });

  it('exposes the org, the user and the transaction inside a request', async () => {
    const context = new TenantContext();

    await context.run({ afterCommit: [], orgId: ORG_A, tx: txA, userId: USER_A }, () => {
      expect(context.orgId).toBe(ORG_A);
      expect(context.userId).toBe(USER_A);
      expect(context.tx).toBe(txA);

      return Promise.resolve();
    });
  });

  it('allows an unauthenticated caller inside a tenant, with a null user', async () => {
    const context = new TenantContext();

    await context.run({ afterCommit: [], orgId: ORG_A, tx: txA, userId: null }, () => {
      expect(context.userId).toBeNull();

      return Promise.resolve();
    });
  });

  it('returns the callback result and restores the outer context afterwards', async () => {
    const context = new TenantContext();

    const result = await context.run({ afterCommit: [], orgId: ORG_A, tx: txA, userId: null }, () =>
      Promise.resolve('done'),
    );

    expect(result).toBe('done');
    expect(context.get()).toBeUndefined();
  });

  it('restores the outer context even when the callback throws', async () => {
    const context = new TenantContext();

    await expect(
      context.run({ afterCommit: [], orgId: ORG_A, tx: txA, userId: null }, () =>
        Promise.reject(new Error('boom')),
      ),
    ).rejects.toThrow('boom');

    expect(context.get()).toBeUndefined();
  });

  /**
   * The leak this whole task exists to prevent, at the JavaScript layer. Two overlapping requests
   * share one process and one event loop; if the context were a field on a service rather than an
   * `AsyncLocalStorage`, the second `run` would overwrite the first and A would read B's org.
   */
  it('keeps two concurrent requests from seeing each other', async () => {
    const context = new TenantContext();
    const observed: string[] = [];

    const request = (orgId: string, tx: TenantTransaction, delayMs: number) =>
      context.run({ afterCommit: [], orgId, tx, userId: null }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        observed.push(`${orgId}:${(context.tx as unknown as { label: string }).label}`);
      });

    await Promise.all([request(ORG_A, txA, 20), request(ORG_B, txB, 0)]);

    expect(observed).toEqual([`${ORG_B}:tx-b`, `${ORG_A}:tx-a`]);
  });

  it('nests, so an inner tenant scope does not corrupt the outer one', async () => {
    const context = new TenantContext();

    await context.run({ afterCommit: [], orgId: ORG_A, tx: txA, userId: null }, async () => {
      await context.run({ afterCommit: [], orgId: ORG_B, tx: txB, userId: null }, () => {
        expect(context.orgId).toBe(ORG_B);

        return Promise.resolve();
      });

      expect(context.orgId).toBe(ORG_A);
    });
  });
});
