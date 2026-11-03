import { Inject, Injectable } from '@nestjs/common';
import type { CreateOrgRequest, OrgMembership, OrgSummary } from '@repo/contracts';
import { memberships, orgs, projectGrants, projects, workspaces } from '@repo/db';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { ConflictError, NotFoundError } from '../../../common/errors/domain-error';
import type { TenantTransaction } from '../../../database/database.types';
import { TenantContext } from '../../../database/tenant-context';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { AuditService } from '../../audit/audit.service';
import { MembershipService } from './membership.service';
import { WorkspaceService } from './workspace.service';

/** Postgres's `unique_violation`. The slug is the only unique constraint this service can hit. */
const UNIQUE_VIOLATION = '23505';

/** The default workspace every new organisation gets, so a project has somewhere to be created. */
const FIRST_WORKSPACE = 'General';

/**
 * Organisations (T27), and the **only** path by which one comes into existence.
 *
 * ADR 007 is the reason this is here rather than in signup. It answered open question 1 as "no" —
 * `POST /auth/signup` creates one `users` row and nothing else — and said where the work went
 * instead: "Creating an organisation is an explicit, authenticated action, and it belongs to T27.
 * The `org-bootstrap.service.ts` that T13 was scoped to write is therefore **not written here**:
 * with no caller, it would be an untested service shaped by guesses about the flow that will
 * eventually use it. T27 writes it against its own requirements."
 *
 * So there is no second org-creation path to reuse and none to avoid duplicating. This is it.
 *
 * ## One transaction, and how it gets a tenant to run in
 *
 * T13's acceptance criteria described the shape this keeps: user, org, owner membership, default
 * workspace and an audit entry, in one transaction. Minus the user, which already exists by the
 * time anybody calls this.
 *
 * The awkward part is that every other tenant-scoped operation gets its transaction from
 * `TenantContextInterceptor`, which cannot help here: the interceptor derives the organisation from
 * the resource being touched (§11), and the resource being touched does not exist yet. `POST /orgs`
 * therefore carries no `@ResourceOrg()` and runs with no tenant — and this method opens the scope
 * itself, with an id it mints before the insert rather than one the database hands back. That is
 * what lets the membership, the workspace and the audit row all be written under `app.org_id` and
 * subject to the same policies as every other write in the system, in the same transaction as the
 * `orgs` row itself.
 *
 * `orgs` needs no tenant context of its own — it is a root table and carries no policy, because
 * `orgs.id` *is* the tenant identifier rather than a reference to one — but everything hanging off
 * it does.
 */
@Injectable()
export class OrgService {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(MembershipService) private readonly memberships: MembershipService,
    @Inject(WorkspaceService) private readonly workspaces: WorkspaceService,
  ) {}

  /**
   * Create an organisation with its creator as owner and one workspace to put projects in.
   *
   * The creator gets `owner` at the organisation and `admin` in the first workspace, and needs both:
   * §11's scopes compose and none of them cascades, so an org owner who was not also given a
   * workspace role would own an organisation whose only workspace they could not open. T24's
   * resolver is explicit that inventing that cascade "would grant access the document never
   * describes".
   */
  async create(actorId: string, request: CreateOrgRequest): Promise<OrgSummary> {
    const orgId = randomUUID();

    return this.transactions.runInTenantScope({ orgId, userId: actorId }, async (tx) => {
      const row = await insertOrg(tx, orgId, request);

      await this.memberships.add({ orgId, role: 'owner', userId: actorId });
      await this.workspaces.create({
        actorId,
        name: FIRST_WORKSPACE,
        orgId,
        ownerId: actorId,
      });

      await this.audit.record(tx, {
        action: 'org.created',
        actorId,
        metadata: { name: row.name, slug: row.slug },
        orgId,
        target: orgId,
      });

      return summarise(row);
    });
  }

  /**
   * The organisation the request is already scoped to.
   *
   * It takes no id: the tenant transaction was opened on the organisation the route named, so
   * asking for a *different* one here would be asking a question this transaction cannot answer —
   * every tenant-owned row it could reach belongs to `app.org_id` regardless.
   *
   * A soft-deleted organisation reads as absent. The restore window (ADR 012) is for an
   * administrator, not a place the tenant carries on working in — and `resolve()` already gives
   * every member of one an empty permission set, so this is the same answer twice.
   */
  async read(): Promise<OrgSummary> {
    const orgId = this.tenant.orgId;

    const [row] = await this.tenant.tx
      .select({
        createdAt: orgs.createdAt,
        deletedAt: orgs.deletedAt,
        id: orgs.id,
        name: orgs.name,
        plan: orgs.plan,
        slug: orgs.slug,
      })
      .from(orgs)
      .where(eq(orgs.id, orgId))
      .limit(1);

    // One answer for "no such row" and "soft-deleted", and `?.` collapses them honestly: an absent
    // row yields `undefined`, which is `!== null`, so both throw. Strict equality matters here —
    // `!=` would read a missing row as present and not deleted.
    if (row?.deletedAt !== null) {
      throw new NotFoundError('No such organisation.');
    }

    return summarise(row);
  }

  /**
   * Spec 032 R7: whether this organisation lets its members' personal subscriptions pay for runs
   * (`orgs.personal_accounts_allowed`, default on). Read inside the caller's tenant transaction so
   * the answer is the one the rest of that run's decision sees. A missing or soft-deleted
   * organisation is refused as {@link read} refuses it.
   */
  async personalAccountsAllowed(tx: TenantTransaction, orgId: string): Promise<boolean> {
    const [row] = await tx
      .select({ allowed: orgs.personalAccountsAllowed, deletedAt: orgs.deletedAt })
      .from(orgs)
      .where(eq(orgs.id, orgId))
      .limit(1);

    if (row?.deletedAt !== null) {
      throw new NotFoundError('No such organisation.');
    }

    return row.allowed;
  }

  /**
   * Spec 032 T051: an owner or admin allows or forbids members' personal subscriptions. Writes the
   * column and, only when the value changes, audits `org.personal-accounts-changed` `{ from, to }`
   * in the same transaction. Returns the value now in force.
   */
  async setPersonalAccountsAllowed(
    tx: TenantTransaction,
    orgId: string,
    actorId: string,
    allowed: boolean,
  ): Promise<boolean> {
    const from = await this.personalAccountsAllowed(tx, orgId);

    if (from === allowed) {
      return allowed;
    }

    await tx.update(orgs).set({ personalAccountsAllowed: allowed }).where(eq(orgs.id, orgId));
    await this.audit.record(tx, {
      action: 'org.personal-accounts-changed',
      actorId,
      metadata: { from, to: allowed },
      orgId,
      target: orgId,
    });

    return allowed;
  }

  /**
   * The organisations one person belongs to, with the role they hold in each.
   *
   * The only read in the application rooted at a user rather than at an organisation, and the
   * reason `runInUserTransaction` exists: there is no `:orgId` to derive a tenant from, because the
   * tenants *are* the answer. It runs with `app.user_id` set and `app.org_id` unset, so
   * `memberships` returns this caller's rows across every tenant and every other tenant-owned table
   * returns nothing — `migrations/0007_memberships_self_read.sql` carries the policy, ADR 023 the
   * alternatives that were rejected.
   *
   * ## The `where` clause is three separate decisions
   *
   * **`user_id`** is stated even though the policy already enforces it. The policy is the thing
   * that makes a mistake here a non-event rather than a breach (§09), which is a reason to have
   * both and not a reason to drop the predicate — a query whose correctness depends only on a
   * runtime setting is one refactor away from being issued somewhere that setting is not.
   *
   * **`accepted_at is not null`** excludes somebody who was invited and has not accepted. T24
   * resolves a pending membership exactly as it resolves a guest — the empty set — so listing one
   * would offer a client an organisation whose every route refuses it. The invitation is the thing
   * to act on, and it arrives by mail rather than through this list.
   *
   * **`orgs.deleted_at is null`** is the same call {@link read} makes: the restore window (ADR 012)
   * is for an administrator, not a place the tenant carries on working in.
   *
   * `innerJoin` from `memberships` rather than a filter applied afterwards, for the reason
   * `WorkspaceService` gives: a query that fetches everything and then removes rows is one refactor
   * away from being a query that forgets to. `orgs` is a root and carries no policy of its own, so
   * the membership row is the whole of the visibility rule.
   *
   * Spec 031 widens it (contracts/sharing.md § 6): an organisation reached only through project
   * grants is listed too, as `access: 'guest'` with a null role — see {@link guestOrgs}.
   */
  async listForUser(userId: string): Promise<OrgMembership[]> {
    return this.transactions.runInUserTransaction(userId, async (tx) => {
      const members = await tx
        .select({
          createdAt: orgs.createdAt,
          id: orgs.id,
          name: orgs.name,
          plan: orgs.plan,
          role: memberships.role,
          slug: orgs.slug,
        })
        .from(memberships)
        .innerJoin(orgs, eq(orgs.id, memberships.orgId))
        .where(
          and(
            eq(memberships.userId, userId),
            isNotNull(memberships.acceptedAt),
            isNull(orgs.deletedAt),
          ),
        )
        // Oldest first, so the list a client renders does not reorder itself between two requests.
        .orderBy(asc(orgs.createdAt), asc(orgs.id));

      const guestOf = await this.guestOrgs(tx, userId, new Set(members.map((row) => row.id)));

      return [
        ...members.map((row) => ({ ...summarise(row), access: 'member' as const, role: row.role })),
        ...guestOf.map((row) => ({ ...summarise(row), access: 'guest' as const, role: null })),
      ].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    });
  }

  /**
   * Spec 031 (research R6, ADR 023): the organisations a person reaches only through project
   * grants — a guest's. Without them a guest who accepted a project invitation would land on the
   * create-an-organisation screen with no way back to what was shared (FR-035).
   *
   * Two steps inside the same user transaction, because the two tables answer to different
   * policies. `project_grants` carries 0045's `app.user_id` clause, so the person's own grants are
   * readable with no tenant set. `projects` and `workspaces` do not, and must not: whether the
   * granted project is still live is asked per organisation with `app.org_id` set to it,
   * transaction-locally, and cleared afterwards. A grant on an archived project, or in an archived
   * workspace, lists nothing — the guest could open nothing there. An organisation the person is a
   * member of is listed as a member, once.
   */
  private async guestOrgs(
    tx: TenantTransaction,
    userId: string,
    memberOf: ReadonlySet<string>,
  ): Promise<{ createdAt: Date; id: string; name: string; plan: string; slug: string }[]> {
    const candidates = await tx
      .selectDistinct({
        createdAt: orgs.createdAt,
        id: orgs.id,
        name: orgs.name,
        plan: orgs.plan,
        slug: orgs.slug,
      })
      .from(projectGrants)
      .innerJoin(orgs, eq(orgs.id, projectGrants.orgId))
      .where(and(eq(projectGrants.userId, userId), isNull(orgs.deletedAt)));

    const live: typeof candidates = [];

    for (const org of candidates.filter((row) => !memberOf.has(row.id))) {
      await tx.execute(sql`select set_config('app.org_id', ${org.id}, true)`);

      const [reachable] = await tx
        .select({ id: projects.id })
        .from(projectGrants)
        .innerJoin(
          projects,
          and(eq(projects.orgId, projectGrants.orgId), eq(projects.id, projectGrants.projectId)),
        )
        .innerJoin(
          workspaces,
          and(eq(workspaces.orgId, projects.orgId), eq(workspaces.id, projects.workspaceId)),
        )
        .where(
          and(
            eq(projectGrants.orgId, org.id),
            eq(projectGrants.userId, userId),
            isNull(projects.deletedAt),
            isNull(workspaces.deletedAt),
          ),
        )
        .limit(1);

      if (reachable !== undefined) {
        live.push(org);
      }
    }

    await tx.execute(sql`select set_config('app.org_id', '', true)`);

    return live;
  }
}

/**
 * The insert, with the one constraint a caller can collide with turned into a `409`.
 *
 * `orgs_slug_key` is global rather than per-tenant, which is what makes a slug usable in a URL and
 * what makes this collision reachable by anybody. Caught by SQLSTATE rather than by looking first:
 * a `SELECT` then `INSERT` is a race, and the database is already checking.
 */
async function insertOrg(
  tx: TenantTransaction,
  id: string,
  request: CreateOrgRequest,
): Promise<{ createdAt: Date; id: string; name: string; plan: string; slug: string }> {
  try {
    const [row] = await tx
      .insert(orgs)
      .values({ id, name: request.name, slug: request.slug })
      .returning({
        createdAt: orgs.createdAt,
        id: orgs.id,
        name: orgs.name,
        plan: orgs.plan,
        slug: orgs.slug,
      });

    return row!;
  } catch (cause) {
    if (isUniqueViolation(cause)) {
      throw new ConflictError('That organisation slug is already taken.');
    }

    throw cause;
  }
}

/**
 * Whether this is Postgres's `unique_violation`, wherever in the chain it is.
 *
 * Drizzle wraps a driver error in a `DrizzleQueryError` carrying the original as `cause`, so the
 * SQLSTATE is one level down rather than on the thrown object — and which level is an implementation
 * detail of a dependency rather than a promise. Walking the chain is what keeps this correct across
 * a Drizzle upgrade that adds or removes a wrapper, and the bounded depth stops a self-referential
 * `cause` from spinning.
 */
function isUniqueViolation(error: unknown): boolean {
  for (let cause = error, depth = 0; cause !== null && cause !== undefined && depth < 5; depth++) {
    if (typeof cause !== 'object') {
      return false;
    }

    if ((cause as { code?: unknown }).code === UNIQUE_VIOLATION) {
      return true;
    }

    cause = (cause as { cause?: unknown }).cause;
  }

  return false;
}

function summarise(row: {
  createdAt: Date;
  id: string;
  name: string;
  plan: string;
  slug: string;
}): OrgSummary {
  return {
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    name: row.name,
    plan: row.plan,
    slug: row.slug,
  };
}
