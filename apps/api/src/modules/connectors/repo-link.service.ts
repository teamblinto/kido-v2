import { Inject, Injectable } from '@nestjs/common';
import type { PutRepoLinkRequest, RepoLink as RepoLinkContract } from '@repo/contracts';

import type { Plaintext } from '../../common/crypto/branded';
import { ConflictError, NotFoundError } from '../../common/errors/domain-error';
import type { TenantTransaction } from '../../database/database.types';
import { AuditService } from '../audit/audit.service';
import { CheckpointService } from '../checkpoints/checkpoint.service';
import type { SandboxRef } from '../sandbox/sandbox.port';
import { ConnectionService } from './connection.service';
import { githubRefusal, RETRY_AFTER_SECONDS, syncConflict } from './connectors.errors';
import {
  GITHUB_APP_CLIENT,
  GithubApiError,
  type GithubAppClient,
  type GithubRepository,
} from './github-app.client';
import { type RepoLinkRecord, RepoLinkRepository } from './repo-link.repository';
import { position } from './sync-guards';

/**
 * A project's link to one repository and branch (spec 018 US2/US5, contracts § 2). Linking
 * touches GitHub to create or resolve the repository; unlinking touches nothing remote (FR-020).
 */
@Injectable()
export class RepoLinkService {
  constructor(
    @Inject(GITHUB_APP_CLIENT) private readonly github: GithubAppClient,
    @Inject(RepoLinkRepository) private readonly links: RepoLinkRepository,
    @Inject(ConnectionService) private readonly connections: ConnectionService,
    @Inject(CheckpointService) private readonly checkpoints: CheckpointService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** `PUT`: a `linked` link is refused; a `disconnected` one is replaced (US5 scenario 3 aside). */
  async link(
    tx: TenantTransaction,
    ref: SandboxRef,
    actorId: string,
    body: PutRepoLinkRequest,
  ): Promise<RepoLinkContract> {
    await this.project(tx, ref);

    const current = await this.links.forProject(tx, ref.orgId, ref.projectId);

    if (current?.state === 'linked') {
      throw new ConflictError('The project is already linked; unlink it first.');
    }

    const connection = await this.connections.ensureUsable(tx, ref.orgId);

    if ('create' in body && connection.accountType !== 'organization') {
      throw syncConflict(
        'create-unsupported',
        'A personal-account installation cannot create repositories; link an existing one.',
      );
    }

    const token = await this.connections.currentToken(tx, ref.orgId);
    const { branch, repository } = await this.resolve(token, connection.accountLogin, body);
    const remoteHeadSha =
      'create' in body ? null : await this.remoteHead(token, repository, branch);

    if (current !== undefined) {
      await this.remove(tx, ref, actorId, current);
    }

    const row = await this.links.insert(tx, {
      branch,
      connectionId: connection.id,
      linkedBy: actorId,
      name: repository.name,
      orgId: ref.orgId,
      owner: repository.owner,
      projectId: ref.projectId,
      remoteHeadSha,
      repoId: repository.id,
      state: 'linked',
    });

    // FR-018: a branch already at the project's head is level, and the head counts as pushed.
    const head = remoteHeadSha === null ? null : await this.checkpoints.head(tx, ref);

    if (head !== null && head.gitSha === remoteHeadSha) {
      await this.links.setPushed(tx, ref.orgId, row.id, head.id, remoteHeadSha);
    }

    await this.audit.record(tx, {
      action: 'repo-link.created',
      actorId,
      metadata: { branch, fullName: repository.fullName, projectId: ref.projectId },
      orgId: ref.orgId,
      target: row.id,
    });

    return this.read(tx, ref) as Promise<RepoLinkContract>;
  }

  /** `DELETE`: the row goes, the repository on GitHub does not (FR-020). */
  async unlink(tx: TenantTransaction, ref: SandboxRef, actorId: string): Promise<void> {
    await this.project(tx, ref);

    const row = await this.links.forProject(tx, ref.orgId, ref.projectId);

    if (row === undefined) {
      throw new NotFoundError('The project is not linked.');
    }

    await this.remove(tx, ref, actorId, row);
  }

  async read(tx: TenantTransaction, ref: SandboxRef): Promise<RepoLinkContract | null> {
    await this.project(tx, ref);

    const row = await this.links.forProject(tx, ref.orgId, ref.projectId);

    if (row === undefined) {
      return null;
    }

    const head = await this.checkpoints.head(tx, ref);

    return this.toContract(row, head?.gitSha ?? null);
  }

  /** Contracts § 2 and § 5: `position` from the rows; `unknown` before the first checkpoint. */
  toContract(row: RepoLinkRecord, headSha: string | null): RepoLinkContract {
    return {
      branch: row.branch,
      connectionId: row.connectionId,
      id: row.id,
      lastPushedCheckpointId: row.lastPushedCheckpointId,
      linkedAt: row.createdAt.toISOString(),
      linkedBy: { id: row.linkedBy, name: row.linkedByName },
      position: headSha === null ? 'unknown' : position(row, headSha),
      remoteHeadSha: row.remoteHeadSha,
      repository: {
        fullName: `${row.owner}/${row.name}`,
        id: row.repoId,
        name: row.name,
        owner: row.owner,
      },
      state: row.state,
    };
  }

  private async project(tx: TenantTransaction, ref: SandboxRef): Promise<void> {
    const project = await this.links.project(tx, ref.orgId, ref.projectId);

    if (project === undefined) {
      throw new NotFoundError('No such project.');
    }
  }

  private async remove(
    tx: TenantTransaction,
    ref: SandboxRef,
    actorId: string,
    row: RepoLinkRecord,
  ): Promise<void> {
    await this.links.delete(tx, ref.orgId, row.id);
    await this.audit.record(tx, {
      action: 'repo-link.removed',
      actorId,
      metadata: { fullName: `${row.owner}/${row.name}`, projectId: ref.projectId },
      orgId: ref.orgId,
      target: row.id,
    });
  }

  /** `create` at GitHub (R4), or `existing` looked up by id; the branch defaults to the repository's. */
  private async resolve(
    token: Plaintext,
    accountLogin: string,
    body: PutRepoLinkRequest,
  ): Promise<{ branch: string; repository: GithubRepository }> {
    try {
      if ('create' in body) {
        const repository = await this.github.createOrgRepository(
          token,
          accountLogin,
          body.create.name,
          body.create.private,
        );

        return { branch: repository.defaultBranch, repository };
      }

      const repository = await this.github.repository(token, body.existing.repoId);

      return { branch: body.existing.branch ?? repository.defaultBranch, repository };
    } catch (error) {
      if (!(error instanceof GithubApiError)) {
        throw error;
      }

      if ('create' in body && error.category === 'validation') {
        throw syncConflict('name-taken', `A repository named ${body.create.name} already exists.`);
      }

      if ('existing' in body && error.category === 'not-found') {
        throw new NotFoundError('No such repository on this installation.');
      }

      throw githubRefusal(error.category, RETRY_AFTER_SECONDS);
    }
  }

  /** The branch head at link time, so `position` is honest from the start; null when it does not exist yet. */
  private async remoteHead(
    token: Plaintext,
    repository: GithubRepository,
    branch: string,
  ): Promise<string | null> {
    try {
      return (await this.github.branch(token, repository.owner, repository.name, branch)).sha;
    } catch (error) {
      if (!(error instanceof GithubApiError)) {
        throw error;
      }

      if (error.category === 'not-found') {
        return null;
      }

      throw githubRefusal(error.category, RETRY_AFTER_SECONDS);
    }
  }
}
