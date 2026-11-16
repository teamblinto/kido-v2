import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import type { TenantContext } from '../../../database/tenant-context';
import { gitRevParse, gitStatus, parseSha } from '../../checkpoints/git-commands';
import {
  type MutationContext,
  SANDBOX_PORT,
  type SandboxPort,
  type SandboxRef,
} from '../../sandbox/sandbox.port';
import { integrationNote } from '../../sandbox/integration-note';
import { PREVIEW_ENV_SOURCE, type PreviewEnvSource } from '../../sandbox/sandbox.constants';
import { AGENT_TIMINGS, type AgentTimings, MAP_EXPORT_CAP_BYTES } from '../agent.constants';
import {
  type ConversationMessage,
  type CredentialContext,
  LLM_PROVIDER,
  type LlmClient,
  type LlmProvider,
  type PromptAttachment,
} from '../llm-provider.port';
import { SYSTEM_PROMPT } from '../prompt';
import type { ExecutionContext } from '../run-executor.port';
import { type RunFence, RunStore } from '../run-store';
import type { ToolName } from '../tools';
import { exportedNames } from './exports';
import { gitLsFiles, parseLsFiles, porcelainDigest } from './git-commands';
import { EMPTY_MAP_NOTICE, renderMap } from './repo-map';
import { summarise, type SummaryState } from './summary';

/** What the executor holds for one attempt (021 contracts § context-assembler). */
export interface AttemptScope {
  readonly run: ExecutionContext['run'];
  readonly ref: SandboxRef;
  readonly fence: RunFence;
  readonly credential: CredentialContext;
  readonly client: LlmClient;
  readonly emit: ExecutionContext['emit'];
  readonly dispatch: ExecutionContext['dispatch'];
  /** Read inside `dispatch` only: `TenantContext.tx` throws outside a tenant scope. */
  readonly tenantTx: () => TenantContext['tx'];
  /** Spec 048: the attempt's resolved files by message id; the summary's rebuild carries them. */
  readonly attachments?: ReadonlyMap<string, readonly PromptAttachment[]>;
}

/** Per attempt: the map and the tree state it was built from (R2), and the running summary (R4). */
interface AttemptState {
  map: string;
  dirtyDigest: string;
  /** The three `agent_runs` columns as last persisted; a crossing in this attempt extends them. */
  summary: SummaryState;
  /** The project's connected services, by env name only (never a value); '' when none. */
  integrations: string;
}

const NO_SUMMARY: SummaryState = { summary: null, throughMessageId: null, tokens: 0 };

const SOURCE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const CHANGES_TREE: ReadonlySet<ToolName> = new Set<ToolName>(['fs_edit', 'exec']);

/** A git step answered badly (the `CheckpointService.exec` shape); never leaves this file. */
class GitStepFailed extends Error {}

/**
 * The executor's one seam for context (021 research R2–R4): `prepare` at attempt start,
 * `request` before every model call, `afterTools` after every tool round. The map (R2, R3) is
 * here; the summary (T019–T021) and the skips fill the rest in turn.
 */
@Injectable()
export class ContextAssembler {
  private readonly logger = new Logger(ContextAssembler.name);
  /** Per attempt: the executor's one `scope` object keys it, so nothing outlives the attempt. */
  private readonly states = new WeakMap<AttemptScope, AttemptState>();

  constructor(
    @Inject(SANDBOX_PORT) private readonly port: SandboxPort,
    private readonly store: RunStore,
    @Inject(LLM_PROVIDER) private readonly provider: LlmProvider,
    @Inject(AGENT_TIMINGS) private readonly timings: AgentTimings,
    @Optional()
    @Inject(PREVIEW_ENV_SOURCE)
    private readonly previewEnv?: PreviewEnvSource,
  ) {}

  /**
   * Attempt start: serve or rebuild the map for the tree as it is now. A git failure serves the
   * stored map (or the empty notice) and fails no run.
   */
  async prepare(scope: AttemptScope): Promise<void> {
    // One dispatch: the port resolves the sandbox row in the tenant scope it opens.
    await scope.dispatch(async () => {
      const stored = await this.store.getProjectContext(
        scope.tenantTx(),
        scope.ref.orgId,
        scope.ref.projectId,
      );
      const row = await this.store.readRun(
        scope.tenantTx(),
        scope.ref.orgId,
        scope.ref.projectId,
        scope.run.id,
      );
      // The source never throws; only the names reach the prompt.
      const env =
        this.previewEnv === undefined
          ? {}
          : await this.previewEnv(scope.tenantTx(), scope.ref.orgId, scope.ref.projectId);
      const state: AttemptState = {
        integrations: integrationNote(Object.keys(env)),
        dirtyDigest: stored?.dirtyDigest ?? '',
        map: stored?.repoMap ?? EMPTY_MAP_NOTICE,
        summary: row
          ? {
              summary: row.summary,
              throughMessageId: row.summaryThroughMessageId,
              tokens: row.summaryTokens,
            }
          : NO_SUMMARY,
      };
      this.states.set(scope, state);
      try {
        const headSha = await this.head(scope);
        const dirtyDigest = porcelainDigest(await this.git(scope, gitStatus()));
        if (stored?.headSha === headSha && stored.dirtyDigest === dirtyDigest) {
          this.logger.debug(`map served: run=${scope.run.id} bytes=${String(state.map.length)}`);
          return;
        }
        await this.rebuild(scope, state, headSha, dirtyDigest);
      } catch (error) {
        this.warn('prepare', scope, error);
      }
    });
  }

  /** After a tool round that dispatched fs_edit or exec: `git status`; rebuild when it changed. */
  async afterTools(scope: AttemptScope, dispatched: readonly ToolName[]): Promise<void> {
    const state = this.states.get(scope);
    if (!state || !dispatched.some((name) => CHANGES_TREE.has(name))) return;
    await scope.dispatch(async () => {
      try {
        const dirtyDigest = porcelainDigest(await this.git(scope, gitStatus()));
        if (dirtyDigest === state.dirtyDigest) return;
        const headSha = await this.head(scope);
        await this.rebuild(scope, state, headSha, dirtyDigest);
      } catch (error) {
        this.warn('afterTools', scope, error);
      }
    });
  }

  /**
   * Before a model call: the layout (spec US3) in order — the system block, then (the tools the
   * executor adds) the map and excerpts blocks, then the conversation (summary + tail). Nothing
   * run-specific goes before the conversation: `system` is `SYSTEM_PROMPT` byte-for-byte and the
   * map is the project's, never the run's. Excerpts empty.
   *
   * The summary (US2, R4) runs over the run's rows re-read here, not over `conversation`: the
   * marker is a row id, and rows persisted this attempt have no id in memory. The two agree by
   * index — the executor persists every message before pushing it, and `listMessages` orders as
   * `snapshot` does — so `toMessages(rows)` is `conversation` with ids: the marker is `rows[k].id`
   * and the tail sent is `conversation.slice(k + 1)`. A second crossing in the same attempt
   * extends the in-memory state rather than restarting. An update is persisted under the fence
   * before this returns, so an attempt resumed after the model call reads the same summary; a
   * failed call records a skip and sends every message. Without `prepare` (no state) the
   * conversation goes as is.
   */
  async request(
    scope: AttemptScope,
    conversation: readonly ConversationMessage[],
  ): Promise<{
    system: string;
    context: { map: string; excerpts: string };
    messages: readonly ConversationMessage[];
  }> {
    const state = this.states.get(scope);
    let messages = conversation;
    if (state) {
      // ponytail: one row read per turn; gate it on an in-memory token estimate if it shows up.
      const rows = await scope.dispatch(() =>
        this.store.listMessages(scope.tenantTx(), scope.ref.orgId, scope.run.id),
      );
      // The model call sits outside any dispatch: no tenant transaction is held for up to summaryMs.
      const result = await summarise(
        {
          attachments: scope.attachments,
          credential: scope.credential,
          emit: scope.emit,
          provider: this.provider,
          summaryMs: this.timings.summaryMs,
        },
        rows,
        state.summary,
      );
      messages = result.messages;
      if (result.update) {
        const update = result.update;
        await scope.dispatch(() => this.store.setSummary(scope.tenantTx(), scope.fence, update));
        state.summary = update;
        this.logger.log(
          `summary stored: run=${scope.run.id} through=${update.throughMessageId} tokens=${String(update.tokens)}`,
        );
      } else if (result.skipped !== undefined) {
        const skip = {
          kind: 'summary' as const,
          reason: result.skipped,
          turn: rows.filter((row) => row.role === 'assistant').length + 1,
        };
        await scope.dispatch(() =>
          this.store.appendContextSkip(scope.tenantTx(), scope.fence, skip),
        );
        this.logger.warn(`summary skipped: run=${scope.run.id} reason=${skip.reason}`);
      }
    }
    return {
      // The integrations note is project state that can change between turns: the uncached block.
      context: { excerpts: state?.integrations ?? '', map: state?.map ?? '' },
      messages,
      system: SYSTEM_PROMPT,
    };
  }

  /**
   * `ls-files`, one `read` per source file under the cap, render, store, and hold (R3). Reads are
   * sequential: the tenant transaction is one pg client. Runs inside the caller's dispatch.
   */
  private async rebuild(
    scope: AttemptScope,
    state: AttemptState,
    headSha: string,
    dirtyDigest: string,
  ): Promise<void> {
    const paths = parseLsFiles(await this.git(scope, gitLsFiles()));
    let unread = 0;
    const files: { path: string; exports: string[] }[] = [];
    for (const path of paths) {
      let exports: string[] = [];
      if (SOURCE.test(path)) {
        try {
          const source = await this.port.read(scope.ref, path, this.ctx(scope));
          exports = Buffer.byteLength(source) > MAP_EXPORT_CAP_BYTES ? [] : exportedNames(source);
        } catch {
          unread += 1;
          this.logger.debug(`map read failed: run=${scope.run.id} path=${path}`);
        }
      }
      files.push({ exports, path });
    }
    state.map = renderMap(files);
    state.dirtyDigest = dirtyDigest;
    await this.store.upsertProjectContext(scope.tenantTx(), {
      dirtyDigest,
      headSha,
      orgId: scope.ref.orgId,
      projectId: scope.ref.projectId,
      repoMap: state.map,
    });
    this.logger.log(
      `map rebuilt: run=${scope.run.id} files=${String(paths.length)} unread=${String(unread)} bytes=${String(Buffer.byteLength(state.map))}`,
    );
  }

  /** One git step whose whole output is the answer: a clipped one is as failed as a non-zero exit. */
  private async git(scope: AttemptScope, command: string): Promise<string> {
    const result = await this.port.exec(scope.ref, command, this.ctx(scope));
    if (result.timedOut) throw new GitStepFailed(`\`${command}\` timed out.`);
    if (result.exitCode !== 0) {
      throw new GitStepFailed(`\`${command}\` exited ${String(result.exitCode)}`);
    }
    if (result.truncated) throw new GitStepFailed(`\`${command}\` output was truncated.`);
    return result.output;
  }

  /** `rev-parse HEAD` as a sha; anything else is a failed step. */
  private async head(scope: AttemptScope): Promise<string> {
    const output = await this.git(scope, gitRevParse());
    try {
      return parseSha(output);
    } catch {
      throw new GitStepFailed(`\`${gitRevParse()}\` printed no sha.`);
    }
  }

  private ctx(scope: AttemptScope): MutationContext {
    return { leaseEpoch: scope.run.epoch, operationId: `${scope.run.id}/context` };
  }

  /**
   * A git failure is logged — the step and its exit only, never the map text or git's output
   * (T024) — and the last map serves; anything else (a fenced write) propagates.
   */
  private warn(phase: string, scope: AttemptScope, error: unknown): void {
    if (!(error instanceof GitStepFailed)) throw error;
    this.logger.warn(
      `map ${phase} failed, serving the last map: run=${scope.run.id} ${error.message}`,
    );
  }
}
