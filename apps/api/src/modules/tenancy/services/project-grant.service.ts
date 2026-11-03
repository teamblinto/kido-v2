import { Inject, Injectable } from '@nestjs/common';
import { projectGrants } from '@repo/db';
import type { ProjectAccessConflictReason } from '@repo/contracts';
import { and, eq } from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { ConflictError, NotFoundError } from '../../../common/errors/domain-error';
import { TenantContext } from '../../../database/tenant-context';
import { AuditService } from '../../audit/audit.service';
import { OutboxWriter } from '../../outbox/outbox-writer';
import { PermissionCache } from '../../rbac/permission-cache';
import { PROJECT_ROLE_PERMISSIONS, type ProjectRole } from '../../rbac/permissions';
import { PresenceService } from '../presence/presence.service';

const LAST_OWNER: ProjectAccessConflictReason = 'last-owner';

/** Whether a role may start runs — losing it is what the run line hears about (R4). */
function canRun(role: ProjectRole): boolean {
  return (PROJECT_ROLE_PERMISSIONS[role] as readonly string[]).includes('project:agent.run');
}

/**
 * Project grants — the rows that make somebody a guest (T30).
 *
 * §11 defines the guest scope as "an external collaborator with access to named projects only and
 * no visibility into the organisation", and this is the table that names those projects. There is
 * no `guests` table and no `is_guest` column, deliberately: a guest is not a kind of user, it is
 * *the absence of a membership together with the presence of a grant*. T24's resolver is built that
 * way — "a guest is an absence, not a filter" — and it is what makes the property structural. Org
 * and workspace permissions are not narrowed for a guest; those scopes are simply never entered.
 *
 * One consequence worth stating: the same person can be a member of one organisation and a guest in
 * another, and nothing here has to know which. The permission set is resolved per `(user, org)`, so
 * "guest" is a fact about a pair rather than about an account.
 *
 * ## Granting is idempotent
 *
 * `project_grants` carries a unique key on `(org_id, project_id, user_id)`, so {@link grant} is an
 * upsert: re-granting the same role is a no-op and re-granting a different one changes it. That is
 * what makes the route a `PUT`. A grant that conflicted on the second call would make "make sure
 * this person can see this project" a thing a caller has to implement with a read first.
 *
 * ## What it invalidates, and what it does not
 *
 * Every change here deletes the guest's cached permission set for the organisation, after the
 * commit, for the reasons `MembershipService` sets out at length. §09: explicit delete on write.
 *
 * It does **not** revoke their sessions, and that is the difference between this and removing a
 * member. §11 revokes wholesale "on password reset or member removal"; a revoked project grant is
 * neither. The session belongs to the account, not to the organisation — a guest may be a full
 * member somewhere else entirely — so signing them out of everything because one project was
 * unshared would be a denial of service dressed up as a security measure. The cache invalidation
 * is what makes the revocation effective, and it is effective on their very next request.
 */
@Injectable()
export class ProjectGrantService {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PermissionCache) private readonly cache: PermissionCache,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(PresenceService) private readonly presence: PresenceService,
  ) {}

  /**
   * Give somebody a role on one project.
   *
   * The composite `(org_id, project_id)` foreign key does the tenant check for free: a grant naming
   * a project of another organisation has no parent row to reference and is refused by the database
   * (§09), rather than being written and then merely hidden by RLS.
   */
  async grant(entry: {
    actorId: string;
    orgId: string;
    projectId: string;
    role: ProjectRole;
    userId: string;
  }): Promise<void> {
    const { actorId, orgId, projectId, role, userId } = entry;

    const [existing] = await this.tenant.tx
      .select({ role: projectGrants.role })
      .from(projectGrants)
      .where(
        and(
          eq(projectGrants.orgId, orgId),
          eq(projectGrants.projectId, projectId),
          eq(projectGrants.userId, userId),
        ),
      )
      .limit(1);

    if (existing?.role === 'owner' && role !== 'owner') {
      await this.requireAnotherOwner(orgId, projectId, userId);
    }

    await this.tenant.tx
      .insert(projectGrants)
      .values({ orgId, projectId, role, userId })
      .onConflictDoUpdate({
        set: { role, updatedAt: this.clock.now() },
        target: [projectGrants.orgId, projectGrants.projectId, projectGrants.userId],
      });

    await this.audit.record(this.tenant.tx, {
      // Spec 031 (data-model § 5): a row that already existed was changed, not granted.
      action: existing === undefined ? 'project-grant.granted' : 'project-grant.role-changed',
      actorId,
      metadata:
        existing === undefined
          ? { projectId, role, userId }
          : { from: existing.role, projectId, role, userId },
      orgId,
      target: projectId,
    });

    if (existing !== undefined && canRun(existing.role) && !canRun(role)) {
      await this.accessRemoved(orgId, projectId, userId);
    }

    this.invalidateAfterCommit(orgId, userId);
  }

  /**
   * Withdraw a grant.
   *
   * The row is deleted rather than stamped — it grants access, and ADR 017 puts no `deleted_at` on
   * anything that does, because a soft-deleted grant is one forgotten `WHERE deleted_at IS NULL`
   * away from still being access.
   */
  async revoke(removal: {
    actorId: string;
    orgId: string;
    projectId: string;
    userId: string;
  }): Promise<void> {
    const { actorId, orgId, projectId, userId } = removal;

    await this.requireAnotherOwner(orgId, projectId, userId);

    const deleted = await this.tenant.tx
      .delete(projectGrants)
      .where(
        and(
          eq(projectGrants.orgId, orgId),
          eq(projectGrants.projectId, projectId),
          eq(projectGrants.userId, userId),
        ),
      )
      .returning({ role: projectGrants.role });

    const row = deleted[0];

    if (row === undefined) {
      throw new NotFoundError('No such grant on this project.');
    }

    await this.audit.record(this.tenant.tx, {
      action: 'project-grant.revoked',
      actorId,
      metadata: { projectId, role: row.role, userId },
      orgId,
      target: projectId,
    });

    await this.accessRemoved(orgId, projectId, userId);
    this.invalidateAfterCommit(orgId, userId);
  }

  /**
   * Spec 031 (data-model § 3): a project keeps at least one owner. Called before a revoke, and
   * before a change away from `owner`; a no-op when `userId` is not an owner at all.
   *
   * The project's owner grants are locked `for update` first, so two owners removing each other at
   * the same instant serialise: the second sees one owner left and is refused, rather than both
   * passing a count that each read before the other's delete.
   */
  private async requireAnotherOwner(
    orgId: string,
    projectId: string,
    userId: string,
  ): Promise<void> {
    const owners = await this.tenant.tx
      .select({ userId: projectGrants.userId })
      .from(projectGrants)
      .where(
        and(
          eq(projectGrants.orgId, orgId),
          eq(projectGrants.projectId, projectId),
          eq(projectGrants.role, 'owner'),
        ),
      )
      .for('update');

    const isOwner = owners.some((owner) => owner.userId === userId);

    if (isOwner && owners.length <= 1) {
      throw new ConflictError(
        'A project needs at least one owner. Make someone else an owner first.',
        { reason: LAST_OWNER },
      );
    }
  }

  /**
   * The person can no longer start runs here (R4): the run line cancels their waiting and running
   * runs off `project.access-removed`, appended on this transaction so it is published exactly when
   * the change commits. Their presence field goes after the commit — a rolled-back revoke must not
   * make somebody vanish from the room.
   */
  private async accessRemoved(orgId: string, projectId: string, userId: string): Promise<void> {
    await this.outbox.append(this.tenant.tx, {
      aggregateId: projectId,
      orgId,
      payload: { orgId, projectId, userId },
      type: 'project.access-removed',
    });

    this.tenant.onCommit(async () => {
      await this.presence.forget(orgId, projectId, userId);
    });
  }

  /** Queued, never immediate — the write commits first, then Redis. */
  private invalidateAfterCommit(orgId: string, userId: string): void {
    this.tenant.onCommit(async () => {
      await this.cache.invalidate(orgId, userId);
    });
  }
}
