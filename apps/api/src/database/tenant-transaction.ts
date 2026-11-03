import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { APP_DATABASE } from './database.constants';
import type { ForgeDatabase, TenantScope, TenantTransaction } from './database.types';
import { type AfterCommitHook, TenantContext } from './tenant-context';

/**
 * The shape Postgres accepts for `uuid`. Deliberately not an RFC 4122 version check: the job here
 * is to reject what would raise 22P02 inside a policy predicate, not to have an opinion about which
 * uuid version an org id is.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidTenantIdError extends Error {
  constructor(orgId: string) {
    super(`Refusing to open a tenant transaction: ${JSON.stringify(orgId)} is not a uuid.`);
    this.name = 'InvalidTenantIdError';
  }
}

export class InvalidUserIdError extends Error {
  constructor(userId: string) {
    super(`Refusing to open a user transaction: ${JSON.stringify(userId)} is not a uuid.`);
    this.name = 'InvalidUserIdError';
  }
}

/**
 * The one way this application talks to a tenant's data.
 *
 * §09 mandates the shape exactly:
 *
 *     BEGIN;
 *       SELECT set_config('app.org_id', $1, true);   -- true = transaction-scoped
 *       …
 *     COMMIT;
 *
 * The third argument is the entire point. PgBouncer runs in transaction mode, so the connection is
 * handed to the next request the moment this transaction commits; a session-scoped setting would
 * still be in force when it got there, and one tenant would read another tenant's rows through the
 * policy that exists to stop exactly that. `no-plain-set.spec.ts` fails the build if any spelling of
 * the session-scoped form appears anywhere in the repository.
 *
 * `$1` rather than interpolation, for the ordinary reason, and because a bound parameter is also
 * what makes the id checkable before it is sent.
 */
@Injectable()
export class TenantTransactionRunner {
  constructor(
    @Inject(APP_DATABASE) private readonly db: ForgeDatabase,
    @Inject(TenantContext) private readonly context: TenantContext,
  ) {}

  /**
   * One tenant's whole unit of work: the transaction, the async context every service reads it
   * through, and the after-commit queue — drained once the commit has happened and never before.
   *
   * `TenantContextInterceptor` calls this for every request that resolves a tenant, and
   * `OrgService.create` calls it for the one operation that cannot go through the interceptor: the
   * organisation it needs a context for does not exist until the transaction is already open. Both
   * come here rather than composing the three pieces themselves, so the ordering that matters —
   * Postgres commits, *then* Redis — is written down in exactly one place.
   *
   * Hooks run sequentially, in registration order, and nothing catches them. A hook that throws
   * fails the caller even though the write committed, which is the honest outcome: a retry runs the
   * invalidation again, where a swallowed failure would leave a stale permission set behind. See
   * {@link TenantContext.onCommit}.
   *
   * A `fn` that throws rolls the transaction back and rethrows before this reaches the queue, so
   * nothing was committed and nothing is invalidated.
   */
  async runInTenantScope<T>(
    scope: TenantScope,
    fn: (tx: TenantTransaction) => Promise<T>,
  ): Promise<T> {
    const afterCommit: AfterCommitHook[] = [];

    const result = await this.runInTenantTransaction(scope.orgId, (tx) =>
      this.context.run({ afterCommit, orgId: scope.orgId, tx, userId: scope.userId }, () => fn(tx)),
    );

    for (const hook of afterCommit) {
      await hook();
    }

    return result;
  }

  /**
   * Opens a transaction, scopes it to `orgId`, and runs `fn` inside it.
   *
   * Everything `fn` does through `tx` is one transaction: it commits when `fn` resolves and rolls
   * back when it rejects, which is what lets an audit row live or die with the mutation it records.
   * Queries issued on anything other than `tx` are outside the tenant and will see nothing.
   */
  async runInTenantTransaction<T>(
    orgId: string,
    fn: (tx: TenantTransaction) => Promise<T>,
  ): Promise<T> {
    // Before the transaction rather than inside it: a malformed id would otherwise surface as a
    // type-cast error raised by an unrelated query's policy predicate, naming neither the caller
    // nor the id.
    if (!UUID.test(orgId)) {
      throw new InvalidTenantIdError(orgId);
    }

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);

      return fn(tx);
    });
  }

  /**
   * Opens a transaction scoped to a **person** rather than to an organisation, and runs `fn` in it.
   *
   * There is exactly one question this exists for: "which organisations does this user belong to?"
   * It is rooted at a user, spans every tenant they are a member of, and is therefore the one read
   * in the product that cannot derive an organisation from the resource it is touching — the
   * organisations *are* the result. `migrations/0007_memberships_self_read.sql` carries the
   * argument and the policy; ADR 023 carries the alternatives.
   *
   * What this scope can see is deliberately tiny. `app.user_id` is named by one clause of one
   * policy, on `memberships`, in its `USING` half only. So inside here:
   *
   * - `memberships` answers with the caller's own rows, in every organisation they belong to;
   * - **every other tenant-owned table answers with nothing**, because no other predicate mentions
   *   the setting — an export-shaped `select * from projects` is as empty as it is outside any
   *   transaction at all;
   * - nothing can be written outside a tenant, because `WITH CHECK` is untouched and still
   *   `org_id`-only.
   *
   * It publishes no {@link TenantContext}, and that is the point rather than an omission: there is
   * no `orgId` for one to hold, and a service reaching for `this.tenant.tx` in here would be a
   * service that thinks it knows a tenant it does not. The handle is passed to `fn` and nowhere
   * else.
   *
   * The setting is written with a third argument of `true`, for the reason the whole file exists:
   * transaction-scoped, so it is gone before the connection serves anybody else. It reverts to the
   * empty string rather than to non-existence, which is why the policy wraps it in `NULLIF` exactly
   * as 0004 does for the org.
   */
  async runInUserTransaction<T>(
    userId: string,
    fn: (tx: TenantTransaction) => Promise<T>,
  ): Promise<T> {
    // Before the transaction, for the reason above: a malformed id would otherwise surface as a
    // type-cast error raised by a policy predicate, naming neither the caller nor the id.
    if (!UUID.test(userId)) {
      throw new InvalidUserIdError(userId);
    }

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);

      return fn(tx);
    });
  }
}
