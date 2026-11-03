import { Inject, Injectable } from '@nestjs/common';
import type { WorkspaceSummary } from '@repo/contracts';
import { projectGrants, projects, workspaceMembers, workspaces } from '@repo/db';
import type { SQL } from 'drizzle-orm';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { NotFoundError } from '../../../common/errors/domain-error';
import { TenantContext } from '../../../database/tenant-context';
import { AuditService } from '../../audit/audit.service';
import { OutboxWriter } from '../../outbox/outbox-writer';
import { PermissionCache } from '../../rbac/permission-cache';
import type { WorkspaceRole } from '../../rbac/permissions';

/**
 * Workspaces (T27) — §11's middle scope.
 *
 * Reads, plus the writes `workspace.controller.ts` exposes since spec 007: `create` (also called
 * by {@link OrgService.create} for the default workspace), `rename` and `archive`.
 *
 * ## Listing excludes rather than refuses
 *
 * {@link list} returns the workspaces the caller holds a role in and says nothing about the rest.
 * The alternative — list them all and 403 per item — would tell a viewer of one workspace exactly
 * how many others exist, which is a headcount of the organisation's work handed to somebody who was
 * given access to one corner of it. T30 makes the same argument for projects and a guest; it is the
 * same leak and the same answer.
 *
 * That is also why the join is an inner join on `workspace_members` rather than a filter applied
 * afterwards: a query that fetched everything and then removed rows is one refactor away from
 * being a query that forgets to.
 */
@Injectable()
export class WorkspaceService {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PermissionCache) private readonly cache: PermissionCache,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  /**
   * A workspace, and the caller's role in it.
   *
   * `NotFoundError` rather than a refusal when the caller holds no role, because reaching here at
   * all means `RequirePermissionGuard` already admitted them for *some* workspace in this
   * organisation. A `403` at this point would confirm that the id names a real workspace, which is
   * the enumeration the guard's own denial is shaped to withhold.
   */
  async read(orgId: string, workspaceId: string, userId: string): Promise<WorkspaceSummary> {
    const [row] = await this.visible(orgId, userId, eq(workspaces.id, workspaceId));

    if (row === undefined) {
      throw new NotFoundError('No such workspace.');
    }

    return summarise(row);
  }

  /** The workspaces the caller holds a role in, and no others. */
  async list(orgId: string, userId: string): Promise<WorkspaceSummary[]> {
    return (await this.visible(orgId, userId)).map(summarise);
  }

  /**
   * Create a workspace and give one user a role in it, in the caller's transaction.
   *
   * No endpoint, per the scope note above. The `role` is granted in the same statement run as the
   * workspace because a workspace nobody can see is not a useful thing to have created — and
   * because the permission cache invalidation below has to cover both.
   */
  async create(entry: {
    actorId: string | null;
    name: string;
    orgId: string;
    ownerId: string;
    role?: WorkspaceRole;
  }): Promise<WorkspaceSummary> {
    const { actorId, name, orgId, ownerId, role = 'admin' } = entry;

    const [workspace] = await this.tenant.tx
      .insert(workspaces)
      .values({ name, orgId })
      .returning({ createdAt: workspaces.createdAt, id: workspaces.id, name: workspaces.name });

    const created = workspace!;

    await this.tenant.tx
      .insert(workspaceMembers)
      .values({ orgId, role, userId: ownerId, workspaceId: created.id });

    await this.audit.record(this.tenant.tx, {
      action: 'workspace.created',
      actorId,
      metadata: { name, role, userId: ownerId },
      orgId,
      target: created.id,
    });

    // A workspace role is one of the three things `resolve()` reads, so granting one moves the
    // permission set exactly as a membership change does. §09: explicit delete on write.
    this.tenant.onCommit(async () => {
      await this.cache.invalidate(orgId, ownerId);
    });

    return {
      createdAt: created.createdAt.toISOString(),
      id: created.id,
      name: created.name,
      role,
    };
  }

  /**
   * Rename, recording `workspace.updated { from, to }`. The same name writes nothing (R10).
   */
  async rename(entry: {
    actorId: string;
    name: string;
    orgId: string;
    workspaceId: string;
  }): Promise<void> {
    const { actorId, name, orgId, workspaceId } = entry;
    const current = await this.live(orgId, workspaceId);

    if (current.name === name) {
      return;
    }

    await this.tenant.tx
      .update(workspaces)
      .set({ name, updatedAt: this.clock.now() })
      .where(eq(workspaces.id, workspaceId));

    await this.audit.record(this.tenant.tx, {
      action: 'workspace.updated',
      actorId,
      metadata: { from: current.name, to: name },
      orgId,
      target: workspaceId,
    });
  }

  /**
   * Archive the workspace and every live project in it, in one transaction (R6). Returns the ids
   * of the projects it archived.
   *
   * Projects go first: one `project.archived` event and one `project.deleted` audit row each, so a
   * consumer of the project stream sees the same thing whether a project was archived on its own
   * or with its workspace. Memberships and grants are kept (ADR 012); the resolver's join hides
   * them, and every affected person's cached set is dropped after commit — or the whole
   * organisation's when that is more than {@link ORG_INVALIDATION_THRESHOLD} people, since
   * `invalidateOrg` is one `UNLINK` and fifty round trips is not.
   */
  async archive(entry: { actorId: string; orgId: string; workspaceId: string }): Promise<string[]> {
    const { actorId, orgId, workspaceId } = entry;
    const now = this.clock.now();

    await this.live(orgId, workspaceId);

    const archived = await this.tenant.tx
      .update(projects)
      .set({ deletedAt: now })
      .where(
        and(
          eq(projects.orgId, orgId),
          eq(projects.workspaceId, workspaceId),
          isNull(projects.deletedAt),
        ),
      )
      .returning({ id: projects.id });
    const projectIds = archived.map((row) => row.id);

    const affected = new Set(
      (
        await this.tenant.tx
          .select({ userId: workspaceMembers.userId })
          .from(workspaceMembers)
          .where(eq(workspaceMembers.workspaceId, workspaceId))
      ).map((row) => row.userId),
    );

    if (projectIds.length > 0) {
      const holders = await this.tenant.tx
        .select({ userId: projectGrants.userId })
        .from(projectGrants)
        .where(inArray(projectGrants.projectId, projectIds));

      for (const { userId } of holders) {
        affected.add(userId);
      }
    }

    for (const projectId of projectIds) {
      await this.audit.record(this.tenant.tx, {
        action: 'project.deleted',
        actorId,
        metadata: { workspaceId },
        orgId,
        target: projectId,
      });

      await this.outbox.append(this.tenant.tx, {
        aggregateId: projectId,
        orgId,
        payload: { actorId, orgId, projectId, workspaceId },
        type: 'project.archived',
      });
    }

    await this.tenant.tx
      .update(workspaces)
      .set({ deletedAt: now })
      .where(eq(workspaces.id, workspaceId));

    await this.audit.record(this.tenant.tx, {
      action: 'workspace.deleted',
      actorId,
      metadata: { projectIds },
      orgId,
      target: workspaceId,
    });

    this.tenant.onCommit(async () => {
      if (affected.size > ORG_INVALIDATION_THRESHOLD) {
        await this.cache.invalidateOrg(orgId);

        return;
      }

      for (const userId of affected) {
        await this.cache.invalidate(orgId, userId);
      }
    });

    return projectIds;
  }

  /** The live row at `(orgId, workspaceId)`, or `NotFoundError` — archived and unknown are one answer. */
  private async live(orgId: string, workspaceId: string): Promise<{ name: string }> {
    const [row] = await this.tenant.tx
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.orgId, orgId),
          eq(workspaces.id, workspaceId),
          isNull(workspaces.deletedAt),
        ),
      );

    if (row === undefined) {
      throw new NotFoundError('No such workspace.');
    }

    return row;
  }

  /**
   * The one query both reads are built from: the workspaces of this organisation that this user
   * holds a role in, with that role.
   *
   * The visibility rule is the `innerJoin`, not a filter applied to the result, and the extra
   * predicate is folded into the single `where` rather than chained onto it — a second `.where()`
   * on a Drizzle builder replaces the first rather than narrowing it, which here would silently drop
   * the tenant and soft-delete conditions.
   */
  private async visible(
    orgId: string,
    userId: string,
    extra?: SQL,
  ): Promise<{ createdAt: Date; id: string; name: string; role: WorkspaceRole }[]> {
    return this.tenant.tx
      .select({
        createdAt: workspaces.createdAt,
        id: workspaces.id,
        name: workspaces.name,
        role: workspaceMembers.role,
      })
      .from(workspaces)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.orgId, workspaces.orgId),
          eq(workspaceMembers.workspaceId, workspaces.id),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .where(and(eq(workspaces.orgId, orgId), isNull(workspaces.deletedAt), extra))
      .orderBy(asc(workspaces.createdAt));
  }
}

/** Above this many affected people, one org-wide `UNLINK` beats a per-user loop (R5). */
const ORG_INVALIDATION_THRESHOLD = 50;

function summarise(row: {
  createdAt: Date;
  id: string;
  name: string;
  role: WorkspaceRole;
}): WorkspaceSummary {
  return {
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    name: row.name,
    role: row.role,
  };
}
