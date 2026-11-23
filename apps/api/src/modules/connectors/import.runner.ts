import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ProjectTemplate, RunConfig, SyncFailureReason } from '@repo/contracts';
import { schema } from '@repo/db';
import { eq, sql } from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { ConflictError, ServiceUnavailableError } from '../../common/errors/domain-error';
import type { TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { AuditService } from '../audit/audit.service';
import { CheckpointService, GitStepError } from '../checkpoints/checkpoint.service';
import { RetryableFailure } from '../outbox/consumer';
import { OutboxWriter } from '../outbox/outbox-writer';
import { SANDBOX_LIFECYCLE, type SandboxLifecycle } from '../sandbox/sandbox-lifecycle';
import { DEFAULT_DAYTONA_TIMINGS } from '../sandbox/sandbox.constants';
import { type SandboxGuardKind, SandboxGuardError } from '../sandbox/sandbox.errors';
import {
  type ExecResult,
  type MutationContext,
  SANDBOX_PORT,
  type SandboxPort,
} from '../sandbox/sandbox.port';
import { TemplateCatalogue } from '../sandbox/template-catalogue';
import { ConnectionService } from './connection.service';
import { ImportService } from './import.service';
import { LOCAL_GIT, type LocalGit, LocalGitError } from './local-git';
import type { PullRunner as PullRunnerPort } from './push.consumer';
import { type RepoLinkRecord, RepoLinkRepository } from './repo-link.repository';
import { snapshotDirectory } from './repo-snapshot';
import { detectRunConfig } from './stack-detector';
import { type SyncRecord, SyncRepository } from './sync.repository';

/** R4: the bundle lands under `.git/`, the only path `SandboxPort.upload` admits — as the pull's. */
export const IMPORT_BUNDLE_PATH = '.git/forge-import.bundle';

/** The seam `SyncConsumer` dispatches `kind = 'import'` to, as `PULL_RUNNER` is the pull's. */
export const IMPORT_RUNNER = Symbol('forge.connectors.importRunner');

const ATTEMPTS = 3;

/** A path or ref this module is willing to put in a command string: no space, quote or operator. */
const SAFE = /^[\w][\w./-]*$/;

const safe = (value: string): string => {
  if (!SAFE.test(value) || value.includes('..'))
    throw new GitStepError(`Unsafe argument: ${value}`);

  return value;
};

/**
 * FR-020's "cannot be represented": the jail's answers about one path. They are not "git failed"
 * — the clone succeeded and the workspace refused a file in it — so they carry this feature's own
 * `import-checkout-failed` and the path that caused it.
 */
const UNREPRESENTABLE: ReadonlySet<SandboxGuardKind> = new Set([
  'not-a-file',
  'path-escape',
  'path-not-found',
  'path-outside-git',
]);

/** The path a guard named, when it named one. */
const pathOf = (error: SandboxGuardError): string | null =>
  typeof error.extensions.path === 'string' ? error.extensions.path : null;

export interface ImportPrepared {
  readonly link: RepoLinkRecord;
  /**
   * Spec 047: no template was chosen, so the run profile is detected from the clone and the
   * workspace is cleaned to exactly the repository before its own dependencies are installed.
   */
  readonly smart: boolean;
  /** The starter files spec 015's definition owns — the only files the import removes (R5). */
  readonly starterFiles: readonly string[];
  readonly workspaceId: string;
}

interface Outcome {
  readonly commits?: number;
  /** FR-020: the file the sandbox could not represent, when that is what failed. */
  readonly path?: string | null;
  readonly reason: SyncFailureReason | null;
  readonly state: 'failed' | 'succeeded';
  readonly toSha?: string | null;
  /** Spec 047: the detected run profile, for a smart import that succeeded. */
  readonly runConfig?: RunConfig | null;
}

/**
 * The import's work (spec 026 US1, research R4, R5), dispatched by `SyncConsumer` for
 * `kind = 'import'`.
 *
 * It is the pull's mechanism with the merge replaced by a checkout, and it is deliberately not a
 * second implementation of it: `ConnectionService.repositoryToken` mints a token scoped to the one
 * repository, `LocalGit.withTempRepo` gives a temp directory, `git clone --single-branch --branch` then
 * `git bundle create` produces one file, and the bundle — never the token — is uploaded to the
 * sandbox. Reusing the pull's shape is what inherits the no-credential-in-sandbox rule, the upload
 * cap and the `bundle-too-large` reason rather than rewriting them.
 *
 * Inside the sandbox the clone goes **over** the prepared dependency layer (R5). The only files
 * removed are the ones the chosen template's definition owns — the same list `templateDigest` is
 * computed over — so `node_modules` and everything else the warm pool installed survives, and no
 * starter file the user did not write can reach their first push (FR-018).
 *
 * The result is recorded as data-model § 4 specifies: one `baseline` checkpoint at the cloned sha
 * with `sync_operation_id` set and `actor_id` null, the link's two positions both at that commit —
 * so the project is level and spec 018's push and pull work on it with no new code — and the
 * operation `succeeded` with `commits: 1`. A failure withdraws the project (R2: soft delete, which
 * releases the sandbox through spec 014's `project.archived`) and leaves the operation readable.
 */
@Injectable()
export class ImportRunner implements PullRunnerPort<ImportPrepared | undefined> {
  private readonly logger = new Logger(ImportRunner.name);

  constructor(
    @Inject(SyncRepository) private readonly operations: SyncRepository,
    @Inject(RepoLinkRepository) private readonly links: RepoLinkRepository,
    @Inject(CheckpointService) private readonly checkpoints: CheckpointService,
    @Inject(ConnectionService) private readonly connections: ConnectionService,
    @Inject(TemplateCatalogue) private readonly templates: TemplateCatalogue,
    @Inject(ImportService) private readonly imports: ImportService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(LOCAL_GIT) private readonly git: LocalGit,
    @Inject(SANDBOX_PORT) private readonly port: SandboxPort,
    @Inject(SANDBOX_LIFECYCLE) private readonly lifecycle: SandboxLifecycle,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
  ) {}

  /** On the consumer's transaction, under the project's writer lock: the row goes `running`. */
  async handle(tx: TenantTransaction, operation: SyncRecord): Promise<ImportPrepared | undefined> {
    const { orgId, projectId } = operation;
    const ref = { orgId, projectId };

    await this.checkpoints.lockProject(tx, ref);
    const link = await this.links.forProject(tx, orgId, projectId);
    const project = await this.links.project(tx, orgId, projectId);

    // The service wrote both in the transaction that wrote this row; either gone is a project
    // somebody withdrew between the request and the worker, and there is nothing left to import.
    if (link?.state !== 'linked' || project === undefined) {
      await this.operations.markDone(tx, orgId, operation.id, {
        finishedAt: this.clock.now(),
        reason: 'not-linked',
        state: 'failed',
      });

      return undefined;
    }

    const [row] = await tx
      .select({ template: sql<ProjectTemplate | null>`${schema.projects.template}` })
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId));

    await this.operations.markRunning(tx, orgId, operation.id, this.clock.now());

    return {
      link,
      smart: row?.template == null,
      starterFiles:
        row?.template == null ? [] : this.templates.get(row.template).files.map((f) => f.path),
      workspaceId: project.workspaceId,
    };
  }

  async effect(
    operation: SyncRecord,
    prepared: ImportPrepared | undefined,
    attempt: number,
  ): Promise<void> {
    if (prepared === undefined) return;

    let outcome: Outcome;

    try {
      outcome = await this.run(operation, prepared);
    } catch (error) {
      const failure = this.classify(error, attempt);

      if (failure instanceof RetryableFailure) throw failure;
      outcome = failure;
      this.logger.warn(`import ${operation.id} failed: ${(error as Error).message}`);
    }

    await this.settle(operation, prepared, outcome);
  }

  /** T031: the clone and bundle on the worker, then the sandbox leg. No token ever crosses. */
  private async run(operation: SyncRecord, prepared: ImportPrepared): Promise<Outcome> {
    const { orgId, projectId } = operation;
    const ref = { orgId, projectId };
    const { link } = prepared;
    const ctx: MutationContext = { leaseEpoch: 0, operationId: `import/${operation.id}` };
    const token = await this.transactions.runInTenantScope({ orgId, userId: null }, async (tx) => {
      try {
        return await this.connections.repositoryToken(tx, orgId, link.repoId);
      } catch (error) {
        // The service already moved the connection to `needs_reauth`; that write must commit.
        if (error instanceof ConflictError && error.extensions.reason === 'needs-reauth') {
          return null;
        }
        throw error;
      }
    });

    if (token === null) return { reason: 'needs-reauth', state: 'failed' };

    const remote = this.git.remoteUrl(link.owner, link.name);
    const cloned = await this.git.withTempRepo(operation.id, async (dir) => {
      const cwd = join(dir, 'repo');
      const bundlePath = join(dir, 'import.bundle');

      // The branch's whole history, never `--depth`: a bundle made from a shallow clone names a
      // parent it does not carry, and the sandbox's repository — not shallow — refuses it ("did not
      // send all necessary objects"), so every repository with a second commit failed to import.
      // The history is also what later pulls and pushes measure ancestry against. One branch and
      // no tags keep it to what the project is; a bundle over the upload cap still fails as
      // `bundle-too-large`, naming the bundle's path (`classify`).
      await this.git.run(
        ['clone', '--quiet', '--single-branch', '--no-tags', '--branch', link.branch, remote, cwd],
        { auth: token, cwd: dir },
      );
      // The bundle names the head HEAD, which is the ref the sandbox's `git fetch <bundle>` takes.
      await this.git.run(['bundle', 'create', bundlePath, 'HEAD'], { cwd });
      const head = await this.git.run(['rev-parse', 'HEAD'], { cwd });
      // Spec 047: detection reads the clone that is already here, so it sees the whole tree and
      // costs no GitHub call. Pure and bounded (`repo-snapshot.ts`); it never throws on content.
      const runConfig = prepared.smart ? detectRunConfig(snapshotDirectory(cwd)) : null;

      // A bundle the sandbox will refuse is refused here, from its size, before it is read into
      // memory: full history makes a large one likelier, and the upload cap would only reject it
      // after the whole file sat in the worker's heap. Same reason, same path, as the port's own.
      const { size } = await stat(bundlePath);
      if (size > DEFAULT_DAYTONA_TIMINGS.bundleCapBytes) {
        throw new SandboxGuardError('bundle-too-large', 'The repository is too large to import.', {
          path: IMPORT_BUNDLE_PATH,
        });
      }

      return { body: await readFile(bundlePath), runConfig, sha: head.stdout.trim() };
    });

    // A new project's first `ensureReady` claims a warm-pool sandbox, and that claim is a row
    // delete in the transaction it runs in. It commits on its own, before the sandbox is touched:
    // in the steps' transaction, a failed step rolled the claim back and put the half-imported
    // container back in the pool as `ready`, for the next project to inherit. Committed, a failure
    // withdraws the project and the release destroys the container, as the agent's pre-flight does.
    const readiness = await this.transactions.runInTenantScope({ orgId, userId: null }, (tx) =>
      this.lifecycle.ensureReady(tx, ref, ctx),
    );

    if (!readiness.ready) throw new RetryableFailure('timeout');

    // The port resolves the sandbox through the tenant context, so every step shares one scope.
    await this.transactions.runInTenantScope({ orgId, userId: null }, async () => {
      const probe = await this.port.exec(ref, 'git rev-parse --git-dir', ctx);

      if (probe.timedOut || probe.exitCode !== 0) {
        await this.exec(ref, 'git init -q', ctx);
      }

      // FR-020: a bundle the port will not take is a failure about **this** path, and the guard
      // that refuses it (`bundle-too-large`) carries a size rather than a name. The path is put
      // on the error here, where it is known, so `classify` can hand it to the trail.
      await this.port.upload(ref, IMPORT_BUNDLE_PATH, cloned.body, ctx).catch((error: unknown) => {
        throw error instanceof SandboxGuardError
          ? new SandboxGuardError(error.kind, error.detail, {
              ...error.extensions,
              path: IMPORT_BUNDLE_PATH,
            })
          : error;
      });
      await this.exec(ref, `git fetch -q ${IMPORT_BUNDLE_PATH}`, ctx);
      // R5: only the template definition's own files go. The prepared layer — `node_modules` and
      // everything else the warm pool installed — was never in that list and stays.
      //
      // FR-020 fixes the position: the workspace is not touched until the bundle is in it and
      // fetched. A clone the sandbox cannot represent — a path the jail refuses, a bundle over the
      // port's cap — fails before the first removal, so the workspace is left exactly as it was.
      if (prepared.starterFiles.length > 0) {
        await this.exec(ref, `rm -f ${prepared.starterFiles.map(safe).join(' ')}`, ctx);
      }
      await this.exec(ref, 'git checkout -f FETCH_HEAD', ctx);
      // Spec 047: a smart import keeps nothing of the pool image — no starter file and no
      // `node_modules` the repository did not ask for. Its own install starts from a clean tree.
      if (prepared.smart) await this.exec(ref, 'git clean -ffdxq', ctx);
      await this.exec(ref, `git branch -f ${safe(link.branch)} FETCH_HEAD`, ctx);
      await this.exec(ref, `git symbolic-ref HEAD refs/heads/${safe(link.branch)}`, ctx);
      // The checkout landed: a bundle left behind is not a failed import.
      await this.exec(ref, `rm -f ${IMPORT_BUNDLE_PATH}`, ctx).catch((error: unknown) => {
        this.logger.warn(`import ${operation.id}: ${(error as Error).message}`);
      });
    });

    return {
      commits: 1,
      reason: null,
      runConfig: cloned.runConfig,
      state: 'succeeded',
      toSha: cloned.sha,
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
    if (error instanceof SandboxGuardError) {
      // T071: spec 018's vocabulary first, and a new reason only where it says nothing. A bundle
      // or a file over the port's cap is exactly what `bundle-too-large` already means, and the
      // jail's path refusals are FR-020's "cannot be represented" — both name the path (FR-020).
      const path = pathOf(error);

      if (error.kind === 'bundle-too-large' || error.kind === 'file-too-large') {
        return { path, reason: 'bundle-too-large', state: 'failed' };
      }
      if (UNREPRESENTABLE.has(error.kind)) {
        return { path, reason: 'import-checkout-failed', state: 'failed' };
      }
      // The workspace is not there yet. `ensureReady` already waited; this is the same "not ready"
      // answer arriving from a step, so it retries and ends as spec 018's `timed-out`.
      return last
        ? { reason: 'timed-out', state: 'failed' }
        : new RetryableFailure('timeout', error);
    }
    // A step inside the sandbox is the one failure this feature names for itself: the clone
    // reached the worker and the workspace refused it, which is not "git failed" in general.
    if (error instanceof GitStepError) {
      return { reason: 'import-checkout-failed', state: 'failed' };
    }

    // Everything left is the worker's own git — the clone, the bundle, the rev-parse — which is
    // spec 018's `git-failed` and needs no reason of this feature's own.
    return { reason: 'git-failed', state: 'failed' };
  }

  /**
   * T032, one tenant transaction: the operation closes, and on success the baseline checkpoint at
   * the cloned sha and the link's two positions land with it. On failure the project is withdrawn
   * (R2) and the operation keeps its reason, so the user can read why.
   */
  private async settle(
    operation: SyncRecord,
    prepared: ImportPrepared,
    outcome: Outcome,
  ): Promise<void> {
    const { orgId, projectId, requestedBy } = operation;
    const ref = { orgId, projectId };
    const ctx: MutationContext = { leaseEpoch: 0, operationId: `import/${operation.id}` };

    // FR-007 / R2: every failure leaves by the one cleanup path, which is idempotent because a
    // retry can meet a half-cleaned attempt (T070).
    if (outcome.state === 'failed') {
      await this.transactions.runInTenantScope({ orgId, userId: requestedBy }, (tx) =>
        this.imports.withdraw(tx, {
          actorId: requestedBy,
          branch: prepared.link.branch,
          finishedAt: this.clock.now(),
          linkId: prepared.link.id,
          operationId: operation.id,
          orgId,
          path: outcome.path ?? null,
          projectId,
          reason: outcome.reason!,
          repository: `${prepared.link.owner}/${prepared.link.name}`,
        }),
      );

      return;
    }

    await this.transactions.runInTenantScope({ orgId, userId: requestedBy }, async (tx) => {
      const closed = await this.operations.markDone(tx, orgId, operation.id, {
        commits: outcome.commits,
        reason: outcome.reason,
        state: outcome.state,
        toSha: outcome.toSha,
        finishedAt: this.clock.now(),
      });

      if (closed === 0) {
        this.logger.warn(`import ${operation.id} was closed by the sweep; nothing else is written`);

        return;
      }

      const checkpoint = await this.checkpoints.recordImported(
        ref,
        ctx,
        operation.id,
        outcome.toSha!,
        tx,
      );

      // Both positions at the cloned commit: the project is level, and the first push after an
      // import reports nothing to push without a line of code on the push's path (SC-003).
      await this.links.setPushed(tx, orgId, prepared.link.id, checkpoint.id, outcome.toSha!);

      // Spec 047: the detected profile lands with the import, and `project.env.changed` delivers it
      // to the running sandbox — install, then the dev server — through the path spec 030 already
      // uses to restart one. Naming is asked for now that the repository is in the workspace.
      if (outcome.runConfig !== undefined && outcome.runConfig !== null) {
        await tx
          .update(schema.projects)
          .set({ runConfig: outcome.runConfig, updatedAt: this.clock.now() })
          .where(eq(schema.projects.id, projectId));
        await this.audit.record(tx, {
          action: 'project.run-config-changed',
          actorId: requestedBy,
          metadata: {
            dev: outcome.runConfig.dev,
            install: outcome.runConfig.install,
            port: outcome.runConfig.port,
            root: outcome.runConfig.root,
            source: 'detected',
            stack: outcome.runConfig.stack,
          },
          orgId,
          target: projectId,
        });
        await this.outbox.append(tx, {
          aggregateId: projectId,
          orgId,
          payload: { orgId, projectId },
          type: 'project.env.changed',
        });
      }
      await this.outbox.append(tx, {
        aggregateId: projectId,
        orgId,
        payload: { orgId, projectId },
        type: 'project.naming.requested',
      });
      await this.audit.record(tx, {
        action: 'import.succeeded',
        actorId: requestedBy,
        metadata: {
          branch: prepared.link.branch,
          repository: `${prepared.link.owner}/${prepared.link.name}`,
          sha: outcome.toSha,
          syncOperationId: operation.id,
        },
        orgId,
        target: projectId,
      });
    });
  }
}
