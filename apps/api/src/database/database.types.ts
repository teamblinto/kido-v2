import type { ExecutionContext } from '@nestjs/common';
import type { Schema } from '@repo/db';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** A Drizzle instance over one of the two runtime pools, typed by the whole schema. */
export type ForgeDatabase = NodePgDatabase<Schema>;

/**
 * A handle inside an open transaction. Every tenant-scoped query in the codebase takes one of
 * these rather than a `ForgeDatabase`, because `app.org_id` is transaction-scoped: a query issued
 * on the outer instance is a query issued outside the tenant, and RLS answers it with zero rows.
 */
export type TenantTransaction = Parameters<Parameters<ForgeDatabase['transaction']>[0]>[0];

/** Who a request is for. `userId` is null for an authenticated-by-nothing caller inside a tenant. */
export interface TenantScope {
  readonly orgId: string;
  readonly userId: string | null;
}

/**
 * How the request pipeline decides which tenant a request belongs to.
 *
 * §11 is categorical that the org is derived from the resource being touched and never from a
 * header or a body field, so this deliberately receives the whole `ExecutionContext` rather than an
 * org id: an implementation that cannot identify the resource must answer `null` and let the
 * request run with no tenant, where it sees nothing.
 */
export interface TenantScopeResolver {
  resolve(context: ExecutionContext): Promise<TenantScope | null> | TenantScope | null;
}
