import { Inject, Injectable } from '@nestjs/common';
import type {
  AuthorizeRepoCreateRequest,
  AuthorizeRepoCreateResponse,
  CompleteRepoCreateRequest,
  CreateBranchRequest,
  PatchRepoLinkRequest,
  PutRepoLinkRequest,
  RepoBranchList,
  RepoLink as RepoLinkContract,
} from '@repo/contracts';

import type { Plaintext } from '../../common/crypto/branded';
import { ConflictError, NotFoundError } from '../../common/errors/domain-error';
import type { TenantTransaction } from '../../database/database.types';
import { AuditService } from '../audit/audit.service';
import { CheckpointService } from '../checkpoints/checkpoint.service';
import { OauthStateError } from '../identity/services/oauth.service';
import type { SandboxRef } from '../sandbox/sandbox.port';
import type { ConnectionRecord } from './connection.repository';
import { ConnectionService } from './connection.service';
import { githubRefusal, RETRY_AFTER_SECONDS, syncConflict } from './connectors.errors';
import {
  GITHUB_APP_CLIENT,
  GithubApiError,
  type GithubAppClient,
  type GithubRepository,
} from './github-app.client';
import { InstallStateStore, type RepoCreateIntent } from './install-state';
import { type RepoLinkRecord, RepoLinkRepository } from './repo-link.repository';
import { position } from './sync-guards';
import { SyncRepository } from './sync.repository';
import { SyncService } from './sync.service';

/**
 * A project's link to one repository and branch (spec 018 US2/US5, contracts § 2). Linking
 * touches GitHub to create or resolve the repository; unlinking touches nothing remote (FR-020).
 * Spec 044 adds what can change on a live link, and the personal-account create (decision 7).
 */
@Injectable()
export class RepoLinkService {
  constructor(
    @Inject(GITHUB_APP_CLIENT) private readonly github: GithubAppClient,
    @Inject(RepoLinkRepository) private readonly links: RepoLinkRepository,
    @Inject(ConnectionService) private readonly connections: ConnectionService,
    @Inject(CheckpointService) private readonly checkpoints: CheckpointService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SyncService) private readonly syncs: SyncService,
    @Inject(SyncRepository) private readonly operations: SyncRepository,
    @Inject(InstallStateStore) private readonly states: InstallStateStore,
  ) {}

  /** `PUT`: a `linked` link is refused; a `disconnected` one is replaced (US5 scenario 3 aside). */
  async link(
    tx: TenantTransaction,
    ref: SandboxRef,
    actorId: string,
    body: PutRepoLinkRequest,
  ): Promise<RepoLinkContract> {
    const current = await this.notLinked(tx, ref);
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

    return this.attach(tx, ref, actorId, {
      branch,
      connection,
      current,
      remoteHeadSha,
      repository,
    });
  }

  /** `PATCH`: where pushes go and whether a turn pushes. The project's files stay (decision 9). */
  async update(
    tx: TenantTransaction,
    ref: SandboxRef,
    actorId: string,
    body: PatchRepoLinkRequest,
  ): Promise<RepoLinkContract> {
    const link = await this.linked(tx, ref);
    const branch = body.branch === link.branch ? undefined : body.branch;
    const autoSync = body.autoSync === link.autoSync ? undefined : body.autoSync;

    if (branch !== undefined) {
      await this.ensureIdle(tx, ref);
      await this.connections.ensureUsable(tx, ref.orgId);

      const token = await this.connections.currentToken(tx, ref.orgId);
      const sha = await this.remoteHead(token, await this.healed(tx, token, link), branch);

      if (sha === null) {
        throw syncConflict('branch-not-found', `The branch ${branch} is not on GitHub.`);
      }

      await this.moveTo(tx, ref, link.id, branch, sha);
    }

    if (autoSync !== undefined) {
      await this.links.setAutoSync(tx, ref.orgId, link.id, autoSync);
    }

    if (branch !== undefined || autoSync !== undefined) {
      await this.audit.record(tx, {
        action: 'repo-link.updated',
        actorId,
        metadata: { autoSync, branch, projectId: ref.projectId },
        orgId: ref.orgId,
        target: link.id,
      });
    }

    if (autoSync === true) {
      await this.syncs.requestAuto(tx, ref);
    }

    return this.read(tx, ref) as Promise<RepoLinkContract>;
  }

  /** `GET …/branches`: `default` from the repository, `protected` from GitHub. */
  async branches(tx: TenantTransaction, ref: SandboxRef): Promise<RepoBranchList> {
    await this.project(tx, ref);

    const link = await this.links.forProject(tx, ref.orgId, ref.projectId);

    // A read has nothing to refuse: an unlinked project has no branches.
    if (link?.state !== 'linked') return { branches: [] };

    await this.connections.ensureUsable(tx, ref.orgId);

    const token = await this.connections.currentToken(tx, ref.orgId);

    try {
      const [repository, branches] = await Promise.all([
        this.github.repository(token, link.repoId),
        this.github.listBranches(token, link.repoId),
      ]);

      return {
        branches: branches.map((branch) => ({
          default: branch.name === repository.defaultBranch,
          name: branch.name,
          protected: branch.protected,
        })),
      };
    } catch (error) {
      if (!(error instanceof GithubApiError)) {
        throw error;
      }

      if (error.category === 'not-found') {
        throw new NotFoundError('No such repository on this installation.');
      }

      throw githubRefusal(error.category, RETRY_AFTER_SECONDS);
    }
  }

  /**
   * `POST …/branches`: every refusal comes before the ref exists, so a refused switch leaves no
   * branch behind. The head is read fresh: the row's copy can lag a push it was not told about.
   */
  async createBranch(
    tx: TenantTransaction,
    ref: SandboxRef,
    actorId: string,
    { name }: CreateBranchRequest,
  ): Promise<RepoLinkContract> {
    const link = await this.linked(tx, ref);

    await this.ensureIdle(tx, ref);

    const token = await this.connections.repositoryToken(tx, ref.orgId, link.repoId);
    const { name: repo, owner } = await this.healed(tx, token, link);
    const sha = await this.remoteHead(token, { name: repo, owner }, link.branch);

    if (sha === null) {
      throw syncConflict('nothing-to-push', `The branch ${link.branch} has no commits yet.`);
    }

    try {
      await this.github.createRef(token, owner, repo, name, sha);
    } catch (error) {
      if (!(error instanceof GithubApiError)) {
        throw error;
      }

      if (error.category === 'validation') {
        throw syncConflict('name-taken', `A branch named ${name} already exists.`);
      }

      throw githubRefusal(error.category, RETRY_AFTER_SECONDS);
    }

    await this.moveTo(tx, ref, link.id, name, sha);
    await this.audit.record(tx, {
      action: 'repo-link.updated',
      actorId,
      metadata: { branch: name, projectId: ref.projectId },
      orgId: ref.orgId,
      target: link.id,
    });

    return this.read(tx, ref) as Promise<RepoLinkContract>;
  }

  /** Decision 7, step one: `PUT` serves an organisation; a person goes through the App's OAuth. */
  async authorize(
    tx: TenantTransaction,
    ref: SandboxRef,
    actorId: string,
    body: AuthorizeRepoCreateRequest,
  ): Promise<AuthorizeRepoCreateResponse> {
    await this.notLinked(tx, ref);
    this.ensurePersonal(await this.connections.ensureUsable(tx, ref.orgId));

    if (!this.github.canAuthorizeUsers()) {
      throw syncConflict(
        'create-unsupported',
        'This deployment cannot create repositories on a personal account; link an existing one.',
      );
    }

    const state = await this.states.issue(ref.orgId, actorId, {
      provider: 'github',
      repoCreate: { name: body.name, private: body.private, projectId: ref.projectId },
    });

    return { authorizeUrl: this.github.authorizeUrl(state) };
  }

  /**
   * Decision 7, step two. The state is spent first, whatever follows, and everything is checked
   * again: the project or connection may have changed while the person was on GitHub.
   */
  async completeCreate(
    tx: TenantTransaction,
    ref: SandboxRef,
    actorId: string,
    { code, state }: CompleteRepoCreateRequest,
  ): Promise<RepoLinkContract> {
    await this.project(tx, ref);

    const stored = await this.states.consume(state, {
      orgId: ref.orgId,
      projectId: ref.projectId,
      provider: 'github',
      userId: actorId,
    });

    if (stored?.repoCreate === undefined) {
      throw new OauthStateError();
    }

    const current = await this.notLinked(tx, ref);
    const connection = await this.connections.ensureUsable(tx, ref.orgId);

    this.ensurePersonal(connection);

    const repository = await this.createPersonal(tx, ref, connection, code, stored.repoCreate);

    // An empty repository, as `create` makes: no head to read, and no read through an installation
    // token that may have been minted before the repository joined the installation.
    return this.attach(tx, ref, actorId, {
      branch: repository.defaultBranch,
      connection,
      current,
      remoteHeadSha: null,
      repository,
    });
  }

  /**
   * The user token lives in this frame and goes nowhere else: never sealed, logged or returned. A
   * failure past the create leaves the repository on GitHub, and the person is told so.
   */
  private async createPersonal(
    tx: TenantTransaction,
    ref: SandboxRef,
    connection: ConnectionRecord,
    code: string,
    { name, private: isPrivate }: RepoCreateIntent,
  ): Promise<GithubRepository> {
    let repository: GithubRepository | undefined;
    let token: Plaintext | undefined;

    try {
      token = await this.github.exchangeUserCode(code);
      const login = await this.github.userLogin(token);

      if (login.toLowerCase() !== connection.accountLogin.toLowerCase()) {
        throw syncConflict(
          'account-mismatch',
          `GitHub signed you in as ${login}; this organisation is connected to ${connection.accountLogin}.`,
        );
      }

      repository = await this.github.createUserRepository(token, name, isPrivate);

      try {
        await this.github.addRepositoryToInstallation(
          token,
          connection.installationId!,
          repository.id,
        );
      } catch (error) {
        // An all-repositories install already reaches it and may refuse the add: ask, then decide.
        const reachable = await this.github
          .repository(await this.connections.currentToken(tx, ref.orgId), repository.id)
          .catch(() => undefined);

        if (reachable === undefined) throw error;
      }

      return repository;
    } catch (error) {
      if (!(error instanceof GithubApiError)) {
        throw error;
      }

      if (repository !== undefined) {
        throw githubRefusal(
          error.category,
          RETRY_AFTER_SECONDS,
          `The repository ${repository.fullName} was created, but the GitHub App could not be given access to it. Add it to the App's installation on GitHub, then link it as an existing repository.`,
        );
      }

      if (error.category === 'validation') {
        throw syncConflict('name-taken', `A repository named ${name} already exists.`);
      }

      throw githubRefusal(error.category, RETRY_AFTER_SECONDS);
    } finally {
      if (token !== undefined) await this.github.revokeUserToken(token);
    }
  }

  /** The row, the audit and the first push: every way a project comes to be linked ends here. */
  private async attach(
    tx: TenantTransaction,
    ref: SandboxRef,
    actorId: string,
    {
      branch,
      connection,
      current,
      remoteHeadSha,
      repository,
    }: {
      branch: string;
      connection: ConnectionRecord;
      current: RepoLinkRecord | undefined;
      remoteHeadSha: string | null;
      repository: GithubRepository;
    },
  ): Promise<RepoLinkContract> {
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

    // Spec 044: the project lands on GitHub at once, not at its next turn.
    await this.syncs.requestAuto(tx, ref);

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
      autoSync: row.autoSync,
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
      sideBranch: row.sideBranch,
      state: row.state,
    };
  }

  private async project(tx: TenantTransaction, ref: SandboxRef): Promise<void> {
    const project = await this.links.project(tx, ref.orgId, ref.projectId);

    if (project === undefined) {
      throw new NotFoundError('No such project.');
    }
  }

  /** Answers what a new link replaces: nothing, or a `disconnected` row. */
  private async notLinked(
    tx: TenantTransaction,
    ref: SandboxRef,
  ): Promise<RepoLinkRecord | undefined> {
    await this.project(tx, ref);

    const current = await this.links.forProject(tx, ref.orgId, ref.projectId);

    if (current?.state === 'linked') {
      throw new ConflictError('The project is already linked; unlink it first.');
    }

    return current;
  }

  /** The link's name as GitHub has it now: the owner/name routes refuse a renamed repository. */
  private async healed(
    tx: TenantTransaction,
    token: Plaintext,
    link: RepoLinkRecord,
  ): Promise<{ readonly name: string; readonly owner: string }> {
    try {
      const { name, owner } = await this.github.repository(token, link.repoId);

      if (name !== link.name || owner !== link.owner) {
        await this.links.setRepository(tx, link.orgId, link.id, { name, owner });
      }

      return { name, owner };
    } catch (error) {
      if (!(error instanceof GithubApiError)) {
        throw error;
      }

      if (error.category === 'not-found') {
        throw syncConflict('repo-gone', 'The repository is gone from GitHub.');
      }

      throw githubRefusal(error.category, RETRY_AFTER_SECONDS);
    }
  }

  private async linked(tx: TenantTransaction, ref: SandboxRef): Promise<RepoLinkRecord> {
    await this.project(tx, ref);

    const link = await this.links.forProject(tx, ref.orgId, ref.projectId);

    if (link?.state !== 'linked') {
      throw syncConflict('not-linked', 'The project is not linked to a repository.');
    }

    return link;
  }

  private ensurePersonal(connection: ConnectionRecord): void {
    if (connection.accountType === 'organization') {
      throw new ConflictError('An organisation creates its repository through the link itself.');
    }
  }

  /** Decision 9: a branch does not change under a run or an operation. */
  private async ensureIdle(tx: TenantTransaction, ref: SandboxRef): Promise<void> {
    if (await this.checkpoints.activeRunExists(tx, ref)) {
      throw syncConflict('run-active', 'A run is in progress; the branch waits for it to end.');
    }

    if (await this.operations.inFlightExists(tx, ref.orgId, ref.projectId)) {
      throw syncConflict('operation-in-flight', 'A push or pull is already in progress.');
    }
  }

  /**
   * A remote head that is one of the project's checkpoints counts as pushed, so `position` reads
   * level or ahead; any other is history the project does not have, and reads as diverged.
   */
  private async moveTo(
    tx: TenantTransaction,
    ref: SandboxRef,
    id: string,
    branch: string,
    remoteHeadSha: string,
  ): Promise<void> {
    const checkpointId = await this.links.checkpointAt(tx, ref.orgId, ref.projectId, remoteHeadSha);

    await this.links.setBranch(tx, ref.orgId, id, {
      branch,
      lastPushedCheckpointId: checkpointId ?? null,
      remoteHeadSha,
    });
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
    repository: Pick<GithubRepository, 'name' | 'owner'>,
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
