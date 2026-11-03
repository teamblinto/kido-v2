import { Inject, Injectable } from '@nestjs/common';
import type { OrgMember } from '@repo/contracts';
import { memberships, users } from '@repo/db';
import { and, asc, eq, isNotNull } from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { ConflictError, ForbiddenError, NotFoundError } from '../../../common/errors/domain-error';
import type { TenantTransaction } from '../../../database/database.types';
import { TenantContext } from '../../../database/tenant-context';
import { AuditService } from '../../audit/audit.service';
import { SessionService } from '../../identity/services/session.service';
import { PermissionCache } from '../../rbac/permission-cache';
import type { OrgRole } from '../../rbac/permissions';

/**
 * The `owner ⊇ admin ⊇ member` ladder, as a number, plus the one role that is not on it.
 *
 * `permissions.ts` states the shape: "`owner` ⊇ `admin` ⊇ `member` is a ladder; `billing` is not on
 * it." `billing` sits at the bottom here because this rank answers exactly one question — may this
 * actor confer or withdraw that role — and the answer for somebody holding only the billing role is
 * no, for every role including their own.
 */
const RANK = Object.freeze({
  admin: 2,
  billing: 1,
  member: 1,
  owner: 3,
} as const satisfies Readonly<Record<OrgRole, number>>);

/** Every way of refusing a role change says the same thing, and it is safe to say it plainly. */
const ABOVE_YOUR_OWN = 'You cannot confer or withdraw a role above your own.';

/**
 * Organisation membership (T27) — §11's outermost scope, and the one whose mutations have to reach
 * past Postgres.
 *
 * ## The two-part invalidation, and why neither part is optional
 *
 * §11 asks for both, and the task's framing is exact: "cache-only leaves the session valid,
 * session-only leaves a stale permission set for their next login."
 *
 * - **The permission cache** (T25) is deleted for the affected `(org, user)` on every change here.
 *   Without it, a demoted owner keeps changing org settings until the backstop TTL runs out, and a
 *   newly added member is refused everything until it does. §09 states the rule — explicit delete on
 *   write, never TTL alone — and this is where a membership change obeys it.
 * - **The sessions** are revoked wholesale on removal, which §11 names directly: the cookie is
 *   "revoked wholesale on password reset or member removal". Without it the removed collaborator
 *   still holds a live session; the cache is empty, so they are refused *this* organisation, but
 *   they remain signed in to the account and to anything else it can reach.
 *
 * Removal does both. Add and role change invalidate the cache and do **not** revoke, and that is a
 * deliberate reading rather than an omission. §11 says a session "rotates on authentication and on
 * privilege change" — rotation, not revocation — and rotation is something a session does to
 * itself: an administrator changing somebody else's role holds no cookie of theirs to rotate.
 * Nothing is lost by not revoking, because the cache invalidation is what makes the new role
 * effective, and it is effective on the target's very next request in either direction. Signing
 * somebody out for having been promoted would be a worse answer to the same question.
 *
 * ## Why it all happens after the commit
 *
 * Redis and Postgres do not share a transaction, so the two can only be ordered, and every
 * invalidation here is queued with {@link TenantContext.onCommit} rather than performed inline.
 * Invalidating first would leave a window in which a concurrent request resolves the set from the
 * rows that are about to change and writes it straight back — a stale entry that outlives its own
 * invalidation, which is the one failure mode the explicit delete exists to prevent.
 *
 * ## The service check §11 asks for
 *
 * "A `@RequirePermission()` guard on the route, an explicit check inside the service for anything
 * the guard cannot express." {@link changeRole} and {@link remove} are where that second layer
 * lives. The guard answers "may this caller change roles at all"; it cannot answer "but not to a
 * role above their own", because that depends on two rows it never loads. `permissions.ts` says so
 * beside `ORG_ROLE_PERMISSIONS` and names this class as the place.
 */
@Injectable()
export class MembershipService {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PermissionCache) private readonly cache: PermissionCache,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  /**
   * Everyone in the organisation, pending invitations included.
   *
   * A pending member is listed with a null `acceptedAt` rather than hidden, because the difference
   * is one an administrator acts on: an invited address holds no permissions at all until it
   * accepts (T24 resolves a pending membership exactly as it resolves a guest), so a list that
   * showed them as a member would show somebody who cannot do anything.
   */
  async list(orgId: string): Promise<OrgMember[]> {
    const rows = await this.tenant.tx
      .select({
        acceptedAt: memberships.acceptedAt,
        email: users.email,
        invitedAt: memberships.createdAt,
        role: memberships.role,
        userId: memberships.userId,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.orgId, orgId))
      .orderBy(asc(memberships.createdAt));

    return rows.map((row) => ({
      acceptedAt: row.acceptedAt?.toISOString() ?? null,
      email: row.email,
      invitedAt: row.invitedAt.toISOString(),
      role: row.role,
      userId: row.userId,
    }));
  }

  /**
   * Who a custom-domain notice goes to (spec 028 research R14): the organisation's accepted owners,
   * plus `alsoUserId` (the domain's `added_by`) while that user is still an accepted member, each
   * once, in no promised order.
   *
   * On the caller's handle rather than `tenant.tx`: the caller is the domain checker's settling
   * transaction in a worker, where no `TenantContext` is published. A pending owner holds no
   * permissions (T24) and is not told about a domain they cannot act on; a member who has left is
   * not told about an organisation they no longer belong to.
   */
  async noticeRecipients(
    tx: TenantTransaction,
    orgId: string,
    alsoUserId: string | null,
  ): Promise<string[]> {
    const rows = await tx
      .select({ role: memberships.role, userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.orgId, orgId), isNotNull(memberships.acceptedAt)))
      .orderBy(asc(memberships.createdAt));

    const recipients = new Set(rows.filter((row) => row.role === 'owner').map((row) => row.userId));

    if (alsoUserId !== null && rows.some((row) => row.userId === alsoUserId)) {
      recipients.add(alsoUserId);
    }

    return [...recipients];
  }

  /**
   * The address a notice for `userId` is sent to, or `undefined` once they are not an accepted
   * member. Read at send time (the `mail.domain` event carries the user id, never the address), so
   * a member who leaves between the transition and the send is not mailed.
   */
  async noticeAddress(
    tx: TenantTransaction,
    orgId: string,
    userId: string,
  ): Promise<string | undefined> {
    const [row] = await tx
      .select({ email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.orgId, orgId),
          eq(memberships.userId, userId),
          isNotNull(memberships.acceptedAt),
        ),
      )
      .limit(1);

    return row?.email;
  }

  /**
   * Add a member, already accepted.
   *
   * Two callers: `OrgService.create`, which makes the creator the owner, and — when T29 lands —
   * invitation acceptance. There is deliberately no endpoint: adding somebody to an organisation
   * without their consent is what an invitation exists to avoid, and criterion 10 gives that flow
   * its own single-use token.
   *
   * The invalidation is not skippable even here. A set is cached per `(org, user)`, and a set for
   * somebody who is *not* a member is a perfectly cacheable empty one — anybody who probed a route
   * in this organisation before being added has one. Leaving it would refuse the new member
   * everything until the backstop TTL expired.
   */
  async add(entry: {
    invitedBy?: string | null;
    orgId: string;
    role: OrgRole;
    userId: string;
  }): Promise<void> {
    const { invitedBy = null, orgId, role, userId } = entry;

    await this.tenant.tx
      .insert(memberships)
      .values({ acceptedAt: this.clock.now(), invitedBy, orgId, role, userId });

    await this.audit.record(this.tenant.tx, {
      action: 'membership.created',
      actorId: invitedBy,
      metadata: { role },
      orgId,
      target: userId,
    });

    this.invalidateAfterCommit(orgId, userId);
  }

  /**
   * Change a member's organisation role.
   *
   * The explicit check: an actor may not confer a role above their own, and may not touch a member
   * who outranks them. Without the first, `org:members.role-change` — which `ORG_ROLE_PERMISSIONS`
   * gives to `admin` — would be a self-promotion to owner; without the second, an admin could demote
   * the owner who appointed them.
   */
  async changeRole(change: {
    actorId: string;
    orgId: string;
    role: OrgRole;
    userId: string;
  }): Promise<void> {
    const { actorId, orgId, role, userId } = change;
    const actor = await this.roleOf(orgId, actorId);
    const target = await this.require(orgId, userId);

    if (RANK[role] > RANK[actor] || RANK[target.role] > RANK[actor]) {
      throw new ForbiddenError(ABOVE_YOUR_OWN);
    }

    if (target.role === role) {
      return;
    }

    if (target.role === 'owner') {
      await this.refuseIfLastOwner(orgId, userId);
    }

    await this.tenant.tx
      .update(memberships)
      .set({ role, updatedAt: this.clock.now() })
      .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));

    await this.audit.record(this.tenant.tx, {
      action: 'membership.role-changed',
      actorId,
      metadata: { from: target.role, to: role },
      orgId,
      target: userId,
    });

    this.invalidateAfterCommit(orgId, userId);
  }

  /**
   * End a membership — the operation §11's wholesale revocation is written for.
   *
   * The row is deleted rather than stamped. `memberships` carries no `deleted_at` and
   * `schema/tenancy.ts` says why: "removing a member must revoke access instantly (§11), and a
   * soft-deleted membership is a row that one forgotten `WHERE deleted_at IS NULL` turns back into
   * access."
   *
   * Project grants are left alone, deliberately. A grant is the guest relationship, and somebody who
   * stops being a member of the organisation but keeps an explicit grant on one project becomes
   * exactly what §11 calls a guest — "an external collaborator with access to named projects only".
   * Deleting their grants would make removal from an organisation silently destroy a separate,
   * separately-audited decision. Revoking that access is `project-grant.revoked` (T30) and is its
   * own act.
   */
  async remove(removal: { actorId: string; orgId: string; userId: string }): Promise<void> {
    const { actorId, orgId, userId } = removal;
    const actor = await this.roleOf(orgId, actorId);
    const target = await this.require(orgId, userId);

    if (RANK[target.role] > RANK[actor]) {
      throw new ForbiddenError(ABOVE_YOUR_OWN);
    }

    if (target.role === 'owner') {
      await this.refuseIfLastOwner(orgId, userId);
    }

    await this.tenant.tx
      .delete(memberships)
      .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));

    await this.audit.record(this.tenant.tx, {
      action: 'membership.removed',
      actorId,
      metadata: { role: target.role },
      orgId,
      target: userId,
    });

    this.invalidateAfterCommit(orgId, userId);

    // §11's "revoked wholesale on member removal". Every device, not the one that happens to be
    // making a request — the removed collaborator's laptop is precisely the session nobody is
    // holding a token for.
    this.tenant.onCommit(async () => {
      await this.sessions.revokeAll(userId);
    });
  }

  /** The caller's own role, or a refusal. Reached only from routes the guard already admitted. */
  private async roleOf(orgId: string, userId: string): Promise<OrgRole> {
    return (await this.require(orgId, userId)).role;
  }

  private async require(orgId: string, userId: string): Promise<{ role: OrgRole }> {
    const [row] = await this.tenant.tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
      .limit(1);

    if (row === undefined) {
      throw new NotFoundError('No such member of this organisation.');
    }

    return row;
  }

  /**
   * An organisation with no owner is one nobody can administer, bill or delete, and no route
   * recovers it. A `409` rather than a `403`: the caller is permitted to do this, and the state is
   * what refuses — which is also the difference a client can act on, by appointing another owner
   * first.
   */
  private async refuseIfLastOwner(orgId: string, userId: string): Promise<void> {
    const owners = await this.tenant.tx
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.orgId, orgId), eq(memberships.role, 'owner')));

    if (owners.length <= 1 && owners.some((owner) => owner.userId === userId)) {
      throw new ConflictError(
        'This is the organisation’s last owner. Appoint another owner first.',
      );
    }
  }

  /** Queued, never immediate — see the note on ordering in this class's documentation. */
  private invalidateAfterCommit(orgId: string, userId: string): void {
    this.tenant.onCommit(async () => {
      await this.cache.invalidate(orgId, userId);
    });
  }
}
