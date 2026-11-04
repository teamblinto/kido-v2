import { Inject, Injectable } from '@nestjs/common';
import type { Checkpoint, CheckpointFile, NewCheckpoint } from '@repo/db';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from '../../common/errors/domain-error';
import type { TenantTransaction } from '../../database/database.types';
import { AuditService } from '../audit/audit.service';
import { OutboxWriter } from '../outbox/outbox-writer';
import {
  type ExecResult,
  type MutationContext,
  SANDBOX_PORT,
  type SandboxPort,
  type SandboxRef,
} from '../sandbox/sandbox.port';
import { SANDBOX_LIFECYCLE, type SandboxLifecycle } from '../sandbox/sandbox-lifecycle';
import { type CheckpointPage, CheckpointRepository } from './checkpoint.repository';
import {
  type DiffFile,
  filesLabel,
  gitAdd,
  gitCommit,
  gitDiff,
  gitDiffQuiet,
  gitDiffTree,
  gitGitDir,
  gitInit,
  gitLogSubject,
  gitLsTree,
  gitReadTree,
  gitRevParse,
  gitStatus,
  isClean,
  parseLsTree,
  parseNameStatus,
  parseSha,
  sanitiseLabel,
  splitDiff,
  turnLabel,
} from './git-commands';

/** A binary row carries its size at the checkpoint (contracts § 1); a text row its patch. */
export type CheckpointDiffFile =
  | Extract<DiffFile, { binary: false }>
  | (Extract<DiffFile, { binary: true }> & { readonly bytes: number });

export interface CheckpointDiff {
  readonly checkpointId: string;
  readonly files: CheckpointDiffFile[];
  readonly parentId: string | null;
}

/** How long a caller waits before asking again while the sandbox resumes (R7). */
const WAKING_RETRY_AFTER_SECONDS = 5;

/**
 * What every workspace ignores (R10, FR-026): build output and env files. A scaffold without a
 * `.gitignore` gets these; one with its own gains the rules it lacks.
 */
const DEFAULT_GITIGNORE = ['node_modules/', 'dist/', '.next/', '__pycache__/', '.venv/', '.env*'];

/**
 * A git step answered on its own terms — a non-zero exit, a timeout, a clipped output — as
 * opposed to the port failing to reach the sandbox (`DaytonaError`) or the database failing the
 * insert. The executor fails the run as `checkpoint` on this, like on the port's errors (§ 4).
 */
export class GitStepError extends Error {
  readonly kind = 'git-step';

  constructor(message: string) {
    super(message);
    this.name = 'GitStepError';
  }
}

/**
 * The checkpoint flow of spec 016 (research R5, R7): every git step is one `exec` on the port,
 * the row and its `checkpoint.created` land in the caller's transaction after the commit exists.
 */
@Injectable()
export class CheckpointService {
  constructor(
    @Inject(SANDBOX_PORT) private readonly port: SandboxPort,
    @Inject(SANDBOX_LIFECYCLE) private readonly lifecycle: SandboxLifecycle,
    @Inject(CheckpointRepository) private readonly repository: CheckpointRepository,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  /**
   * The executor's pre-flight (US4, R10): a workspace without `.git` is initialised, given the
   * default `.gitignore` if the scaffold has none, and committed as the template's baseline; one
   * with `.git` but no row (pre-feature) is committed "as found"; one with both is left alone.
   */
  async ensureRepository(
    ref: SandboxRef,
    ctx: MutationContext,
    tx: TenantTransaction,
  ): Promise<void> {
    await this.repository.lockProject(tx, ref.projectId);
    const probe = await this.port.exec(ref, gitGitDir(), ctx);
    const initialised = !probe.timedOut && probe.exitCode === 0;
    if (initialised && (await this.repository.head(tx, ref.orgId, ref.projectId)) !== null) return;

    let label = 'Baseline: workspace as found';
    if (!initialised) {
      await this.exec(ref, gitInit(), ctx);
      const entries = await this.port.list(ref, '.', ctx);
      const own = entries.some((entry) => entry.name === '.gitignore')
        ? await this.port.read(ref, '.gitignore', ctx)
        : '';
      const rules = new Set(own.split('\n').map((line) => line.trim()));
      const missing = DEFAULT_GITIGNORE.filter((rule) => !rules.has(rule));
      if (missing.length > 0) {
        const head = own === '' || own.endsWith('\n') ? own : `${own}\n`;
        const content = `${head}${missing.join('\n')}\n`;
        await this.port.edit(ref, { content, path: '.gitignore' }, ctx);
      }
      const project = await this.repository.projectTemplate(tx, ref.orgId, ref.projectId);
      if (project?.template != null) {
        label = `Baseline: ${project.template} ${project.snapshot ?? ''}`.trim();
      }
    }

    // A clean pre-feature repository already holds its baseline commit: `commit` would exit 1
    // ("nothing to commit") and the run would fail on every attempt, so HEAD is the baseline.
    // The same answer after `status` said dirty is a resumed attempt whose first try committed
    // between the two steps (research R5): HEAD is that baseline, and the row is found by sha.
    if (!isClean(await this.exec(ref, gitStatus(), ctx))) {
      await this.exec(ref, gitAdd(), ctx);
      await this.commit(ref, label, ctx);
    }
    const gitSha = parseSha(await this.exec(ref, gitRevParse(), ctx));
    await this.record(tx, ref, {
      createdAt: this.clock.now(),
      files: await this.summary(ref, null, gitSha, ctx),
      gitSha,
      kind: 'baseline',
      label,
      orgId: ref.orgId,
      parentId: null,
      projectId: ref.projectId,
    });
  }

  /**
   * Turn end (contracts § 4): a clean tree answers the head row; a dirty one is committed, its
   * summary captured, and the row inserted or found by sha (R5). A `DaytonaError` from the port
   * and a failed insert both propagate as they are — the executor decides what each means.
   */
  async commitTurn(
    ref: SandboxRef,
    ctx: MutationContext,
    origin: { readonly runId: string; readonly summary?: string; readonly turn: number },
    tx: TenantTransaction,
  ): Promise<{ id: string; label: string }> {
    await this.repository.lockProject(tx, ref.projectId);
    const head = await this.repository.head(tx, ref.orgId, ref.projectId);
    if (head === null) throw new Error('The project has no baseline checkpoint to commit over.');

    if (isClean(await this.exec(ref, gitStatus(), ctx))) return { id: head.id, label: head.label };

    const label = turnLabel(origin.summary, origin.turn);
    await this.exec(ref, gitAdd(), ctx);
    await this.exec(ref, gitCommit(label), ctx);
    const gitSha = parseSha(await this.exec(ref, gitRevParse(), ctx));
    const files = await this.summary(ref, head.gitSha, gitSha, ctx);

    const row = await this.record(tx, ref, {
      createdAt: this.clock.now(),
      files,
      gitSha,
      kind: 'turn',
      label,
      orgId: ref.orgId,
      parentId: head.id,
      projectId: ref.projectId,
      runId: origin.runId,
      turn: origin.turn,
    });

    return { id: row.id, label: row.label };
  }

  /**
   * Spec 044: asks a hibernated workspace to wake. Its own transaction, given by the caller: inside
   * the request's, the "still waking" refusal would roll the wake back and it would never happen.
   */
  async wake(tx: TenantTransaction, ref: SandboxRef): Promise<void> {
    await this.lifecycle.ensureReady(tx, ref, {
      leaseEpoch: 0,
      operationId: `wake/${ref.projectId}`,
    });
  }

  /** No such project is the same `not-found` as a foreign org's (contracts � 3, SC-008). */
  async list(
    tx: TenantTransaction,
    ref: SandboxRef,
    page: { cursor?: string; limit: number },
  ): Promise<CheckpointPage> {
    if ((await this.repository.projectTemplate(tx, ref.orgId, ref.projectId)) === null) {
      throw new NotFoundError('No such project.');
    }
    return this.repository.list(tx, ref.orgId, ref.projectId, page);
  }

  /** A row of another project is as absent as no row (contracts § 3). */
  async byId(tx: TenantTransaction, ref: SandboxRef, id: string): Promise<Checkpoint> {
    const row = await this.repository.byId(tx, ref.orgId, id);
    if (row?.projectId !== ref.projectId) {
      throw new NotFoundError('No such checkpoint.');
    }
    return row;
  }

  /** `git diff <parent> <sha>` on demand (R7); a waking sandbox answers 503 with `Retry-After`. */
  async diff(tx: TenantTransaction, ref: SandboxRef, id: string): Promise<CheckpointDiff> {
    // A member's read, not a run's write: no lease to fence, the operation named after the row.
    const ctx: MutationContext = { leaseEpoch: 0, operationId: `diff/${id}` };
    const row = await this.byId(tx, ref, id);
    const parent =
      row.parentId === null ? null : await this.repository.byId(tx, ref.orgId, row.parentId);

    const readiness = await this.lifecycle.ensureReady(tx, ref, ctx);
    if (!readiness.ready) {
      throw new ServiceUnavailableError(
        'The workspace is waking; try again shortly.',
        WAKING_RETRY_AFTER_SECONDS,
      );
    }

    const parentSha = parent?.gitSha ?? null;
    const command = gitDiff(parentSha, row.gitSha);
    const patch = await this.port.exec(ref, command, ctx);
    const patches = splitDiff(this.output(command, patch, true));
    const sizes = parseLsTree(await this.exec(ref, gitLsTree(row.gitSha), ctx));
    const files = patches.map((file): CheckpointDiffFile =>
      file.binary ? { ...file, bytes: sizes.get(file.path) ?? 0 } : file,
    );
    // A clipped diff ends mid-file: that file loses its partial last hunk and says so.
    const last = files.at(-1);
    if (patch.truncated && last !== undefined && !last.binary) {
      const cut = last.patch.lastIndexOf('\n@@');
      files[files.length - 1] = {
        ...last,
        patch: cut === -1 ? last.patch : last.patch.slice(0, cut + 1),
        truncated: true,
      };
    }

    return { checkpointId: row.id, files, parentId: row.parentId };
  }

  /** The project's writer lock for the transaction (018: a pull's `handle` holds it). */
  lockProject(tx: TenantTransaction, ref: SandboxRef): Promise<void> {
    return this.repository.lockProject(tx, ref.projectId);
  }

  /** A run of the project is non-terminal (018: a push refuses while one is). */
  activeRunExists(tx: TenantTransaction, ref: SandboxRef): Promise<boolean> {
    return this.repository.activeRunExists(tx, ref.orgId, ref.projectId);
  }

  /** The project's head row, or null before the first checkpoint (018: a push's source). */
  head(tx: TenantTransaction, ref: SandboxRef): Promise<Checkpoint | null> {
    return this.repository.head(tx, ref.orgId, ref.projectId);
  }

  /**
   * Restore the workspace to `targetId`'s tree (US2, R3): `read-tree -u --reset` then a commit
   * over the head, so the history only grows and a revert of a revert is the same operation
   * (FR-014). Refused while a run is non-terminal and when the head already has the target's
   * tree (FR-012); the row, its audit entry (FR-025) and `checkpoint.created` share `tx`.
   *
   * 024 T046 — the finding, recorded rather than coded: this method needed **no change** to accept
   * an `edit` target. It reads exactly three fields off its target — `gitSha` (the tree to restore
   * and to compare), `kind` (only to decide whether the label nests) and `label` — and 024's `edit`
   * row carries all three like every other kind, with `files` from the same `summary()` this path
   * uses. So an edit is reverted, and a revert of that revert restores it, by the code that was
   * already here; there is no `kind === 'edit'` branch and none is wanted. The evidence is the two
   * cases in `checkpoint.service.spec.ts` that target an `edit` row (FR-012, FR-013, FR-026), not a
   * change made here to prove it.
   */
  async revert(
    ref: SandboxRef,
    actorId: string,
    targetId: string,
    tx: TenantTransaction,
  ): Promise<Checkpoint> {
    // A member's write, not a run's: no lease to fence, the operation named after the target.
    const ctx: MutationContext = { leaseEpoch: 0, operationId: `revert/${targetId}` };
    await this.repository.lockProject(tx, ref.projectId);
    const target = await this.byId(tx, ref, targetId);
    const head = await this.repository.head(tx, ref.orgId, ref.projectId);
    if (head === null) throw new Error('The project has no baseline checkpoint to revert over.');

    // Check-then-act under the writer lock: a run's commit waits on it, so none lands between.
    if (await this.repository.activeRunExists(tx, ref.orgId, ref.projectId)) {
      throw new ConflictError('A run is active.');
    }

    const readiness = await this.lifecycle.ensureReady(tx, ref, ctx);
    if (!readiness.ready) {
      throw new ServiceUnavailableError(
        'The workspace is waking; try again shortly.',
        WAKING_RETRY_AFTER_SECONDS,
      );
    }

    // "Already at" is about the workspace, not the head row (FR-012): an orphan commit (SC-007)
    // or edits a failed run left behind both count as elsewhere.
    const dirty = !isClean(await this.exec(ref, gitStatus(), ctx));
    const headSha = parseSha(await this.exec(ref, gitRevParse(), ctx));
    if (!dirty) {
      // `diff --quiet` answers by exit code: 0 same tree, 1 different, anything else a failure.
      const probe = gitDiffQuiet(target.gitSha, headSha);
      const compared = await this.port.exec(ref, probe, ctx);
      if (!compared.timedOut && compared.exitCode === 0) {
        throw new ConflictError('Already at this checkpoint.');
      }
      if (compared.timedOut || compared.exitCode !== 1) this.output(probe, compared, true);
    }

    // A revert row's tree is its target's, so reverting to it is reverting to that target: the
    // label says so and never nests (`label` ≤ 200 in the contract).
    const label = target.kind === 'revert' ? target.label : `Revert to ${target.label}`;
    await this.exec(ref, gitReadTree(target.gitSha), ctx);
    // HEAD already has the target's tree (dirty tree only): the files are restored, nothing to
    // commit — known before the commit when the shas match, from git's answer when only the
    // trees do (a revert row's sha over its target's tree).
    let gitSha = headSha;
    if (target.gitSha !== headSha) {
      await this.commit(ref, label, ctx);
      gitSha = parseSha(await this.exec(ref, gitRevParse(), ctx));
    }
    const files = gitSha === headSha ? [] : await this.summary(ref, head.gitSha, gitSha, ctx);

    const row = await this.record(tx, ref, {
      actorId,
      createdAt: this.clock.now(),
      files,
      gitSha,
      kind: 'revert',
      label,
      orgId: ref.orgId,
      parentId: head.id,
      projectId: ref.projectId,
      revertsId: target.id,
    });
    await this.audit.record(tx, {
      action: 'checkpoint.reverted',
      actorId,
      metadata: { projectId: ref.projectId, revertsId: target.id },
      orgId: ref.orgId,
      target: row.id,
    });

    return row;
  }

  /**
   * A member's hand edit (024 US1, data-model § 4): the file is written, the workspace committed
   * over the head, and the commit recorded as a fifth kind of checkpoint — `actor_id` the person,
   * `run_id` null, because a save belongs to nobody's turn. The sequence is the contract's: lock,
   * run-check, head, ready, write, clean-check, commit, summarise, record, audit, all in the
   * caller's `tx`.
   *
   * `port.edit` carries FR-003 and FR-004 on its own — the jail, the per-file cap and the binary
   * refusal are its existing guards, and re-checking them here would be a second, drifting copy.
   *
   * A clean tree after the write is a successful no-op, not a refusal (R7): the content was
   * already there, so nothing is committed and nothing is recorded, and the caller is told so
   * with the head it is still at. `git status` decides that, never a comparison of strings — a
   * save differing only by what git normalises is the case a string comparison gets wrong.
   *
   * Three refusals precede the write, in this order: an active run (`run-active`, US3), a project
   * with no checkpoint at all, and a base that is not the head (`base-moved`, US2,
   * FR-018/FR-020/FR-021) — see the comparison for why nothing is looked up.
   */
  async save(
    ref: SandboxRef,
    actorId: string,
    input: { readonly baseCheckpointId: string; readonly content: string; readonly path: string },
    tx: TenantTransaction,
  ): Promise<{ checkpoint: Checkpoint; saved: boolean }> {
    await this.repository.lockProject(tx, ref.projectId);

    // FR-014/FR-015, research R4 — the lock and this refusal cover different halves, and neither
    // is redundant, so do not delete one for the other:
    //
    // - `lockProject` serialises *commits*. Every path that records a checkpoint takes it — a
    //   turn's commit, `revert`, `recordPulled`, the mirror consumer — so no run's checkpoint can
    //   land between this save's checks and its own row (FR-016), and two members saving at once
    //   are serialised, the second finding the head moved (FR-017).
    // - The lock does *not* serialise a run's `fs_edit` tool calls. A run writes files through the
    //   sandbox port throughout a turn and only commits at the end, so a save during a live run
    //   could write into a tree the agent is halfway through changing and the lock would never
    //   notice. Refusing every save while any run is non-terminal removes that interleaving
    //   instead of trying to serialise it — that, and nothing else, is what makes FR-015 true.
    //
    // Checked under the lock and before the base check: check-then-lock would let a run start in
    // the gap, and the order is asserted in the spec for exactly that reason.
    if (await this.repository.activeRunExists(tx, ref.orgId, ref.projectId)) {
      throw new ConflictError('A run is active; wait for it to finish, then try again.', {
        reason: 'run-active',
      });
    }

    const head = await this.repository.head(tx, ref.orgId, ref.projectId);
    // A hand edit never roots a history: with no baseline there is no parent to hang it from and
    // no base it could have been read against. `files.service.ts` answers such a read with the
    // nil uuid for exactly this reason, so the two agree on the refusal.
    if (head === null) {
      throw new ConflictError('The project has no checkpoint to save over.', {
        reason: 'base-moved',
      });
    }
    // FR-018/FR-021: the head is the only thing the base is compared against. Anything else —
    // a checkpoint since superseded, another project's id, a nil uuid from a project that had
    // no checkpoint when the file was read — is equally stale, so none of them is looked up and
    // none of them is reconstructed. The refusal is the same one the null head gets, because to
    // the person it is the same thing: what you read is no longer what you would be saving over.
    if (input.baseCheckpointId !== head.id) {
      throw new ConflictError('The file changed since you opened it; reload and try again.', {
        reason: 'base-moved',
      });
    }

    // A member's write, not a run's: no lease to fence, the operation named after the base.
    const ctx: MutationContext = { leaseEpoch: 0, operationId: `edit/${head.id}` };
    const readiness = await this.lifecycle.ensureReady(tx, ref, ctx);
    if (!readiness.ready) {
      throw new ServiceUnavailableError(
        'The workspace is waking; try again shortly.',
        WAKING_RETRY_AFTER_SECONDS,
      );
    }

    await this.port.edit(ref, { content: input.content, path: input.path }, ctx);
    if (isClean(await this.exec(ref, gitStatus(), ctx))) return { checkpoint: head, saved: false };

    const label = `Edit ${input.path}`.slice(0, 200);
    await this.exec(ref, gitAdd(), ctx);
    await this.exec(ref, gitCommit(label), ctx);
    const gitSha = parseSha(await this.exec(ref, gitRevParse(), ctx));
    const files = await this.summary(ref, head.gitSha, gitSha, ctx);

    const row = await this.record(tx, ref, {
      actorId,
      createdAt: this.clock.now(),
      files,
      gitSha,
      kind: 'edit',
      label,
      orgId: ref.orgId,
      parentId: head.id,
      projectId: ref.projectId,
    });
    await this.audit.record(tx, {
      action: 'checkpoint.edited',
      actorId,
      metadata: { path: input.path, projectId: ref.projectId },
      orgId: ref.orgId,
      target: row.id,
    });

    return { checkpoint: row, saved: true };
  }

  /**
   * Spec 044 decision 8: whatever is dirty, committed as a member's `edit` — the guards and the row
   * of {@link save} with no file written. `null` on a clean tree: the caller still pushes the head.
   * Same reason for each guard as there; `activeRunExists` under the lock above all (FR-015).
   */
  async commitWorkspace(
    ref: SandboxRef,
    actorId: string,
    input: { readonly message?: string },
    tx: TenantTransaction,
  ): Promise<Checkpoint | null> {
    await this.repository.lockProject(tx, ref.projectId);

    if (await this.repository.activeRunExists(tx, ref.orgId, ref.projectId)) {
      throw new ConflictError('A run is active; wait for it to finish, then try again.', {
        reason: 'run-active',
      });
    }

    const head = await this.repository.head(tx, ref.orgId, ref.projectId);
    if (head === null) {
      throw new ConflictError('The project has no checkpoint to commit over.', {
        reason: 'nothing-to-push',
      });
    }

    // A member's write, not a run's: no lease to fence, the operation named after the base.
    const ctx: MutationContext = { leaseEpoch: 0, operationId: `commit/${head.id}` };
    const readiness = await this.lifecycle.ensureReady(tx, ref, ctx);
    if (!readiness.ready) {
      throw new ServiceUnavailableError(
        'The workspace is waking; try again shortly.',
        WAKING_RETRY_AFTER_SECONDS,
      );
    }

    const status = await this.exec(ref, gitStatus(), ctx);
    const dirty = !isClean(status);
    let label = sanitiseLabel(input.message ?? filesLabel(status)).slice(0, 200);

    if (dirty) {
      await this.exec(ref, gitAdd(), ctx);
      await this.exec(ref, gitCommit(label), ctx);
    }

    const gitSha = parseSha(await this.exec(ref, gitRevParse(), ctx));
    if (gitSha === head.gitSha) return null;

    // A clean tree ahead of the head: an attempt that committed and then rolled its row back, or a
    // commit made in the terminal. Either way it is work with no row, so it gets one.
    if (!dirty) label = sanitiseLabel((await this.exec(ref, gitLogSubject(gitSha), ctx)).trim());

    const files = await this.summary(ref, head.gitSha, gitSha, ctx);

    const row = await this.record(tx, ref, {
      actorId,
      createdAt: this.clock.now(),
      files,
      gitSha,
      kind: 'edit',
      label,
      orgId: ref.orgId,
      parentId: head.id,
      projectId: ref.projectId,
    });
    await this.audit.record(tx, {
      action: 'checkpoint.edited',
      actorId,
      metadata: { files: files.length, projectId: ref.projectId },
      orgId: ref.orgId,
      target: row.id,
    });

    return row;
  }

  /**
   * A pull's rows (018 US3, R6/R7): the consumer fast-forwarded the workspace onto the remote
   * and lists the new commits oldest first; each becomes a `pull` row over the previous one —
   * the summary as any other kind's, the label the commit's subject. A sha already recorded
   * (a resumed attempt) is found by `insertOrGetBySha`, not duplicated. Under the writer lock.
   */
  async recordPulled(
    ref: SandboxRef,
    ctx: MutationContext,
    actorId: string,
    syncOperationId: string,
    shas: readonly string[],
    tx: TenantTransaction,
  ): Promise<Checkpoint[]> {
    await this.repository.lockProject(tx, ref.projectId);
    let parent = await this.repository.head(tx, ref.orgId, ref.projectId);
    if (parent === null) throw new Error('The project has no baseline checkpoint to pull over.');

    const recorded: Checkpoint[] = [];
    for (const gitSha of shas) {
      const files = await this.summary(ref, parent.gitSha, gitSha, ctx);
      const subject = await this.exec(ref, gitLogSubject(gitSha), ctx);
      const label = (subject.split('\n')[0] ?? '').trim().slice(0, 200) || 'Pulled commit';
      parent = await this.record(tx, ref, {
        actorId,
        createdAt: this.clock.now(),
        files,
        gitSha,
        kind: 'pull',
        label,
        orgId: ref.orgId,
        parentId: parent.id,
        projectId: ref.projectId,
        syncOperationId,
      });
      recorded.push(parent);
    }
    return recorded;
  }

  /**
   * An import's one checkpoint (spec 026 data-model § 4): a `baseline` at the cloned sha carrying
   * `sync_operation_id` and **no** `actor_id`.
   *
   * The asymmetry with {@link recordPulled} is the table's four CHECKs, not a preference. They are
   * iffs: `(kind = 'pull') = (actor_id is not null and sync_operation_id is not null)`, so a
   * baseline carrying both columns would make the pull check's right-hand side true while its left
   * is false and the row would be refused. Carrying `sync_operation_id` alone passes both, which is
   * how a first checkpoint reads with its provenance without `checkpoint_kind` growing a fifth
   * value. Who asked is not lost: the import operation's `requested_by` names them, one join away.
   */
  async recordImported(
    ref: SandboxRef,
    ctx: MutationContext,
    syncOperationId: string,
    gitSha: string,
    tx: TenantTransaction,
  ): Promise<Checkpoint> {
    await this.repository.lockProject(tx, ref.projectId);

    return this.record(tx, ref, {
      createdAt: this.clock.now(),
      files: await this.summary(ref, null, gitSha, ctx),
      gitSha,
      kind: 'baseline',
      label: `Imported ${gitSha.slice(0, 7)}`,
      orgId: ref.orgId,
      parentId: null,
      projectId: ref.projectId,
      syncOperationId,
    });
  }

  /** The row inserted or found by sha, and its `checkpoint.created` in the same `tx` (R5). */
  private async record(
    tx: TenantTransaction,
    ref: SandboxRef,
    row: NewCheckpoint,
  ): Promise<Checkpoint> {
    const inserted = await this.repository.insertOrGetBySha(tx, row);
    await this.outbox.append(tx, {
      aggregateId: inserted.id,
      orgId: ref.orgId,
      payload: { checkpointId: inserted.id, orgId: ref.orgId, projectId: ref.projectId },
      type: 'checkpoint.created',
    });
    return inserted;
  }

  /** `name-status` joined with the sizes at `sha`; a deletion has no blob there, so 0. */
  private async summary(
    ref: SandboxRef,
    parentSha: string | null,
    sha: string,
    ctx: MutationContext,
  ): Promise<CheckpointFile[]> {
    const changed = parseNameStatus(await this.exec(ref, gitDiffTree(parentSha, sha), ctx));
    const sizes = parseLsTree(await this.exec(ref, gitLsTree(sha), ctx));
    return changed.map((file) => ({
      bytes: file.status === 'D' ? 0 : (sizes.get(file.path) ?? 0),
      path: file.path,
      status: file.status,
    }));
  }

  /** `commit`, where "nothing to commit" (exit 1) is an answer — HEAD already is the tree — not a failure. */
  private async commit(ref: SandboxRef, label: string, ctx: MutationContext): Promise<void> {
    const command = gitCommit(label);
    const result = await this.port.exec(ref, command, ctx);
    if (result.timedOut || result.exitCode !== 1 || !result.output.includes('nothing to commit')) {
      this.output(command, result, false);
    }
  }

  /** One git step whose whole output is the answer: a clipped one is as failed as a non-zero exit. */
  private async exec(ref: SandboxRef, command: string, ctx: MutationContext): Promise<string> {
    return this.output(command, await this.port.exec(ref, command, ctx), false);
  }

  /**
   * A non-zero exit or a timeout is a failure of the step, with git's own words; so is a clipped
   * output unless the caller can live with a partial one (`git diff`).
   * ponytail: exec output capped at 64 KiB; a per-call cap on SandboxPort.exec is the upgrade path
   */
  private output(command: string, result: ExecResult, partialOk: boolean): string {
    if (result.timedOut) throw new GitStepError(`\`${command}\` timed out.`);
    if (result.exitCode !== 0) {
      throw new GitStepError(
        `\`${command}\` exited ${String(result.exitCode)}: ${result.output.trim()}`,
      );
    }
    if (result.truncated && !partialOk) {
      throw new GitStepError(`\`${command}\` output was truncated.`);
    }
    return result.output;
  }
}
