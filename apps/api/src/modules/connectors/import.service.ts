import { Inject, Injectable } from '@nestjs/common';
import type {
  InspectImportRequest,
  InspectImportResponse,
  ProjectTemplate,
  StartImportRequest,
  SyncFailureReason,
  SyncOperation as SyncOperationContract,
  TemplateMismatch,
} from '@repo/contracts';
import { outcomeFor } from '@repo/contracts';
import { schema } from '@repo/db';
import { and, eq } from 'drizzle-orm';

import type { Plaintext } from '../../common/crypto/branded';
import { NotFoundError } from '../../common/errors/domain-error';
import type { TenantTransaction } from '../../database/database.types';
import { AuditService } from '../audit/audit.service';
import { OutboxWriter } from '../outbox/outbox-writer';
import { ProjectService } from '../tenancy/services/project.service';
import { ConnectionService } from './connection.service';
import {
  ImportBranchNotFoundError,
  ImportEmptyRepoError,
  ImportRepoTooLargeError,
  importGithubRefusal,
} from './connectors.errors';
import {
  GITHUB_APP_CLIENT,
  GithubApiError,
  type GithubAppClient,
  type GithubRepository,
} from './github-app.client';
import { RepoLinkRepository } from './repo-link.repository';
import { SyncRepository } from './sync.repository';
import { SyncService } from './sync.service';
import { inspectRoot } from './template-inspector';

/**
 * Research R6: the cheap gate, in KiB, checked where the user is still waiting and can be told a
 * number. A constant rather than configuration (§25.5): it is a property of the sandbox's upload
 * limit, and a wrong value fails an import without failing anything visible.
 */
export const MAX_IMPORT_REPOSITORY_KIB = 512 * 1024;

/** The contract's 202 body: spec 018's operation plus the project the client navigates to. */
export type StartedImport = SyncOperationContract;

/**
 * Importing a repository into a new project (spec 026 US1, contracts §§ 1–2).
 *
 * Two entry points, and the whole of the difference between them is when a row exists.
 *
 * {@link inspect} makes two GitHub calls and writes nothing: the root tree at the branch head and,
 * when there is one, the root `package.json`. The classification is `template-inspector.ts`'s,
 * which is pure — this class's job is the I/O and the refusals, not the rules.
 *
 * {@link start} decides every refusal **before** the first insert, so a refused import leaves
 * zero rows of every kind (FR-007, SC-005), and then writes the project, the link and the `queued`
 * operation in one tenant transaction with the `sync.requested` that carries it to the consumer.
 * The link is written here rather than at the end because the runner needs somewhere to read the
 * owner, name and branch from, and because a `sync_operations` row whose `link_id` is null is a
 * row spec 018's own reads would have to special-case.
 *
 * What is *not* decided here: the template. The client sends one and the server honours it even
 * when a re-inspection would now disagree (FR-013); the disagreement is the FR-016 warning, not a
 * refusal — which is what makes "no template is applied by default" a property of the wire.
 */
@Injectable()
export class ImportService {
  constructor(
    @Inject(ConnectionService) private readonly connections: ConnectionService,
    @Inject(GITHUB_APP_CLIENT) private readonly github: GithubAppClient,
    @Inject(ProjectService) private readonly projects: ProjectService,
    @Inject(RepoLinkRepository) private readonly links: RepoLinkRepository,
    @Inject(SyncRepository) private readonly operations: SyncRepository,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SyncService) private readonly syncs: SyncService,
  ) {}

  /**
   * Contracts § 1. Idempotent and read-only despite the verb. A branch with no commits is not a
   * refusal here — `empty: true` with a null head and no candidates is the answer the UI needs in
   * order to say "push a first commit" rather than "something went wrong"; `start` is where an
   * empty branch becomes `import-empty-repo`, because that is where it would cost rows.
   */
  async inspect(
    tx: TenantTransaction,
    orgId: string,
    request: InspectImportRequest,
  ): Promise<InspectImportResponse> {
    await this.connections.ensureUsable(tx, orgId);

    const token = await this.connections.currentToken(tx, orgId);
    const repo = await this.repository(token, request.repoId);
    const branch = request.branch ?? repo.defaultBranch;
    const headSha = await this.head(token, repo, branch);
    const base = {
      branch,
      repo: { id: repo.id, name: repo.name, owner: repo.owner },
      sizeKib: repo.sizeKib,
    };

    if (headSha === null) {
      return { ...base, candidates: [], empty: true, headSha: null, outcome: outcomeFor(0) };
    }

    const { candidates, outcome } = inspectRoot(await this.root(token, repo.id, headSha));

    return { ...base, candidates: [...candidates], empty: false, headSha, outcome };
  }

  /**
   * Contracts § 2. The order is the contract's: every gate, then one transaction.
   *
   * The sandbox is not claimed here by hand — `ProjectService.create` writes `project.created`,
   * and spec 014's consumer claims from the chosen template's current version off that event
   * (FR-015). Doing it twice would be two ways to make a project's sandbox.
   */
  async start(
    tx: TenantTransaction,
    orgId: string,
    workspaceId: string,
    actorId: string,
    request: StartImportRequest,
  ): Promise<StartedImport> {
    const connection = await this.connections.ensureUsable(tx, orgId);
    const token = await this.connections.currentToken(tx, orgId);
    const repo = await this.repository(token, request.repoId);

    // The size gate first: it is the one refusal that does not need a second GitHub call, and a
    // repository too large to import is too large whether or not its branch still exists.
    if (repo.sizeKib > MAX_IMPORT_REPOSITORY_KIB) {
      throw new ImportRepoTooLargeError(repo.sizeKib, MAX_IMPORT_REPOSITORY_KIB);
    }

    const headSha = await this.head(token, repo, request.branch);

    if (headSha === null) {
      // The branch the client named is either gone or unborn. GitHub answers 404 for both, and the
      // two are genuinely different things to ask of a person, so the default branch — the one a
      // repository always names — is read as "no commits yet" and any other as "that branch went".
      if (request.branch === repo.defaultBranch) {
        throw new ImportEmptyRepoError(request.branch);
      }

      throw new ImportBranchNotFoundError(request.branch);
    }

    // FR-013/FR-016: the repository is re-inspected here, and the answer changes nothing about
    // which template is used — `request.template` is honoured whatever it says. What the
    // re-inspection buys is the *disagreement*, recorded on the audit trail beside the choice so
    // the override is readable afterwards rather than inferred. A mismatch is not a refusal.
    const detected = detectedTemplates(inspectRoot(await this.root(token, repo.id, headSha)));
    const mismatch = mismatchOf(detected, request.template);

    const project = await this.projects.create({
      actorId,
      name: request.name,
      orgId,
      ownerId: actorId,
      template: request.template,
      workspaceId,
    });

    const link = await this.links.insert(tx, {
      branch: request.branch,
      connectionId: connection.id,
      linkedBy: actorId,
      name: repo.name,
      orgId,
      owner: repo.owner,
      projectId: project.id,
      repoId: repo.id,
      state: 'linked',
    });

    const operation = await this.operations.insertQueued(tx, {
      kind: 'import',
      linkId: link.id,
      orgId,
      projectId: project.id,
      requestedBy: actorId,
      toSha: headSha,
    });

    // FR-009: the request is audited on the same handle as the rows, so a rollback takes it too.
    await this.audit.record(tx, {
      action: 'import.requested',
      actorId,
      metadata: {
        branch: request.branch,
        projectId: project.id,
        repository: repo.fullName,
        syncOperationId: operation.id,
        template: request.template,
        // Null when they agree, which is the common case and still worth writing: "we looked and
        // it matched" and "we never looked" are different things to read back.
        templateMismatch: mismatch,
      },
      orgId,
      target: project.id,
    });

    await this.outbox.append(tx, {
      aggregateId: operation.id,
      orgId,
      payload: { orgId, projectId: project.id, syncOperationId: operation.id },
      type: 'sync.requested',
    });

    return this.syncs.toContract((await this.operations.byId(tx, orgId, operation.id))!);
  }

  /**
   * T070, R2: the one cleanup path a failed import takes, wherever it failed.
   *
   * FR-007 asks for "no project visible in the workspace and any sandbox released", and R2 fixes
   * what that means here: the project is **soft**-deleted rather than removed, because the failed
   * `sync_operations` row points at it and a hard delete would take the user's only readable
   * account of what went wrong with it. `ProjectService.archive` is the whole of the sandbox
   * story — it writes `deleted_at` and emits `project.archived`, which is spec 014's ordinary
   * release operation — so nothing here touches a sandbox by hand.
   *
   * Every step is written to survive being run twice, because a retry can meet a half-cleaned
   * attempt: `markDone` closes an open row only and answers 0 otherwise, which is also what gates
   * the audit entry so a second pass cannot write a second `import.failed`; deleting a link that
   * is already gone deletes nothing; and the project is archived only while it is still live,
   * because `archive` refuses a project it has already withdrawn.
   *
   * `path` is FR-020's: the file the sandbox could not represent, named on the trail beside the
   * reason. Null for every failure that is not about one file.
   */
  async withdraw(
    tx: TenantTransaction,
    entry: {
      actorId: string;
      branch: string;
      finishedAt: Date;
      linkId: string | null;
      operationId: string;
      orgId: string;
      path?: string | null;
      projectId: string;
      reason: SyncFailureReason;
      repository: string;
    },
  ): Promise<void> {
    const { actorId, linkId, operationId, orgId, projectId, reason } = entry;

    const closed = await this.operations.markDone(tx, orgId, operationId, {
      finishedAt: entry.finishedAt,
      reason,
      state: 'failed',
    });

    if (closed > 0) {
      await this.audit.record(tx, {
        action: 'import.failed',
        actorId,
        metadata: {
          branch: entry.branch,
          path: entry.path ?? null,
          reason,
          repository: entry.repository,
          syncOperationId: operationId,
        },
        orgId,
        target: projectId,
      });
    }

    if (linkId !== null) await this.links.delete(tx, orgId, linkId);

    const project = await this.links.project(tx, orgId, projectId);

    if (project !== undefined && !project.archived) {
      await this.projects.archive({
        actorId,
        orgId,
        projectId,
        workspaceId: project.workspaceId,
      });
    }
  }

  /**
   * Contracts § 4: the FR-016 warning for the project's GitHub panel.
   *
   * `detected` is defined by the contract as "what inspect would say **now**", so it is computed
   * here rather than read from a column written at import time — a repository whose manifest
   * changed after the import is a repository whose warning should change with it, and a stored
   * copy would go stale silently. The chosen template is the project's own `template`, which is
   * what the import set (FR-015).
   *
   * Null when they agree, when nothing is recognised (nothing recognised is not a disagreement —
   * FR-011 already made the user choose), when the project has no template, and when the project
   * is not linked to a repository at all. Nothing here blocks anything: it is one line of copy.
   */
  async mismatch(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
  ): Promise<TemplateMismatch> {
    const [project] = await tx
      .select({ template: schema.projects.template })
      .from(schema.projects)
      .where(and(eq(schema.projects.orgId, orgId), eq(schema.projects.id, projectId)));
    const chosen = project?.template as ProjectTemplate | null | undefined;
    const link = await this.links.forProject(tx, orgId, projectId);

    if (chosen === null || chosen === undefined || link?.state !== 'linked') {
      return null;
    }

    await this.connections.ensureUsable(tx, orgId);

    const token = await this.connections.currentToken(tx, orgId);
    const repo = await this.repository(token, link.repoId);
    const headSha = await this.head(token, repo, link.branch);

    if (headSha === null) return null;

    return mismatchOf(
      detectedTemplates(inspectRoot(await this.root(token, repo.id, headSha))),
      chosen,
    );
  }

  /** A repository this installation cannot see is `not-found`, never "GitHub is unavailable". */
  private async repository(token: Plaintext, repoId: number): Promise<GithubRepository> {
    try {
      return await this.github.repository(token, repoId);
    } catch (error) {
      if (error instanceof GithubApiError) {
        throw error.category === 'not-found'
          ? new NotFoundError('No such repository.')
          : importGithubRefusal(error.category);
      }

      throw error;
    }
  }

  /** The branch head, or null when GitHub has no such branch (unborn or gone — see `start`). */
  private async head(
    token: Plaintext,
    repo: GithubRepository,
    branch: string,
  ): Promise<string | null> {
    try {
      return (await this.github.branch(token, repo.owner, repo.name, branch)).sha;
    } catch (error) {
      if (error instanceof GithubApiError) {
        if (error.category === 'not-found') return null;
        throw importGithubRefusal(error.category);
      }

      throw error;
    }
  }

  /** R3's two reads: the root tree, and the root `package.json` only when the tree names one. */
  private async root(
    token: Plaintext,
    repoId: number,
    headSha: string,
  ): Promise<{ files: string[]; packageJson: string | null }> {
    let files: string[];

    try {
      files = (await this.github.tree(token, repoId, headSha)).entries.map((entry) => entry.path);
    } catch (error) {
      throw error instanceof GithubApiError ? importGithubRefusal(error.category) : error;
    }

    if (!files.includes('package.json')) {
      return { files, packageJson: null };
    }

    try {
      return {
        files,
        packageJson: (await this.github.contents(token, repoId, 'package.json')) ?? null,
      };
    } catch (error) {
      // A manifest that will not read costs the dependency signals, not the inspection: the root
      // `package.json` is itself a signal, and refusing the whole answer over it helps nobody.
      if (error instanceof GithubApiError) return { files, packageJson: null };

      throw error;
    }
  }
}

/** The candidate templates, in the inspector's reading order and without their evidence. */
function detectedTemplates(inspection: {
  candidates: readonly { template: ProjectTemplate }[];
}): ProjectTemplate[] {
  return inspection.candidates.map((candidate) => candidate.template);
}

/**
 * Contracts § 4's one rule. A disagreement needs something to disagree *with*: an `unrecognised`
 * repository detected nothing, and "we could not tell" is not the same claim as "we can tell, and
 * it is not that" — only the second is worth a line on the panel. An `ambiguous` repository agrees
 * as soon as the chosen template is among the ones it named.
 */
function mismatchOf(detected: ProjectTemplate[], chosen: ProjectTemplate): TemplateMismatch {
  if (detected.length === 0 || detected.includes(chosen)) return null;

  return { chosen, detected };
}
