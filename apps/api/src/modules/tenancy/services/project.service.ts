import { Inject, Injectable } from '@nestjs/common';
import { type ProjectSummary, type ProjectTemplate, projectTemplateSchema } from '@repo/contracts';
import { projectGrants, projects, workspaces } from '@repo/db';
import type { SQL } from 'drizzle-orm';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { NotFoundError } from '../../../common/errors/domain-error';
import type { TenantTransaction } from '../../../database/database.types';
import { TenantContext } from '../../../database/tenant-context';
import { AuditService } from '../../audit/audit.service';
import { OutboxWriter } from '../../outbox/outbox-writer';
import { PermissionCache } from '../../rbac/permission-cache';
import { PermissionResolutionService } from '../../rbac/permission-resolution.service';
import { RESOURCE_DELIMITER } from '../../rbac/permissions';

/**
 * Projects (T27) — §11's innermost scope, and the surface T30's guest proof is written over.
 *
 * Reads, plus the writes `workspace-project.controller.ts` calls (spec 007): `create`, `rename`
 * and `archive`, each addressed by `(orgId, workspaceId, projectId)` so a project can only be
 * changed through the workspace it lives in.
 *
 * ## Visibility is the resolved permission set, not a second rule
 *
 * {@link list} asks {@link PermissionResolutionService} which projects the caller holds
 * `project:read` on and selects exactly those. It does not re-derive visibility from memberships,
 * workspace roles and grants — that derivation is T24's `resolve()`, it is cached, and a second
 * copy of it here is a second copy that disagrees with the first the day one of them is edited.
 *
 * That is also what makes the same listing correct for callers as different as a project's creator,
 * an editor somebody added, and an external guest — without a branch for any of them. All three
 * hold a `project_grants` row, the resolved set already encodes it, and "guest" is not a case this
 * code distinguishes: it is simply the caller whose set contains nothing else.
 *
 * Note what is *not* in it. A workspace role reaches no project: §11 gives the workspace scope
 * "create and archive projects, manage workspace connectors, invite into the workspace", and T24
 * declines to cascade beyond that. A workspace admin who was never given a role on a project does
 * not see it here, and that is the document's answer rather than an oversight.
 *
 * ## Excluding, not refusing
 *
 * A project the caller may not read is absent from the list rather than present-and-refused. T30
 * states the reason: "a per-item 403 tells the guest exactly how many projects they cannot see."
 * The count of an organisation's projects is itself information — how big is this company, how busy
 * — and §11 gives a guest "no visibility into the organisation" at all.
 */
@Injectable()
export class ProjectService {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PermissionResolutionService) private readonly permissions: PermissionResolutionService,
    @Inject(PermissionCache) private readonly cache: PermissionCache,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  /**
   * One project.
   *
   * `RequirePermissionGuard` has already established that the caller holds `project:read` for *this*
   * project id, so this cannot be the place the decision is made — but it is still a real query
   * under RLS, and a `NotFoundError` here means the id named nothing in this tenant.
   *
   * `userId` fills `permissions` with that caller's set for this project. It is optional because
   * several callers (`run.service.ts`, `sandbox.service.ts`) use this purely as an existence
   * check and have no use for the field — they should not pay for a resolver read to get it.
   */
  async read(orgId: string, projectId: string, userId?: string): Promise<ProjectSummary> {
    const [row] = await this.rows(orgId, eq(projects.id, projectId));

    if (row === undefined) {
      throw new NotFoundError('No such project.');
    }

    return summarise(
      row,
      userId === undefined ? [] : await this.projectPermissions(orgId, userId, projectId),
    );
  }

  /**
   * The projects the caller may read, and no trace of the others.
   *
   * An empty result is an empty list, not a `404`. "You can see no projects here" is a real answer,
   * and the caller already knows they asked.
   */
  async list(orgId: string, userId: string): Promise<ProjectSummary[]> {
    const readable = await this.readableProjectIds(orgId, userId);

    if (readable.length === 0) {
      return [];
    }

    return (await this.rows(orgId, inArray(projects.id, readable))).map((row) =>
      summarise(row, []),
    );
  }

  /**
   * Create a project in a workspace, in the caller's transaction.
   *
   * The workspace has to be live in this organisation. The guard has already checked the caller's
   * role in it, but a role survives an archive (R5 keeps the rows), so this is the check the guard
   * cannot express — and under RLS a workspace of another organisation is simply absent, which is
   * why both cases are one `NotFoundError`.
   *
   * ## The creator gets an explicit project role, because nothing cascades
   *
   * `ownerId` is granted `owner` on the new project, in a `project_grants` row, in this same
   * transaction. That is not a convenience: §11's three scopes compose and none of them cascades,
   * and T24's resolver is emphatic — "an org owner does not implicitly own every project … inventing
   * a cascade would grant access the document never describes … **T27 gives a creator explicit
   * workspace and project roles instead**". Without the row, the person who just created a project
   * would hold no `project:read` on it, could not deploy it, and — the case that surfaced this —
   * could not share it with anybody, because `project:share.external` is a project-scoped permission
   * and their org role does not carry one.
   *
   * `project_grants` is where every project role lives, guest or not. The table's own comment frames
   * it around the guest case because that is the one §11 names, but "guest" is not a column: it is
   * the state of holding a grant and no membership (T24). A member's project role is the same row.
   */
  async create(entry: {
    actorId: string;
    name: string;
    orgId: string;
    ownerId: string;
    template?: ProjectTemplate;
    workspaceId: string;
  }): Promise<ProjectSummary> {
    const { actorId, name, orgId, ownerId, template = 'vite-react', workspaceId } = entry;

    const [workspace] = await this.tenant.tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.orgId, orgId),
          eq(workspaces.id, workspaceId),
          isNull(workspaces.deletedAt),
        ),
      );

    if (workspace === undefined) {
      throw new NotFoundError('No such workspace.');
    }

    const [project] = await this.tenant.tx
      .insert(projects)
      .values({
        name,
        orgId,
        previewLabel: await this.freeLabel(this.tenant.tx),
        template,
        workspaceId,
      })
      .returning({ createdAt: projects.createdAt, id: projects.id, name: projects.name });

    const created = project!;

    await this.tenant.tx
      .insert(projectGrants)
      .values({ orgId, projectId: created.id, role: 'owner', userId: ownerId });

    await this.audit.record(this.tenant.tx, {
      action: 'project.created',
      actorId,
      metadata: { name, ownerId, template, workspaceId },
      orgId,
      target: created.id,
    });

    // Recorded as a grant as well as in the metadata above, because it *is* one: an auditor asking
    // "who can reach this project?" reads `project-grant.granted`, and a creator who never appeared
    // in that answer would be the one person with access that the trail did not explain.
    await this.audit.record(this.tenant.tx, {
      action: 'project-grant.granted',
      actorId,
      metadata: { projectId: created.id, role: 'owner', userId: ownerId },
      orgId,
      target: created.id,
    });

    // Ids and the template, never the name (§10). On the same handle as the row, so a rollback
    // takes the event with it (SC-004).
    await this.outbox.append(this.tenant.tx, {
      aggregateId: created.id,
      orgId,
      payload: { actorId, orgId, projectId: created.id, template, workspaceId },
      type: 'project.created',
    });

    this.tenant.onCommit(async () => {
      await this.cache.invalidate(orgId, ownerId);
    });

    return summarise(created, []);
  }

  /**
   * Rename, recording `project.updated { from, to }`. The same name writes nothing (R10): an audit
   * row saying a name changed to itself is noise, and `updated_at` should mean something moved.
   */
  async rename(entry: {
    actorId: string;
    name: string;
    orgId: string;
    projectId: string;
    workspaceId: string;
  }): Promise<void> {
    const { actorId, name, orgId, projectId, workspaceId } = entry;
    const current = await this.live(orgId, workspaceId, projectId);

    if (current.name === name) {
      return;
    }

    await this.tenant.tx
      .update(projects)
      .set({ name, updatedAt: this.clock.now() })
      .where(eq(projects.id, projectId));

    await this.audit.record(this.tenant.tx, {
      action: 'project.updated',
      actorId,
      metadata: { from: current.name, to: name },
      orgId,
      target: projectId,
    });
  }

  /**
   * Archive: `deleted_at` set, grants kept (ADR 012). The resolver's join hides the kept grants,
   * and each holder's cached set is dropped after commit so the archive is visible on their next
   * request rather than at the TTL (R5, SC-006). Holders are read before the update, on the row
   * that is still live.
   */
  async archive(entry: {
    actorId: string;
    orgId: string;
    projectId: string;
    workspaceId: string;
  }): Promise<void> {
    const { actorId, orgId, projectId, workspaceId } = entry;

    await this.live(orgId, workspaceId, projectId);

    const holders = await this.tenant.tx
      .select({ userId: projectGrants.userId })
      .from(projectGrants)
      .where(eq(projectGrants.projectId, projectId));

    await this.tenant.tx
      .update(projects)
      .set({ deletedAt: this.clock.now() })
      .where(eq(projects.id, projectId));

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

    this.tenant.onCommit(async () => {
      for (const { userId } of holders) {
        await this.cache.invalidate(orgId, userId);
      }
    });
  }

  /**
   * Rotate the preview label (spec 017, R8): a fresh draw from the same generator, written on the
   * caller's transaction handle so the audit row and outbox event the caller adds roll back with
   * it. Returns both values — the old one is what the outbox event names, so grants minted against
   * it can be revoked. Archived projects are refused: their label is dead already, and a rotation
   * would be a free label draw against a row nobody can reach.
   */
  async rotatePreviewLabel(
    ref: { readonly orgId: string; readonly projectId: string },
    tx: TenantTransaction,
  ): Promise<{ label: string; previousLabel: string }> {
    const [current] = await tx
      .select({ previewLabel: projects.previewLabel })
      .from(projects)
      .where(
        and(
          eq(projects.orgId, ref.orgId),
          eq(projects.id, ref.projectId),
          isNull(projects.deletedAt),
        ),
      );

    if (current === undefined) {
      throw new NotFoundError('No such project.');
    }

    const label = await this.freeLabel(tx);

    await tx
      .update(projects)
      .set({ previewLabel: label, updatedAt: this.clock.now() })
      .where(eq(projects.id, ref.projectId));

    return { label, previousLabel: current.previewLabel };
  }

  /**
   * What a deploy needs of the project (spec 027, data-model § Relations): the template whose
   * `build` it runs, the name and preview label a site label is drawn from, and whether it is
   * archived. Unlike {@link read}, an archived row is answered — flagged — so the deploy can refuse
   * it as `project-archived` rather than `not-found`. On the caller's handle, since the build worker
   * has no request context. A pre-template row reads as `vite-react`, as `sandbox-lifecycle` does.
   */
  async deployTarget(
    tx: TenantTransaction,
    ref: { readonly orgId: string; readonly projectId: string },
  ): Promise<{ archived: boolean; name: string; previewLabel: string; template: ProjectTemplate }> {
    const [row] = await tx
      .select({
        deletedAt: projects.deletedAt,
        name: projects.name,
        previewLabel: projects.previewLabel,
        template: projects.template,
      })
      .from(projects)
      .where(and(eq(projects.orgId, ref.orgId), eq(projects.id, ref.projectId)));

    if (row === undefined) {
      throw new NotFoundError('No such project.');
    }

    return {
      archived: row.deletedAt !== null,
      name: row.name,
      previewLabel: row.previewLabel,
      template: projectTemplateSchema.parse(row.template ?? 'vite-react'),
    };
  }

  /**
   * The live row at `(orgId, workspaceId, projectId)`, or `NotFoundError`. Archived, unknown and
   * "exists but in another workspace" are one answer: the guard has proved a role in the
   * workspace named by the path, and that proves nothing about a project that is not in it.
   */
  private async live(
    orgId: string,
    workspaceId: string,
    projectId: string,
  ): Promise<{ name: string }> {
    const [row] = await this.tenant.tx
      .select({ name: projects.name })
      .from(projects)
      .where(
        and(
          eq(projects.orgId, orgId),
          eq(projects.workspaceId, workspaceId),
          eq(projects.id, projectId),
          isNull(projects.deletedAt),
        ),
      );

    if (row === undefined) {
      throw new NotFoundError('No such project.');
    }

    return row;
  }

  /**
   * A preview label nobody holds (R4). Checked before the insert rather than caught on the unique
   * index, because a failed statement aborts the transaction the rest of `create` is in. A 128-bit
   * collision is not something this loop expects to see; the bound is there so a broken random
   * source fails loudly instead of spinning. The check runs under RLS, so it sees this tenant's
   * rows only — a cross-tenant collision still lands on the unique index, at odds of 2^-128.
   *
   * No `deleted_at` filter: `projects_preview_label_key` is unconditional and spans soft-deleted
   * rows, so an archived project's label is as taken as a live one's (R8). Shared by `create` and
   * `rotatePreviewLabel`, which is why it takes the handle rather than reading `tenant.tx`.
   */
  async freeLabel(tx: TenantTransaction): Promise<string> {
    for (let attempt = 0; attempt < LABEL_ATTEMPTS; attempt += 1) {
      const candidate = previewLabel();
      const [taken] = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.previewLabel, candidate));

      if (taken === undefined) {
        return candidate;
      }
    }

    throw new Error(`No free preview label after ${LABEL_ATTEMPTS} draws.`);
  }

  /**
   * The project ids the caller holds `project:read` on, read out of the resolved set.
   *
   * Entries are `project:read@{project_id}` (T24's `scoped()`), so this is a prefix match and a
   * split rather than a query. The set is the cached one, which is what keeps a listing off the
   * membership tables entirely on the common path.
   */
  private async readableProjectIds(orgId: string, userId: string): Promise<string[]> {
    const held = await this.permissions.for(orgId, userId);
    const prefix = `project:read${RESOURCE_DELIMITER}`;

    return [...held]
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => entry.slice(prefix.length));
  }

  /**
   * The caller's entries for *this* project, with the `@{project_id}` qualifier stripped —
   * `project:read`, `project:files.write`, … Read out of the same resolved set the guard used, so
   * the answer the client renders its controls from cannot disagree with the answer the routes
   * enforce.
   */
  private async projectPermissions(
    orgId: string,
    userId: string,
    projectId: string,
  ): Promise<string[]> {
    const held = await this.permissions.for(orgId, userId);
    const suffix = `${RESOURCE_DELIMITER}${projectId}`;

    return [...held]
      .filter((entry) => entry.endsWith(suffix))
      .map((entry) => entry.slice(0, -suffix.length))
      .sort();
  }

  private async rows(
    orgId: string,
    extra: SQL | undefined,
  ): Promise<{ createdAt: Date; id: string; name: string }[]> {
    return this.tenant.tx
      .select({
        createdAt: projects.createdAt,
        id: projects.id,
        name: projects.name,
      })
      .from(projects)
      .where(and(eq(projects.orgId, orgId), isNull(projects.deletedAt), extra))
      .orderBy(asc(projects.createdAt));
  }
}

const LABEL_ATTEMPTS = 3;

/**
 * The preview hostname label (Appendix A). Globally unique and indexed, because the route broker
 * resolves a preview host by it on every gateway cache miss.
 *
 * Random rather than derived from the project name: the label is served on a public hostname, so a
 * name-derived one would publish the project's name to anybody who could guess it, and renaming a
 * project would move a URL that is already in somebody's browser. 128 bits as hex (§07); rows
 * minted before spec 007 keep their 20-character labels.
 */
function previewLabel(): string {
  return randomBytes(16).toString('hex');
}

/**
 * No `workspaceId`, and the row does not even carry one — see `projectSummarySchema`. A workspace
 * id is organisation structure, and the guest listing (T30) is the same response as the member one.
 *
 * `permissions` is the caller's set for this one project. The list passes `[]`: a listing would
 * need one resolved set per row to fill it honestly, and nothing renders per-project controls from
 * a list row (spec 022 research R3).
 */
function summarise(
  row: { createdAt: Date; id: string; name: string },
  permissions: string[],
): ProjectSummary {
  return {
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    name: row.name,
    permissions,
  };
}
