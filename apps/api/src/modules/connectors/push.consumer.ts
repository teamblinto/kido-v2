import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SyncFailureReason } from '@repo/contracts';
import type { Checkpoint } from '@repo/db';
import { sql } from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import type { Plaintext } from '../../common/crypto/branded';
import { ConflictError, ServiceUnavailableError } from '../../common/errors/domain-error';
import type { TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { CheckpointService } from '../checkpoints/checkpoint.service';
import { RepoBundler } from '../checkpoints/repo-bundler';
import { EventConsumer, RetryableFailure } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import type { MutationContext } from '../sandbox/sandbox.port';
import { ConnectionService } from './connection.service';
import {
  GITHUB_APP_CLIENT,
  GithubApiError,
  type GithubAppClient,
  type GithubRepository,
} from './github-app.client';
import { LOCAL_GIT, type LocalGit, LocalGitError } from './local-git';
import { type RepoLinkRecord, RepoLinkRepository } from './repo-link.repository';
import {
  classifyPushRejection,
  type PushRejection,
  pushDecision,
  SIDE_BRANCH,
} from './sync-guards';
import { type SyncRecord, SyncRepository } from './sync.repository';
import { SyncService } from './sync.service';

export const SYNC_QUEUE = 'connector.sync';

/**
 * T034's seam. `QueueRegistry` refuses two consumers of one event type on one queue, so the
 * pull is not a second `EventConsumer`: `pull.consumer.ts` provides a plain `@Injectable()` under
 * `PULL_RUNNER` and `SyncConsumer` dispatches to it — `handle` on the base's transaction (the
 * writer lock, `activeRunExists`, `markRunning`), `effect` with no connection held.
 */
export const PULL_RUNNER = Symbol('forge.connectors.pullRunner');

/** Spec 026 US1: the import's seam, the same shape and there for the same reason as the pull's. */
export const IMPORT_RUNNER = Symbol('forge.connectors.importRunner');

export interface PullRunner<P = unknown> {
  handle(tx: TenantTransaction, operation: SyncRecord): Promise<P>;
  effect(operation: SyncRecord, prepared: P, attempt: number): Promise<void>;
}

export interface PushJob {
  readonly head: Checkpoint;
  readonly kind: 'push';
  readonly link: RepoLinkRecord;
  readonly operation: SyncRecord;
}

export interface PullJob {
  readonly kind: 'pull';
  readonly operation: SyncRecord;
  readonly prepared: unknown;
}

/** Spec 026 US1: the third kind, dispatched to `IMPORT_RUNNER` exactly as a pull is to its own. */
export interface ImportJob {
  readonly kind: 'import';
  readonly operation: SyncRecord;
  readonly prepared: unknown;
}

/** `undefined`: the operation is gone or already settled — nothing for `effect`. */
export type SyncJob = ImportJob | PullJob | PushJob | undefined;

type SyncEvent = Envelope<'sync.requested'>;

interface Outcome {
  readonly commits?: number;
  readonly fromSha?: string | null;
  readonly reason: SyncFailureReason | null;
  /** What the remote branch was at, for the link's `remote_head_sha` (contracts § 5). */
  readonly remoteHead?: string | null;
  readonly state: 'failed' | 'succeeded';
  /** Spec 044: where the head landed; anything but the linked branch is a side push. */
  readonly targetBranch?: string;
  readonly toSha?: string | null;
}

/** One push's remote, for what happens after the linked branch's own check. */
interface Target {
  readonly auth: { readonly auth: Plaintext };
  readonly cwd: string;
  readonly head: Checkpoint;
  readonly link: RepoLinkRecord;
  readonly remote: string;
  /** The linked branch, as the link will record it. */
  readonly remoteHead: string | null;
}

/** What GitHub refused, read off a push that ran to its end; a timeout said nothing of the kind. */
function rejectionOf(error: unknown): PushRejection | undefined {
  return error instanceof LocalGitError && error.reason === 'git-failed'
    ? classifyPushRejection(error.stderr)
    : undefined;
}

/**
 * `sync.requested` → the push (spec 018 US2, research R1, R3, R5, R7). `handle` loads the row and
 * its link and head, marks it `running`; `effect` bundles the repository (the mirror when current,
 * the sandbox otherwise — SC-006 holds in the steady state), mints the one-repository token, and in
 * a temp directory clones the bundle bare, fetches the remote branch and pushes a fast-forward or
 * nothing (`pushDecision`; never `--force`, SC-005). The token travels in git's environment only.
 *
 * Retry: a sandbox still waking, a provider 5xx at the mint, a git timeout — `RetryableFailure`;
 * on the last attempt the row closes as `provider-unavailable` / `timed-out`. A refused mint
 * closes the row as `needs-reauth` (the service audited the health change). Every other failure is `git-failed`.
 * A push holds the writer lock only while it bundles (see `push`): git itself runs with none (R7).
 *
 * Spec 044: the repository is resolved by its id first (decision 10), and what GitHub refuses is
 * read from git's stderr into the closed vocabulary. An `auto` operation the linked branch cannot
 * take goes to `kido-sync` by fast-forward (decision 4); a manual one keeps spec 018's refusal.
 * Settling compares the head with what this job pushed and asks for one more if it moved (decision
 * 3). That cannot loop: a follow-up needs a checkpoint newer than the job before it, and only a
 * person or a run makes one; a job that finds the head where it started asks for nothing.
 */
@Injectable()
export class SyncConsumer extends EventConsumer<'sync.requested', SyncJob> {
  readonly attempts = 3;
  override readonly concurrency = 2;
  readonly name = 'connector-sync';
  override readonly profile = 'events' as const;
  readonly queue = SYNC_QUEUE;
  readonly types = ['sync.requested'] as const;

  private readonly logger = new Logger(SyncConsumer.name);

  constructor(
    @Inject(SyncRepository) private readonly operations: SyncRepository,
    @Inject(RepoLinkRepository) private readonly links: RepoLinkRepository,
    @Inject(CheckpointService) private readonly checkpoints: CheckpointService,
    @Inject(RepoBundler) private readonly bundler: RepoBundler,
    @Inject(ConnectionService) private readonly connections: ConnectionService,
    @Inject(LOCAL_GIT) private readonly git: LocalGit,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(PULL_RUNNER) private readonly pull: PullRunner,
    @Inject(IMPORT_RUNNER) private readonly imports: PullRunner,
    @Inject(GITHUB_APP_CLIENT) private readonly github: GithubAppClient,
    @Inject(SyncService) private readonly syncs: SyncService,
  ) {
    super();
  }

  override jobId(event: SyncEvent): string {
    return event.payload.syncOperationId;
  }

  async handle(event: SyncEvent, tx: TenantTransaction): Promise<SyncJob> {
    const { orgId, projectId, syncOperationId } = event.payload;
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    const operation = await this.operations.byId(tx, orgId, syncOperationId);

    // `running` is this job's own earlier attempt: the retry runs `handle` again.
    if (
      operation === undefined ||
      (operation.state !== 'queued' && operation.state !== 'running')
    ) {
      return undefined;
    }

    if (operation.kind === 'pull') {
      return { kind: 'pull', operation, prepared: await this.pull.handle(tx, operation) };
    }

    // Spec 026 US1: one consumer, three arms — `QueueRegistry` refuses a second consumer of one
    // event type on one queue, and an import is a sync operation with no history yet.
    if (operation.kind === 'import') {
      return { kind: 'import', operation, prepared: await this.imports.handle(tx, operation) };
    }

    // The service refused these before the row existed; the link or head can still go between.
    const link = await this.links.forProject(tx, orgId, projectId);
    const head = await this.checkpoints.head(tx, { orgId, projectId });

    if (link?.state !== 'linked' || head === null) {
      await this.operations.markDone(tx, orgId, operation.id, {
        finishedAt: this.clock.now(),
        reason: link?.state === 'linked' ? 'nothing-to-push' : 'not-linked',
        state: 'failed',
      });

      return undefined;
    }

    await this.operations.markRunning(tx, orgId, operation.id, this.clock.now());

    return { head, kind: 'push', link, operation };
  }

  override async effect(_event: SyncEvent, job: SyncJob, attempt = 1): Promise<void> {
    if (job === undefined) return;
    if (job.kind === 'pull') return this.pull.effect(job.operation, job.prepared, attempt);
    if (job.kind === 'import') return this.imports.effect(job.operation, job.prepared, attempt);

    let outcome: Outcome;

    try {
      outcome = await this.push(job);
    } catch (error) {
      const failure = this.classify(error, attempt);

      if (failure instanceof RetryableFailure) throw failure;
      outcome = failure;
      if (outcome.reason === 'git-failed') {
        this.logger.warn(`push ${job.operation.id} failed: ${(error as Error).message}`);
      }
    }

    await this.settle(job, outcome);
  }

  /** The bundle and the token in a tenant scope, then git alone in a temp directory. */
  private async push({ head, link, operation }: PushJob): Promise<Outcome> {
    const { orgId, projectId } = operation;
    const ref = { orgId, projectId };
    const ctx: MutationContext = { leaseEpoch: 0, operationId: `push/${operation.id}` };
    const scope = { orgId, userId: null };
    // Its own short transaction: the mint locks the connection row, which every token call in the
    // organisation needs, and the bundle below can take a while.
    const token = await this.transactions.runInTenantScope(scope, async (tx) => {
      try {
        return await this.connections.repositoryToken(tx, orgId, link.repoId);
      } catch (error) {
        // `needs-reauth`: the service already moved the connection; that write must commit.
        const reason = error instanceof ConflictError ? error.extensions.reason : undefined;

        if (reason === 'needs-reauth' || reason === 'repo-gone') return reason;
        throw error;
      }
    });

    if (typeof token === 'string') return { reason: token, state: 'failed' };

    // Spec 044: every auto push now races the mirror to `git bundle create`, which takes a lockfile
    // and fails the loser. The lock serialises the two, and usually hands the mirror back as current.
    const bundle = await this.transactions.runInTenantScope(scope, async (tx) => {
      await this.checkpoints.lockProject(tx, ref);

      return this.bundler.current(tx, ref, ctx);
    });
    const repository = await this.resolve(link, token);

    if (repository === null) return { reason: 'repo-gone', state: 'failed' };

    const remote = this.git.remoteUrl(repository.owner, repository.name);
    const branch = `refs/heads/${link.branch}`;
    const auth = { auth: token };

    return this.git.withTempRepo(operation.id, async (dir) => {
      const bundlePath = join(dir, 'head.bundle');
      const cwd = join(dir, 'repo');

      await writeFile(bundlePath, bundle.body);
      await this.git.run(['clone', '--quiet', '--bare', bundlePath, cwd], { cwd: dir });

      const remoteHead = await this.remoteSha(cwd, remote, branch, auth);

      if (remoteHead !== null) {
        await this.git.run(
          ['fetch', '--quiet', remote, `+${branch}:refs/remotes/origin/${link.branch}`],
          {
            cwd,
            ...auth,
          },
        );
      }

      const ancestor =
        remoteHead !== null && remoteHead !== head.gitSha
          ? await this.git.isAncestor(cwd, remoteHead, head.gitSha)
          : false;
      const decision = pushDecision({
        isAncestor: () => ancestor,
        localHead: head.gitSha,
        remoteHead,
      });
      const target: Target = { auth, cwd, head, link, remote, remoteHead };
      const auto = operation.trigger === 'auto' || link.autoSync;

      // SC-012: a remote already at the head (a relinked level project) is a success that adds nothing.
      if (decision === 'nothing-to-push') {
        return {
          commits: 0,
          fromSha: remoteHead,
          reason: null,
          remoteHead: head.gitSha,
          state: 'succeeded',
          targetBranch: link.branch,
          toSha: head.gitSha,
        };
      }

      if (decision !== 'push') {
        return auto
          ? this.pushSide(target, decision)
          : { reason: decision, remoteHead, state: 'failed' };
      }

      try {
        await this.git.run(['push', '--quiet', remote, `${head.gitSha}:${branch}`], {
          cwd,
          ...auth,
        });
      } catch (error) {
        const rejection = rejectionOf(error);

        if (rejection === undefined) throw error;

        // A commit may have landed since the check: the link records where the branch is now.
        const moved = await this.remoteSha(cwd, remote, branch, auth);

        return auto && (rejection === 'remote-ahead' || rejection === 'branch-protected')
          ? this.pushSide({ ...target, remoteHead: moved }, rejection)
          : { reason: rejection, remoteHead: moved, state: 'failed' };
      }

      const counted = await this.git.run(
        [
          'rev-list',
          '--count',
          remoteHead === null ? head.gitSha : `${remoteHead}..${head.gitSha}`,
        ],
        { cwd },
      );

      return {
        commits: Number(counted.stdout.trim()),
        fromSha: remoteHead,
        reason: null,
        remoteHead: head.gitSha,
        state: 'succeeded',
        targetBranch: link.branch,
        toSha: head.gitSha,
      };
    });
  }

  /** Decision 10: the id is the repository; owner and name are only what it is called today. */
  private async resolve(link: RepoLinkRecord, token: Plaintext): Promise<GithubRepository | null> {
    let repository: GithubRepository;

    try {
      repository = await this.github.repository(token, link.repoId);
    } catch (error) {
      if (error instanceof GithubApiError && error.category === 'not-found') return null;
      throw error;
    }

    if (repository.owner !== link.owner || repository.name !== link.name) {
      await this.transactions.runInTenantTransaction(link.orgId, (tx) =>
        this.links.setRepository(tx, link.orgId, link.id, repository),
      );
    }

    return repository;
  }

  /** `ls-remote` answers nothing for a branch that does not exist yet (an empty remote is fine). */
  private async remoteSha(
    cwd: string,
    remote: string,
    ref: string,
    auth: Target['auth'],
  ): Promise<string | null> {
    const listed = await this.git.run(['ls-remote', remote, ref], { cwd, ...auth });
    const [first] = listed.stdout.trim().split(/\s+/);

    return first === undefined || first === '' ? null : first;
  }

  /**
   * Decision 4: the linked branch refused an automatic push, for `reason`. The head goes to
   * `kido-sync` by fast-forward or not at all, and a side branch someone else moved is `diverged`.
   * The linked branch being `kido-sync` leaves nowhere to go.
   */
  private async pushSide(
    { auth, cwd, head, link, remote, remoteHead }: Target,
    reason: SyncFailureReason,
  ): Promise<Outcome> {
    if (link.branch === SIDE_BRANCH) return { reason, remoteHead, state: 'failed' };

    const ref = `refs/heads/${SIDE_BRANCH}`;
    const side = await this.remoteSha(cwd, remote, ref, auth);

    if (side !== null && side !== head.gitSha) {
      await this.git.run(
        ['fetch', '--quiet', remote, `+${ref}:refs/remotes/origin/${SIDE_BRANCH}`],
        {
          cwd,
          ...auth,
        },
      );

      if (!(await this.git.isAncestor(cwd, side, head.gitSha))) {
        return { reason: 'diverged', remoteHead, state: 'failed' };
      }
    }

    if (side !== head.gitSha) {
      try {
        await this.git.run(['push', '--quiet', remote, `${head.gitSha}:${ref}`], { cwd, ...auth });
      } catch (error) {
        const rejection = rejectionOf(error);

        if (rejection === undefined) throw error;

        // Past the check above, a fast-forward refused means the side branch just moved.
        return {
          reason: rejection === 'remote-ahead' ? 'diverged' : rejection,
          remoteHead,
          state: 'failed',
        };
      }
    }

    // `--remotes` is what was fetched here: the linked branch and the side branch.
    const counted = await this.git.run(['rev-list', '--count', head.gitSha, '--not', '--remotes'], {
      cwd,
    });

    return {
      commits: Number(counted.stdout.trim()),
      fromSha: side,
      reason: null,
      remoteHead,
      state: 'succeeded',
      targetBranch: SIDE_BRANCH,
      toSha: head.gitSha,
    };
  }

  /** Transient → `RetryableFailure` while attempts remain; terminal → the row's reason. */
  private classify(error: unknown, attempt: number): Outcome | RetryableFailure {
    const last = attempt >= this.attempts;

    if (error instanceof RetryableFailure) {
      return last ? { reason: 'provider-unavailable', state: 'failed' } : error;
    }
    if (error instanceof ServiceUnavailableError) {
      return last
        ? { reason: 'provider-unavailable', state: 'failed' }
        : new RetryableFailure('upstream-5xx', error);
    }
    if (
      error instanceof GithubApiError &&
      (error.category === 'rate-limited' || error.category === 'unavailable')
    ) {
      return last
        ? { reason: 'provider-unavailable', state: 'failed' }
        : new RetryableFailure(
            error.category === 'rate-limited' ? 'throttled' : 'upstream-5xx',
            error,
          );
    }
    if (error instanceof LocalGitError && error.reason === 'timed-out') {
      return last
        ? { reason: 'timed-out', state: 'failed' }
        : new RetryableFailure('timeout', error);
    }

    return { reason: 'git-failed', state: 'failed' };
  }

  /** One tenant transaction: the row, the link's pointers, and the trailing edge (decision 3). */
  private async settle({ head, link, operation }: PushJob, outcome: Outcome): Promise<void> {
    const { orgId, projectId } = operation;
    const ref = { orgId, projectId };
    const { remoteHead, ...done } = outcome;

    await this.transactions.runInTenantTransaction(orgId, async (tx) => {
      const closed = await this.operations.markDone(tx, orgId, operation.id, {
        ...done,
        finishedAt: this.clock.now(),
      });

      if (closed === 0) {
        this.logger.warn(`push ${operation.id} was closed by the sweep; the link is left alone`);

        return;
      }

      const moved = (await this.links.forProject(tx, orgId, projectId))?.branch !== link.branch;

      if (moved) {
        this.logger.warn(
          `push ${operation.id} finished after a branch switch; pointers left alone`,
        );
      } else if (outcome.state === 'succeeded' && outcome.targetBranch === link.branch) {
        await this.links.setPushed(tx, orgId, link.id, head.id, head.gitSha);
        await this.links.setSideBranch(tx, orgId, link.id, null);
      } else if (outcome.state === 'succeeded') {
        // The linked branch has not moved: the head is not pushed, it is waiting on the side.
        await this.links.setSideBranch(tx, orgId, link.id, SIDE_BRANCH);
        await this.links.setRemoteHead(tx, orgId, link.id, remoteHead ?? null);
      } else if (remoteHead !== undefined) {
        await this.links.setRemoteHead(tx, orgId, link.id, remoteHead);
      }

      // No follow-up for what only a person can repair; every other failure may not repeat.
      if (outcome.reason === 'needs-reauth' || outcome.reason === 'repo-gone') return;

      const current = await this.checkpoints.head(tx, ref);

      if (current !== null && current.id !== head.id) await this.syncs.requestAuto(tx, ref);
    });
  }
}
