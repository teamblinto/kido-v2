import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SyncFailureReason } from '@repo/contracts';
import { type Checkpoint, schema } from '@repo/db';
import { and, eq, isNotNull } from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { ConflictError, ServiceUnavailableError } from '../../common/errors/domain-error';
import type { TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { CheckpointService, GitStepError } from '../checkpoints/checkpoint.service';
import { gitFetchBundle, gitMergeFfOnly, gitRemoveFile } from '../checkpoints/git-commands';
import { RepoBundler } from '../checkpoints/repo-bundler';
import { RetryableFailure } from '../outbox/consumer';
import { OutboxWriter } from '../outbox/outbox-writer';
import { SANDBOX_LIFECYCLE, type SandboxLifecycle } from '../sandbox/sandbox-lifecycle';
import { SandboxGuardError } from '../sandbox/sandbox.errors';
import {
  type ExecResult,
  type MutationContext,
  SANDBOX_PORT,
  type SandboxPort,
} from '../sandbox/sandbox.port';
import { ConnectionService } from './connection.service';
import { LOCAL_GIT, type LocalGit, LocalGitError } from './local-git';
import type { PullRunner as PullRunnerPort } from './push.consumer';
import { type RepoLinkRecord, RepoLinkRepository } from './repo-link.repository';
import { type PullDecision, pullDecision } from './sync-guards';
import { type SyncRecord, SyncRepository } from './sync.repository';

/** Where the bundle lands in the sandbox — under `.git/`, the only place `upload` admits (R6). */
export const PULL_BUNDLE_PATH = '.git/forge-pull.bundle';
const ATTEMPTS = 3;

type Decided =
  | { readonly decision: PullDecision; readonly remoteHead: string | null }
  | {
      readonly body: Buffer;
      readonly decision: 'pull';
      readonly remoteHead: string;
      /** `<head>..<remote head>` oldest first, read in the temp clone before the sandbox moves. */
      readonly shas: readonly string[];
    };

export interface PullPrepared {
  readonly head: Checkpoint;
  readonly link: RepoLinkRecord;
}

interface Outcome {
  readonly commits?: number;
  readonly fromSha?: string | null;
  readonly reason: SyncFailureReason | null;
  readonly remoteHead?: string | null;
  /** The pulled shas oldest first — the rows `recordPulled` writes. */
  readonly shas?: readonly string[];
  readonly state: 'failed' | 'succeeded';
  readonly toSha?: string | null;
}

/**
 * The pull (spec 018 US3, research R6, R7), dispatched by `SyncConsumer` for `kind = 'pull'`.
 * `handle` runs on the consumer's transaction under the project's writer lock: a non-terminal run
 * refuses it (`run-active`, FR-026), otherwise the row goes `running`. `effect` fetches the remote
 * branch into a temp clone seeded from the R5 bundle, decides by `pullDecision` (`diverged` when
 * the local head is not an ancestor, `commits: 0` when level), bundles `<head>..origin/<branch>`,
 * uploads it and fast-forwards inside the sandbox under the project's writer lock, `activeRunExists`
 * re-checked there (a run that started after `handle` refuses the merge as `run-active`); then one
 * tenant transaction records a `pull` checkpoint per sha and moves the link's pointers.
 *
 * FR-028: `--ff-only` either lands whole or leaves HEAD where it was, and the rows are one
 * transaction; the shas are read in the temp clone, so after the merge only the settle remains. A
 * retry after a merge that landed finds the workspace already there and `recordPulled` lands on
 * the same rows by sha.
 */
@Injectable()
export class PullRunner implements PullRunnerPort<PullPrepared | undefined> {
  private readonly logger = new Logger(PullRunner.name);

  constructor(
    @Inject(SyncRepository) private readonly operations: SyncRepository,
    @Inject(RepoLinkRepository) private readonly links: RepoLinkRepository,
    @Inject(CheckpointService) private readonly checkpoints: CheckpointService,
    @Inject(RepoBundler) private readonly bundler: RepoBundler,
    @Inject(ConnectionService) private readonly connections: ConnectionService,
    @Inject(LOCAL_GIT) private readonly git: LocalGit,
    @Inject(SANDBOX_PORT) private readonly port: SandboxPort,
    @Inject(SANDBOX_LIFECYCLE) private readonly lifecycle: SandboxLifecycle,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
  ) {}

  async handle(tx: TenantTransaction, operation: SyncRecord): Promise<PullPrepared | undefined> {
    const { orgId, projectId } = operation;
    const ref = { orgId, projectId };

    await this.checkpoints.lockProject(tx, ref);
    const link = await this.links.forProject(tx, orgId, projectId);
    const head = await this.checkpoints.head(tx, ref);
    const reason: SyncFailureReason | null =
      link?.state !== 'linked' || head === null
        ? 'not-linked'
        : (await this.checkpoints.activeRunExists(tx, ref))
          ? 'run-active'
          : null;

    if (reason !== null) {
      await this.operations.markDone(tx, orgId, operation.id, {
        finishedAt: this.clock.now(),
        reason,
        state: 'failed',
      });

      return undefined;
    }

    await this.operations.markRunning(tx, orgId, operation.id, this.clock.now());

    return { head: head!, link: link! };
  }

  async effect(
    operation: SyncRecord,
    prepared: PullPrepared | undefined,
    attempt: number,
  ): Promise<void> {
    if (prepared === undefined) return;

    let outcome: Outcome;

    try {
      outcome = await this.pull(operation, prepared);
    } catch (error) {
      const failure = this.classify(error, attempt);

      if (failure instanceof RetryableFailure) throw failure;
      outcome = failure;
      if (outcome.reason === 'git-failed') {
        this.logger.warn(`pull ${operation.id} failed: ${(error as Error).message}`);
      }
    }

    await this.settle(operation, prepared, outcome);
  }

  private async pull(operation: SyncRecord, { head, link }: PullPrepared): Promise<Outcome> {
    const { orgId, projectId } = operation;
    const ref = { orgId, projectId };
    const ctx: MutationContext = { leaseEpoch: 0, operationId: `pull/${operation.id}` };
    const source = await this.transactions.runInTenantScope({ orgId, userId: null }, async (tx) => {
      const bundle = await this.bundler.current(tx, ref, ctx);

      try {
        return { bundle, token: await this.connections.repositoryToken(tx, orgId, link.repoId) };
      } catch (error) {
        const reason = error instanceof ConflictError ? error.extensions.reason : undefined;

        if (reason === 'needs-reauth' || reason === 'repo-gone') return reason;
        throw error;
      }
    });

    if (typeof source === 'string') return { reason: source, state: 'failed' };

    const remote = this.git.remoteUrl(link.owner, link.name);
    const branch = `refs/heads/${link.branch}`;
    const tracking = `refs/remotes/origin/${link.branch}`;
    const auth = { auth: source.token };

    const decided = await this.git.withTempRepo(operation.id, async (dir): Promise<Decided> => {
      const bundlePath = join(dir, 'head.bundle');
      const cwd = join(dir, 'repo');

      await writeFile(bundlePath, source.bundle.body);
      await this.git.run(['clone', '--quiet', '--bare', bundlePath, cwd], { cwd: dir });

      const listed = await this.git.run(['ls-remote', remote, branch], { cwd, ...auth });
      const [first] = listed.stdout.trim().split(/\s+/);
      const remoteHead = first === undefined || first === '' ? null : first;

      if (remoteHead !== null) {
        await this.git.run(['fetch', '--quiet', remote, `+${branch}:${tracking}`], {
          cwd,
          ...auth,
        });
      }

      const ancestor =
        remoteHead !== null && remoteHead !== head.gitSha
          ? await this.git.isAncestor(cwd, head.gitSha, remoteHead)
          : false;
      const decision = pullDecision({
        isAncestor: () => ancestor,
        localHead: head.gitSha,
        remoteHead,
      });

      // `pullDecision` is 'level' for a missing remote branch, so `pull` always has a head.
      if (decision !== 'pull' || remoteHead === null) return { decision, remoteHead };

      // A bundle carries refs, not bare shas, and the sandbox's `git fetch <bundle>` takes HEAD:
      // the clone's HEAD is pointed at the tracking ref so the bundle names the remote head HEAD.
      const pullBundle = join(dir, 'pull.bundle');

      await this.git.run(['symbolic-ref', 'HEAD', tracking], { cwd });
      await this.git.run(['bundle', 'create', pullBundle, `${head.gitSha}..HEAD`], { cwd });
      const shas = await this.git.run(['rev-list', '--reverse', `${head.gitSha}..HEAD`], { cwd });

      return {
        body: await readFile(pullBundle),
        decision,
        remoteHead,
        shas: shas.stdout.split('\n').filter((line) => line !== ''),
      };
    });

    if (decided.decision === 'diverged') {
      return { reason: 'diverged', remoteHead: decided.remoteHead, state: 'failed' };
    }
    if (!('body' in decided)) {
      return {
        commits: 0,
        fromSha: head.gitSha,
        reason: null,
        remoteHead: decided.remoteHead,
        state: 'succeeded',
        toSha: head.gitSha,
      };
    }

    // The port resolves the sandbox through the tenant context, so the steps share one scope. The
    // writer lock is held from the re-check to the merge, as the mirror holds it to the PUT: a run
    // that started after `handle` is refused here, and none starts while the workspace moves.
    const merged = await this.transactions.runInTenantScope({ orgId, userId: null }, async (tx) => {
      await this.checkpoints.lockProject(tx, ref);
      if (await this.checkpoints.activeRunExists(tx, ref)) return false;

      const readiness = await this.lifecycle.ensureReady(tx, ref, ctx);

      if (!readiness.ready) throw new RetryableFailure('timeout');

      await this.port.upload(ref, PULL_BUNDLE_PATH, decided.body, ctx);
      await this.exec(ref, gitFetchBundle(PULL_BUNDLE_PATH), ctx);
      await this.exec(ref, gitMergeFfOnly(), ctx);
      // The merge landed: a bundle left behind is not a failed pull (FR-028).
      await this.exec(ref, gitRemoveFile(PULL_BUNDLE_PATH), ctx).catch((error: unknown) => {
        this.logger.warn(`pull ${operation.id}: ${(error as Error).message}`);
      });

      return true;
    });

    if (!merged) return { reason: 'run-active', remoteHead: decided.remoteHead, state: 'failed' };

    return {
      commits: decided.shas.length,
      fromSha: head.gitSha,
      reason: null,
      remoteHead: decided.remoteHead,
      shas: decided.shas,
      state: 'succeeded',
      toSha: decided.remoteHead,
    };
  }

  private async exec(
    ref: { orgId: string; projectId: string },
    command: string,
    ctx: MutationContext,
  ): Promise<string> {
    const result: ExecResult = await this.port.exec(ref, command, ctx);

    if (result.timedOut) throw new GitStepError(`\`${command}\` timed out.`);
    if (result.exitCode !== 0) {
      throw new GitStepError(
        `\`${command}\` exited ${String(result.exitCode)}: ${result.output.trim()}`,
      );
    }
    if (result.truncated) throw new GitStepError(`\`${command}\` output was truncated.`);

    return result.output;
  }

  /** Transient → `RetryableFailure` while attempts remain; terminal → the row's reason. */
  private classify(error: unknown, attempt: number): Outcome | RetryableFailure {
    const last = attempt >= ATTEMPTS;

    if (error instanceof RetryableFailure) {
      return last
        ? {
            reason: error.reason === 'timeout' ? 'timed-out' : 'provider-unavailable',
            state: 'failed',
          }
        : error;
    }
    if (error instanceof ServiceUnavailableError) {
      return last
        ? { reason: 'provider-unavailable', state: 'failed' }
        : new RetryableFailure('upstream-5xx', error);
    }
    if (error instanceof LocalGitError && error.reason === 'timed-out') {
      return last
        ? { reason: 'timed-out', state: 'failed' }
        : new RetryableFailure('timeout', error);
    }
    if (error instanceof SandboxGuardError && error.kind === 'bundle-too-large') {
      return { reason: 'bundle-too-large', state: 'failed' };
    }

    return { reason: 'git-failed', state: 'failed' };
  }

  /** One tenant transaction: the close (an open row only), then the pulled rows and the link's pointers. */
  private async settle(
    operation: SyncRecord,
    { head, link }: PullPrepared,
    outcome: Outcome,
  ): Promise<void> {
    const { orgId, projectId } = operation;
    const ref = { orgId, projectId };
    const ctx: MutationContext = { leaseEpoch: 0, operationId: `pull/${operation.id}` };
    const { remoteHead, shas, ...done } = outcome;

    await this.transactions.runInTenantScope({ orgId, userId: null }, async (tx) => {
      const closed = await this.operations.markDone(tx, orgId, operation.id, {
        ...done,
        finishedAt: this.clock.now(),
      });

      if (closed === 0) {
        this.logger.warn(`pull ${operation.id} was closed by the sweep; the link is left alone`);

        return;
      }

      if (shas !== undefined && shas.length > 0) {
        const rows = await this.checkpoints.recordPulled(
          ref,
          ctx,
          operation.requestedBy,
          operation.id,
          shas,
          tx,
        );
        await this.links.setPushed(tx, orgId, link.id, rows.at(-1)!.id, remoteHead!);

        // Spec 047: pulled commits can change the dependencies or the dev server itself. A project
        // with a run profile restarts it; the supervisor reinstalls only if the manifests changed.
        const [profiled] = await tx
          .select({ id: schema.projects.id })
          .from(schema.projects)
          .where(and(eq(schema.projects.id, projectId), isNotNull(schema.projects.runConfig)));
        if (profiled !== undefined) {
          await this.outbox.append(tx, {
            aggregateId: projectId,
            orgId,
            payload: { orgId, projectId },
            type: 'project.env.changed',
          });
        }
      } else if (outcome.state === 'succeeded' && remoteHead !== null) {
        // `null`: there was no remote branch to be level with, so nothing was pushed.
        await this.links.setPushed(tx, orgId, link.id, head.id, head.gitSha);
      } else if (remoteHead !== undefined) {
        await this.links.setRemoteHead(tx, orgId, link.id, remoteHead);
      }

      // Spec 044: the project caught up with the linked branch, so nothing waits on the side. A
      // head that moved during the pull found the slot taken; the reconcile tick carries it.
      if (outcome.state === 'succeeded') {
        await this.links.setSideBranch(tx, orgId, link.id, null);
      }
    });
  }
}
