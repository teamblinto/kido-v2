import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable } from '@nestjs/common';

import type { TenantTransaction } from './database.types';

/**
 * Work that must happen once the request's transaction has committed, and not before — the Redis
 * half of a write. See {@link TenantContext.onCommit}.
 */
export type AfterCommitHook = () => Promise<void>;

/** What one request knows about its tenant, for as long as that request is running. */
export interface TenantContextValue {
  /**
   * The queue {@link TenantContext.onCommit} appends to and `TenantContextInterceptor` drains. A
   * mutable array behind a `readonly` field: the *context* is fixed for the life of the request,
   * the list of things to do after it is not.
   */
  readonly afterCommit: AfterCommitHook[];
  readonly orgId: string;
  readonly tx: TenantTransaction;
  readonly userId: string | null;
}

/**
 * Thrown when tenant state is read outside a tenant transaction.
 *
 * Answering `undefined` instead would be worse than useless: the caller would build a query with
 * it, run that query outside a transaction, and get zero rows back from a perfectly healthy
 * database. The bug would then surface as missing data somewhere else entirely.
 */
export class MissingTenantContextError extends Error {
  constructor(what: string) {
    super(
      `Read ${what} outside a tenant transaction. Tenant state only exists inside ` +
        'runInTenantTransaction(), because app.org_id is transaction-scoped (§09).',
    );
    this.name = 'MissingTenantContextError';
  }
}

/**
 * The tenant of the request currently running, held in an `AsyncLocalStorage`.
 *
 * It is storage rather than a field because one Node process serves many requests concurrently. A
 * field on a singleton service would be overwritten by whichever request touched it last, which is
 * the same class of bug as a session-scoped `SET` — one tenant's context observed by another — just
 * one layer up.
 *
 * It carries the transaction handle rather than pointing at one so that everything a request does
 * lands in a single transaction: the audit row is written with the mutation it records, and a
 * rollback takes both (T10).
 */
@Injectable()
export class TenantContext {
  private readonly storage = new AsyncLocalStorage<TenantContextValue>();

  /** The organisation this request is for. Throws outside a tenant transaction. */
  get orgId(): string {
    return this.require('the organisation id').orgId;
  }

  /** The open transaction every tenant-scoped query in this request must use. */
  get tx(): TenantTransaction {
    return this.require('the tenant transaction').tx;
  }

  /** The authenticated user, or null. Throws outside a tenant transaction. */
  get userId(): string | null {
    return this.require('the user id').userId;
  }

  /** The context, or `undefined` outside a tenant transaction. For code that can cope with both. */
  get(): TenantContextValue | undefined {
    return this.storage.getStore();
  }

  /**
   * Defer work until this request's transaction has committed (T27).
   *
   * Postgres and Redis do not share a transaction, so a write that has to touch both cannot make
   * them atomic — it can only choose an order. This method fixes that order as "database first,
   * Redis second", which is the only one that is safe.
   *
   * The other order is subtly broken. Invalidating a permission set *before* the membership change
   * commits leaves a window in which a concurrent request resolves the set from the rows that are
   * about to change and writes it straight back, so the entry survives the invalidation and is
   * stale until the backstop TTL — precisely the "stale set served after a role change" that §09's
   * *explicit delete on write* exists to rule out. Running afterwards has no such window: any read
   * that beats the hook has already read the new rows.
   *
   * Hooks run in registration order and nothing here catches their failures. That is deliberate and
   * is the asymmetry `permission-cache.ts` describes: the write has committed, so a failed hook
   * cannot roll it back, and the honest outcome is a failed response the caller retries — which
   * runs the invalidation again — rather than a success that quietly left a stale authorisation
   * behind.
   *
   * Throws outside a tenant transaction, because a hook registered where nothing will drain it is
   * an invalidation that silently never happens.
   */
  onCommit(hook: AfterCommitHook): void {
    this.require('the after-commit queue').afterCommit.push(hook);
  }

  /** The context, or a throw. For everything else. */
  require(what = 'tenant context'): TenantContextValue {
    const value = this.storage.getStore();

    if (value === undefined) {
      throw new MissingTenantContextError(what);
    }

    return value;
  }

  /** Runs `fn` with this tenant in scope. Nests, and unwinds on both success and failure. */
  run<T>(value: TenantContextValue, fn: () => Promise<T>): Promise<T> {
    return this.storage.run(value, fn);
  }
}
