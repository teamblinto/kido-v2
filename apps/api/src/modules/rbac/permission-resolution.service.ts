import { Inject, Injectable } from '@nestjs/common';
import { memberships, orgs, projectGrants, projects, workspaceMembers, workspaces } from '@repo/db';
import { and, eq, getTableColumns, isNull } from 'drizzle-orm';

import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { PermissionCache } from './permission-cache';
import type { PermissionEntry } from './permissions';
import { resolve } from './resolver';

/**
 * The permission set for one `(user, org)`, from cache or from the database (T26).
 *
 * This is the seam between T24's pure {@link resolve} and T25's {@link PermissionCache}: the
 * resolver has no I/O and the cache has no schema, so something has to load the rows and hand them
 * over, and this is it. `RequirePermissionGuard` is the caller; T27's mutations are what invalidate
 * what it stores.
 *
 * ## Why it opens its own transaction
 *
 * Nest runs guards before interceptors, so the guard asks this question *before*
 * `TenantContextInterceptor` has opened the request's tenant transaction — there is no `tx` to
 * borrow. Rather than move authorisation behind the transaction boundary, which would mean the
 * handler's transaction had already begun before anybody decided the caller was allowed to reach
 * it, this opens a short read-only transaction of its own on the organisation the route names.
 *
 * The cost is bounded by the cache, which is the reason T25 exists and the reason its loader is a
 * callback: on a hit nothing here runs at all, and a hit is the common case for every request after
 * a caller's first. On a miss the request briefly holds two transactions in sequence — this one,
 * which commits before the guard returns, and then the handler's. They are sequential rather than
 * nested, so there is no lock held across the decision and nothing for the handler's transaction to
 * contend with.
 *
 * A permission that changes between the two is not a gap this design leaves open. §11 closes it
 * from the other end: a membership change invalidates this cache *and* revokes the member's
 * sessions wholesale (T27), so the next request from a removed collaborator has no session to
 * present, whichever transaction it would have run in.
 *
 * ## Why the whole set, rather than one answer
 *
 * The guard asks "may this caller do X"; this returns everything they may do. That is what §11
 * describes — "Permissions resolve to a flat set per (user, org), cached in Redis" — and it is what
 * makes the cache worth having: a per-permission cache would be a key per question asked and a
 * separate invalidation for each, where this is one key per `(user, org)` and one `HDEL`.
 */
@Injectable()
export class PermissionResolutionService {
  /**
   * Both tokens are named rather than left to `design:paramtypes`, for the reason
   * `permission-cache.ts` gives about its own constructor: the metadata the transpiler emits wraps
   * each class reference in a guard no test can take, which shows up as an uncovered branch in a
   * module whose point is that it has none.
   */
  constructor(
    @Inject(PermissionCache) private readonly cache: PermissionCache,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
  ) {}

  /**
   * The caller's permissions in this organisation. Empty for a stranger, for a soft-deleted tenant
   * and for an organisation that does not exist — all three are "you may do nothing here", and
   * telling them apart is the guard's job to *not* do.
   */
  async for(orgId: string, userId: string): Promise<ReadonlySet<PermissionEntry>> {
    return this.cache.readThrough(orgId, userId, () => this.load(orgId, userId));
  }

  /**
   * The rows T24's resolver is defined over, loaded in the tenant they belong to.
   *
   * All three queries filter on `org_id` and `user_id` even though the `tenant_isolation` policy
   * already constrains the first. That is not redundancy for its own sake: this set is cached under
   * `(org, user)` and nothing downstream re-checks which tenant a slug came from, so the filter is
   * stated where a reader can see it rather than left to a policy in a migration. `resolve` checks
   * both a third time, for the same reason.
   */
  private async load(orgId: string, userId: string): Promise<ReadonlySet<PermissionEntry>> {
    return this.transactions.runInTenantTransaction(orgId, async (tx) => {
      // `orgs` is a root table and carries no policy — its `id` *is* the tenant identifier rather
      // than a reference to one — so this read is the one that establishes the organisation exists
      // and is not soft-deleted. `resolve` refuses to answer without `deletedAt` for exactly this.
      const [org] = await tx
        .select({ deletedAt: orgs.deletedAt, id: orgs.id })
        .from(orgs)
        .where(eq(orgs.id, orgId))
        .limit(1);

      if (org === undefined) {
        return new Set<PermissionEntry>();
      }

      // Workspace roles and project grants survive an archive (ADR 012 keeps the rows), so each
      // load joins its container and drops the rows whose container is gone. Without the join a
      // grant on an archived project would still resolve to `project:read@{id}` and pass the guard
      // (spec 007 R5, SC-006).
      const [held, inWorkspaces, granted] = await Promise.all([
        tx
          .select()
          .from(memberships)
          .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId))),
        tx
          .select(getTableColumns(workspaceMembers))
          .from(workspaceMembers)
          .innerJoin(
            workspaces,
            and(
              eq(workspaces.orgId, workspaceMembers.orgId),
              eq(workspaces.id, workspaceMembers.workspaceId),
              isNull(workspaces.deletedAt),
            ),
          )
          .where(and(eq(workspaceMembers.orgId, orgId), eq(workspaceMembers.userId, userId))),
        tx
          .select(getTableColumns(projectGrants))
          .from(projectGrants)
          .innerJoin(
            projects,
            and(
              eq(projects.orgId, projectGrants.orgId),
              eq(projects.id, projectGrants.projectId),
              isNull(projects.deletedAt),
            ),
          )
          .where(and(eq(projectGrants.orgId, orgId), eq(projectGrants.userId, userId))),
      ]);

      return resolve({ id: userId }, org, held, inWorkspaces, granted);
    });
  }
}
