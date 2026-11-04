import { Injectable } from '@nestjs/common';
import { type NewRepoLink, type RepoLink, schema } from '@repo/db';
import { and, eq, getTableColumns, isNull, lt, notInArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type { TenantTransaction } from '../../database/database.types';

/** A `repo_links` row with what the contract derives: who linked it, and the last pushed sha. */
export interface RepoLinkRecord extends RepoLink {
  readonly lastPushedSha: string | null;
  readonly linkedByName: string;
}

/**
 * The `repo_links` rows (spec 018, data-model.md). One per project (`repo_links_org_id_project_id_key`);
 * every statement runs on the tenant transaction and names `org_id` itself.
 */
@Injectable()
export class RepoLinkRepository {
  private query(tx: TenantTransaction) {
    return tx
      .select({
        ...getTableColumns(schema.repoLinks),
        lastPushedSha: schema.checkpoints.gitSha,
        linkedByName: schema.users.email,
      })
      .from(schema.repoLinks)
      .innerJoin(schema.users, eq(schema.users.id, schema.repoLinks.linkedBy))
      .leftJoin(
        schema.checkpoints,
        and(
          eq(schema.checkpoints.orgId, schema.repoLinks.orgId),
          eq(schema.checkpoints.id, schema.repoLinks.lastPushedCheckpointId),
        ),
      );
  }

  async forProject(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
  ): Promise<RepoLinkRecord | undefined> {
    const [row] = await this.query(tx).where(
      and(eq(schema.repoLinks.orgId, orgId), eq(schema.repoLinks.projectId, projectId)),
    );

    return row;
  }

  /** Whether the project exists under this org, and whether it is archived (`deleted_at`, R7 drift). */
  async project(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
  ): Promise<{ archived: boolean; workspaceId: string } | undefined> {
    const [row] = await tx
      .select({
        archived: sql<boolean>`${schema.projects.deletedAt} is not null`,
        // Spec 026: an import that fails withdraws its project, and `ProjectService.archive`
        // addresses a project through the workspace it lives in.
        workspaceId: schema.projects.workspaceId,
      })
      .from(schema.projects)
      .where(and(eq(schema.projects.orgId, orgId), eq(schema.projects.id, projectId)));

    return row;
  }

  async insert(tx: TenantTransaction, draft: NewRepoLink): Promise<RepoLink> {
    const [row] = await tx.insert(schema.repoLinks).values(draft).returning();

    return row!;
  }

  /** The operations outlive the link with `link_id` null — the FK does it (migration 0024). */
  async delete(tx: TenantTransaction, orgId: string, id: string): Promise<void> {
    await tx
      .delete(schema.repoLinks)
      .where(and(eq(schema.repoLinks.orgId, orgId), eq(schema.repoLinks.id, id)));
  }

  /** After a push (or a pull, whose head is by definition pushed): the checkpoint and the remote head. */
  async setPushed(
    tx: TenantTransaction,
    orgId: string,
    id: string,
    checkpointId: string,
    remoteHeadSha: string,
  ): Promise<void> {
    await tx
      .update(schema.repoLinks)
      .set({ lastPushedCheckpointId: checkpointId, remoteHeadSha })
      .where(and(eq(schema.repoLinks.orgId, orgId), eq(schema.repoLinks.id, id)));
  }

  async setRemoteHead(
    tx: TenantTransaction,
    orgId: string,
    id: string,
    remoteHeadSha: string | null,
  ): Promise<void> {
    await tx
      .update(schema.repoLinks)
      .set({ remoteHeadSha })
      .where(and(eq(schema.repoLinks.orgId, orgId), eq(schema.repoLinks.id, id)));
  }

  async setAutoSync(
    tx: TenantTransaction,
    orgId: string,
    id: string,
    autoSync: boolean,
  ): Promise<void> {
    await tx
      .update(schema.repoLinks)
      .set({ autoSync })
      .where(and(eq(schema.repoLinks.orgId, orgId), eq(schema.repoLinks.id, id)));
  }

  /** Spec 044: pushes go to `branch` from now on; what waited on the side branch is no longer owed. */
  async setBranch(
    tx: TenantTransaction,
    orgId: string,
    id: string,
    move: { branch: string; lastPushedCheckpointId: string | null; remoteHeadSha: string },
  ): Promise<void> {
    await tx
      .update(schema.repoLinks)
      .set({ ...move, sideBranch: null })
      .where(and(eq(schema.repoLinks.orgId, orgId), eq(schema.repoLinks.id, id)));
  }

  /** The project's checkpoint at a sha, if any (`checkpoints_org_id_project_id_git_sha_key`: one). */
  async checkpointAt(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
    gitSha: string,
  ): Promise<string | undefined> {
    const [row] = await tx
      .select({ id: schema.checkpoints.id })
      .from(schema.checkpoints)
      .where(
        and(
          eq(schema.checkpoints.orgId, orgId),
          eq(schema.checkpoints.projectId, projectId),
          eq(schema.checkpoints.gitSha, gitSha),
        ),
      );

    return row?.id;
  }

  /** Spec 044: where the project's work waits; null once the linked branch has caught up. */
  async setSideBranch(
    tx: TenantTransaction,
    orgId: string,
    id: string,
    sideBranch: string | null,
  ): Promise<void> {
    await tx
      .update(schema.repoLinks)
      .set({ sideBranch })
      .where(and(eq(schema.repoLinks.orgId, orgId), eq(schema.repoLinks.id, id)));
  }

  /** Spec 044 decision 10: a rename or transfer, healed from what the numeric id resolved to. */
  async setRepository(
    tx: TenantTransaction,
    orgId: string,
    id: string,
    repository: { name: string; owner: string },
  ): Promise<void> {
    await tx
      .update(schema.repoLinks)
      .set({ name: repository.name, owner: repository.owner })
      .where(and(eq(schema.repoLinks.orgId, orgId), eq(schema.repoLinks.id, id)));
  }

  /** Spec 044: the links the reconcile tick looks after. */
  async autoSyncLinks(
    tx: TenantTransaction,
    orgId: string,
  ): Promise<{ id: string; projectId: string }[]> {
    return tx
      .select({ id: schema.repoLinks.id, projectId: schema.repoLinks.projectId })
      .from(schema.repoLinks)
      .where(
        and(
          eq(schema.repoLinks.orgId, orgId),
          eq(schema.repoLinks.autoSync, true),
          eq(schema.repoLinks.state, 'linked'),
        ),
      );
  }

  /**
   * The link a delivery names, addressed the way a webhook can address one: by the repository id
   * and the branch the provider sent, never by a project the delivery does not know (spec 026
   * contracts/webhook.md § 5 step 5). One row at most — `repo_links_org_id_project_id_key` allows
   * two projects of one organisation to name the same repository and branch, so the caller takes
   * every match rather than assuming one.
   */
  async forRepoBranch(
    tx: TenantTransaction,
    orgId: string,
    repoId: number,
    branch: string,
  ): Promise<{ id: string; projectId: string }[]> {
    return tx
      .select({ id: schema.repoLinks.id, projectId: schema.repoLinks.projectId })
      .from(schema.repoLinks)
      .where(
        and(
          eq(schema.repoLinks.orgId, orgId),
          eq(schema.repoLinks.repoId, repoId),
          eq(schema.repoLinks.branch, branch),
        ),
      );
  }

  /**
   * What a delivery writes, and the whole of it (FR-005, FR-038): one column of spec 018's link,
   * by `(org, repo_id, branch)`. No column is added and no state is set — a push at GitHub does not
   * change whether the project is linked, and `remote_head_sha` null is *unknown*, which is exactly
   * what a deleted branch (`after` all zeroes) leaves behind. Answers how many links moved, which
   * is what decides the delivery's terminal state.
   */
  /**
   * Spec 044: `sha` is a checkpoint older than the one this project last pushed: a delivery of its
   * own earlier push, deferred behind the next. A remote reset back to that checkpoint reads the
   * same; the next push is refused as a non-fast-forward, which restores the truth.
   */
  async isBehindPushed(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
    sha: string,
  ): Promise<boolean> {
    const pushed = alias(schema.checkpoints, 'pushed');
    const [row] = await tx
      .select({ id: schema.checkpoints.id })
      .from(schema.repoLinks)
      .innerJoin(
        pushed,
        and(
          eq(pushed.orgId, schema.repoLinks.orgId),
          eq(pushed.id, schema.repoLinks.lastPushedCheckpointId),
        ),
      )
      .innerJoin(
        schema.checkpoints,
        and(
          eq(schema.checkpoints.orgId, schema.repoLinks.orgId),
          eq(schema.checkpoints.projectId, schema.repoLinks.projectId),
          eq(schema.checkpoints.gitSha, sha),
        ),
      )
      .where(
        and(
          eq(schema.repoLinks.orgId, orgId),
          eq(schema.repoLinks.projectId, projectId),
          lt(schema.checkpoints.createdAt, pushed.createdAt),
        ),
      )
      .limit(1);

    return row !== undefined;
  }

  async setRemoteHeadByRepo(
    tx: TenantTransaction,
    orgId: string,
    repoId: number,
    branch: string,
    remoteHeadSha: string | null,
    except: readonly string[] = [],
  ): Promise<number> {
    const rows = await tx
      .update(schema.repoLinks)
      .set({ remoteHeadSha })
      .where(
        and(
          eq(schema.repoLinks.orgId, orgId),
          eq(schema.repoLinks.repoId, repoId),
          eq(schema.repoLinks.branch, branch),
          except.length === 0 ? undefined : notInArray(schema.repoLinks.projectId, [...except]),
        ),
      )
      .returning({ id: schema.repoLinks.id });

    return rows.length;
  }

  /** R13: links point at a removed connection no longer; they are kept, `disconnected`. */
  async disconnectAllFor(
    tx: TenantTransaction,
    orgId: string,
    connectionId: string,
  ): Promise<void> {
    await tx
      .update(schema.repoLinks)
      .set({ connectionId: null, state: 'disconnected' })
      .where(
        and(eq(schema.repoLinks.orgId, orgId), eq(schema.repoLinks.connectionId, connectionId)),
      );
  }

  /**
   * R13: a reconnect brings back the disconnected links whose repository owner is the new
   * account (login compared case-insensitively, as GitHub does). Answers how many came back.
   */
  async repointConnection(
    tx: TenantTransaction,
    orgId: string,
    connectionId: string,
    ownerLogin: string,
  ): Promise<number> {
    const rows = await tx
      .update(schema.repoLinks)
      .set({ connectionId, state: 'linked' })
      .where(
        and(
          eq(schema.repoLinks.orgId, orgId),
          eq(schema.repoLinks.state, 'disconnected'),
          isNull(schema.repoLinks.connectionId),
          sql`lower(${schema.repoLinks.owner}) = lower(${ownerLogin})`,
        ),
      )
      .returning({ id: schema.repoLinks.id });

    return rows.length;
  }
}
