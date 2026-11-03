import type { ChildProcess } from 'node:child_process';

import {
  LOCAL_AGENT_APPROVAL_TIMEOUT_SECONDS,
  type LocalAgentPermissionMode,
  type RunApprovalDecision,
  type RunApprovalKind,
} from '@repo/contracts';

import { log, scrub } from '../../log.ts';
import {
  killTree,
  resolveBinary,
  runCapture,
  shutdownChild,
  spawnBinary,
  StderrTail,
} from '../../process.ts';
import {
  AsyncQueue,
  isRecord,
  isRoutineWrite,
  isSensitivePath,
  redactPaths,
  resolveWriteTarget,
  str,
  toWorkspaceRelative,
  truncate,
} from '../../util.ts';
import { COMPANION_VERSION } from '../../version.ts';
import {
  type AdapterContext,
  DEFAULT_INTERRUPT_GRACE_MS,
  notInstalled,
  type ProviderAdapter,
  type ProviderProbe,
  type RunEventBody,
  type RunHandle,
  type StartRunOptions,
} from '../types.ts';
import { CodexRpc, initializeCodex, type RpcId } from './rpc.ts';

/**
 * Codex CLI through `codex app-server` (JSON-RPC over stdio). One run is one turn on a thread;
 * approvals are the app-server's own `item/*\/requestApproval` server requests.
 */

const NAME = 'Codex';
/** Longer than this cannot be shown whole for approval, so a command is declined rather than cut. */
const MAX_DETAIL = 8_000;

/**
 * Every mode asks before commands (`untrusted`). `plan` keeps the sandbox read-only and declines
 * commands and edits here without asking; `acceptEdits` approves routine edits inside the
 * workspace without asking. `untrusted` still runs commands Codex deems safe reads (`cat`, `rg`…)
 * without asking, and 0.162's sandbox cannot limit reads to the workspace (spec 040 § 3, residual
 * risks).
 */
const CODEX_POLICY: Record<LocalAgentPermissionMode, { approvalPolicy: string; sandbox: string }> =
  {
    acceptEdits: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
    default: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
    plan: { approvalPolicy: 'untrusted', sandbox: 'read-only' },
  };

const CONVERSATION_ITEMS = new Set([
  'agentMessage',
  'contextCompaction',
  'hookPrompt',
  'plan',
  'reasoning',
  'userMessage',
]);

type TerminalData = Extract<RunEventBody, { type: 'terminal' }>['data'];
type FailureClass = NonNullable<TerminalData['failure']>['class'];

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** `account/read` result → method/plan; the email is never kept. */
export function codexAuth(result: unknown): ProviderProbe['auth'] {
  if (!isRecord(result)) return { method: null, plan: null, status: 'unknown' };
  const account = result.account;
  if (!isRecord(account)) {
    return result.requiresOpenaiAuth === false
      ? { method: 'unknown', plan: null, status: 'authenticated' }
      : { method: null, plan: null, status: 'unauthenticated' };
  }
  switch (account.type) {
    case 'chatgpt': {
      const plan = str(account.planType);
      return {
        method: 'subscription',
        plan: plan ? truncate(capitalize(plan), 100) : null,
        status: 'authenticated',
      };
    }
    case 'apiKey':
      return { method: 'api_key', plan: null, status: 'authenticated' };
    case 'amazonBedrock':
      return { method: 'cloud_provider', plan: null, status: 'authenticated' };
    default:
      return { method: 'unknown', plan: null, status: 'authenticated' };
  }
}

function codexModels(result: unknown): ProviderProbe['models'] {
  if (!isRecord(result) || !Array.isArray(result.data)) return [];
  return (result.data as unknown[])
    .filter((model) => isRecord(model) && model.hidden !== true && str(model.id)?.trim())
    .slice(0, 100)
    .map((model) => {
      const entry = model as Record<string, unknown>;
      const id = truncate((str(entry.id) ?? '').trim(), 200);
      return { id, label: truncate((str(entry.displayName) ?? id).trim() || id, 200) };
    });
}

/**
 * Picks the reply for BAIOS's allow/deny from what the request says it accepts. An allow is only
 * ever this one call: never `acceptForSession`, which would also approve every later one.
 */
export function codexDecision(decision: RunApprovalDecision, available: unknown[] | null): string {
  const offers = (choice: string) => !available || available.includes(choice);
  if (decision === 'allow' && offers('accept')) return 'accept';
  return offers('decline') ? 'decline' : 'cancel';
}

/**
 * The command as asked for. On Windows `command` is wrapped in powershell.exe and a lone action is
 * the readable inner command; with several actions only the whole command shows all of it.
 */
function commandText(source: Record<string, unknown>): string {
  const actions: unknown[] = Array.isArray(source.commandActions) ? source.commandActions : [];
  const only = actions.length === 1 ? actions[0] : undefined;
  return (isRecord(only) ? str(only.command) : undefined) ?? str(source.command) ?? '';
}

function errorKey(info: unknown): string | null {
  if (typeof info === 'string') return info;
  return isRecord(info) ? (Object.keys(info)[0] ?? null) : null;
}

interface PendingApproval {
  available: unknown[] | null;
  rpcId: RpcId;
  timer: NodeJS.Timeout;
}

interface FileChange {
  kind: string;
  /** Where an `update` moves the file, when it does. */
  movePath: string | null;
  path: string;
  diff: string;
}

class CodexRun implements RunHandle {
  readonly events = new AsyncQueue<RunEventBody>();
  private readonly approvals = new Map<string, PendingApproval>();
  private child: ChildProcess | null = null;
  private readonly ctx: AdapterContext;
  private disposing: Promise<void> | null = null;
  private readonly fileChanges = new Map<string, FileChange[]>();
  private finished = false;
  private interruptRequested = false;
  private interruptTimer: NodeJS.Timeout | null = null;
  private lastError: Record<string, unknown> | null = null;
  private readonly options: StartRunOptions;
  private readonly redact: <T>(value: T) => T;
  /** The same rewriting without the length cut, for streamed text and output. */
  private readonly redactFull: <T>(value: T) => T;
  private rpc: CodexRpc | null = null;
  private readonly startedTools = new Set<string>();
  private readonly stderr = new StderrTail();
  private threadId: string | null = null;
  private turnId: string | null = null;
  private readonly usage = { inputTokens: 0, outputTokens: 0 };

  constructor(ctx: AdapterContext, options: StartRunOptions) {
    this.ctx = ctx;
    this.options = options;
    this.redact = redactPaths(options.cwd);
    this.redactFull = redactPaths(options.cwd, Infinity);
    this.launch().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.fail(
        /unauthori[sz]ed|not logged in|login/i.test(message) ? 'auth' : 'provider',
        message,
      );
    });
  }

  private get graceMs(): number {
    return this.ctx.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS;
  }

  private async launch(): Promise<void> {
    if (this.options.toolset) {
      return this.fail(
        'provider',
        `${NAME} cannot run with BAIOS sandbox tools yet. Use Claude Code for this run.`,
      );
    }
    const binary = resolveBinary('codex', this.ctx.binary);
    if (!binary) return this.fail('provider', notInstalled(NAME, 'codex').message ?? NAME);
    const child = spawnBinary(binary, ['app-server'], { cwd: this.options.cwd });
    this.child = child;
    child.stderr?.on('data', (chunk: Buffer) => this.stderr.push(chunk));
    child.once('error', (error) =>
      this.fail('crash', `${NAME} could not be started: ${error.message}`),
    );
    child.once('exit', (code, signal) => this.onExit(code, signal));
    const rpc = new CodexRpc(child, {
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (id, method, params) => this.onRequest(id, method, params),
    });
    this.rpc = rpc;
    await initializeCodex(rpc, COMPANION_VERSION);

    const { model, permissionMode, prompt, resume } = this.options;
    const overrides = {
      ...CODEX_POLICY[permissionMode],
      cwd: this.options.cwd,
      ...(model ? { model } : {}),
    };
    const started = resume
      ? await rpc.request('thread/resume', { ...overrides, excludeTurns: true, threadId: resume })
      : await rpc.request('thread/start', overrides);
    const thread = isRecord(started) && isRecord(started.thread) ? started.thread : {};
    const threadId = str(thread.id);
    if (!threadId) throw new Error(`${NAME} did not return a thread.`);
    this.threadId = threadId;
    this.emit({ data: { providerSessionId: truncate(threadId, 200) }, type: 'session' });
    if (this.finished) return;

    const turn = await rpc.request('turn/start', {
      input: [{ text: prompt, text_elements: [], type: 'text' }],
      threadId,
    });
    this.turnId = (isRecord(turn) && isRecord(turn.turn) ? str(turn.turn.id) : undefined) ?? null;
    if (this.interruptRequested) this.sendInterrupt();
  }

  private emit(event: RunEventBody): void {
    if (!this.finished) this.events.push(event);
  }

  private ours(params: Record<string, unknown>): boolean {
    const thread = str(params.threadId);
    const turn = str(params.turnId);
    return (
      (!thread || !this.threadId || thread === this.threadId) &&
      (!turn || !this.turnId || turn === this.turnId)
    );
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (!this.ours(params)) return;
    switch (method) {
      // shortcut: a secret split across two deltas is not caught; scrub whole items if that matters.
      case 'item/agentMessage/delta': {
        const text = str(params.delta);
        if (text) this.emit({ data: { text: this.redactFull(text) }, type: 'text.delta' });
        return;
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const text = str(params.delta);
        if (text) this.emit({ data: { text: this.redactFull(text) }, type: 'reasoning.delta' });
        return;
      }
      case 'item/commandExecution/outputDelta': {
        const itemId = str(params.itemId);
        const chunk = str(params.delta);
        if (itemId && chunk && this.startedTools.has(itemId)) {
          this.emit({
            data: { chunk: this.redactFull(chunk), toolId: truncate(itemId, 128) },
            type: 'tool.output',
          });
        }
        return;
      }
      case 'item/started':
        return this.onItemStarted(params.item);
      case 'item/completed':
        return this.onItemCompleted(params.item);
      case 'thread/tokenUsage/updated': {
        const last = isRecord(params.tokenUsage) ? params.tokenUsage.last : null;
        if (isRecord(last)) {
          if (typeof last.inputTokens === 'number') this.usage.inputTokens += last.inputTokens;
          if (typeof last.outputTokens === 'number') this.usage.outputTokens += last.outputTokens;
        }
        return;
      }
      case 'error':
        if (params.willRetry !== true && isRecord(params.error)) this.lastError = params.error;
        return;
      case 'serverRequest/resolved':
        for (const [requestId, pending] of this.approvals) {
          if (pending.rpcId === params.requestId) {
            clearTimeout(pending.timer);
            this.approvals.delete(requestId);
          }
        }
        return;
      case 'turn/completed':
        return this.onTurnCompleted(params.turn);
      default:
        return; // hooks, MCP startup, rate limits and anything newer are not ours to show
    }
  }

  private onItemStarted(item: unknown): void {
    if (!isRecord(item)) return;
    const id = str(item.id);
    const type = str(item.type);
    if (!id || !type || CONVERSATION_ITEMS.has(type) || this.startedTools.has(id)) return;
    this.startedTools.add(id);
    let name = type;
    let input: unknown = {};
    if (type === 'commandExecution') {
      name = 'command';
      input = { command: commandText(item) };
    } else if (type === 'fileChange') {
      const changes = this.readChanges(item.changes);
      this.fileChanges.set(id, changes);
      name = 'file_change';
      input = {
        changes: changes.map((change) => ({
          kind: change.kind,
          path: toWorkspaceRelative(this.options.cwd, change.path) ?? '(outside the workspace)',
        })),
      };
    } else if (type === 'mcpToolCall') {
      name = `${str(item.server) ?? 'mcp'}.${str(item.tool) ?? 'tool'}`;
      input = item.arguments ?? {};
    }
    this.emit({
      data: { input: this.redact(input), name: truncate(name, 200), toolId: truncate(id, 128) },
      type: 'tool.start',
    });
  }

  private readChanges(raw: unknown): FileChange[] {
    if (!Array.isArray(raw)) return [];
    return (raw as unknown[]).flatMap((change) => {
      if (!isRecord(change) || !str(change.path)) return [];
      const kind = isRecord(change.kind) ? (str(change.kind.type) ?? 'update') : 'update';
      const movePath = isRecord(change.kind) ? (str(change.kind.move_path) ?? null) : null;
      return [{ diff: str(change.diff) ?? '', kind, movePath, path: str(change.path) ?? '' }];
    });
  }

  private onItemCompleted(item: unknown): void {
    if (!isRecord(item)) return;
    const id = str(item.id);
    if (!id || !this.startedTools.has(id)) return;
    const status = str(item.status) ?? 'completed';
    const exitCode = typeof item.exitCode === 'number' ? item.exitCode : null;
    const ok = status === 'completed' && (exitCode === null || exitCode === 0);
    const summary = exitCode === null ? status : `${status} (exit ${exitCode})`;
    this.emit({ data: { ok, summary, toolId: truncate(id, 128) }, type: 'tool.end' });
    if (item.type !== 'fileChange' || status !== 'completed') return;
    for (const change of this.readChanges(item.changes)) {
      const path = toWorkspaceRelative(this.options.cwd, change.path);
      if (!path) continue;
      const kind =
        change.kind === 'add' ? 'created' : change.kind === 'delete' ? 'deleted' : 'modified';
      this.emit({ data: { kind, path }, type: 'file.change' });
    }
  }

  private onTurnCompleted(turn: unknown): void {
    if (!isRecord(turn)) return;
    if (this.turnId && str(turn.id) !== this.turnId) return;
    if (this.usage.inputTokens || this.usage.outputTokens) {
      this.emit({ data: { ...this.usage }, type: 'usage' });
    }
    const status = str(turn.status);
    if (status === 'completed') return this.finish({ status: 'completed' });
    if (status === 'interrupted' || this.interruptRequested) {
      return this.finish({ status: 'interrupted' });
    }
    const error = isRecord(turn.error) ? turn.error : this.lastError;
    const message =
      (error ? str(error.message) : undefined) ?? `${NAME} turn ${status ?? 'failed'}.`;
    switch (errorKey(error?.codexErrorInfo)) {
      case 'usageLimitExceeded':
      case 'rateLimitExceeded':
        return this.fail('usage_limit', message);
      case 'unauthorized':
        return this.fail(
          'auth',
          `${NAME} is not signed in, or its sign-in expired. Run \`baios-companion login codex\`. ${message}`,
        );
      default:
        return this.fail('provider', message);
    }
  }

  private onRequest(id: RpcId, method: string, params: Record<string, unknown>): void {
    const rpc = this.rpc;
    if (!rpc) return;
    if (this.finished || !this.ours(params)) {
      return rpc.respondError(id, -32000, 'The BAIOS run for this request has ended.');
    }
    const { cwd, permissionMode } = this.options;
    const available = Array.isArray(params.availableDecisions)
      ? (params.availableDecisions as unknown[])
      : null;
    const decline = () => rpc.respond(id, { decision: codexDecision('deny', available) });
    if (method === 'item/commandExecution/requestApproval') {
      // The local ceiling (ADR decision 6): plan runs nothing that has to ask.
      if (permissionMode === 'plan') return decline();
      const command = commandText(params);
      if (command.length > MAX_DETAIL) return decline();
      const reason = str(params.reason);
      const detail = this.redactFull(reason ? `${command}\n\nReason: ${reason}` : command);
      return this.ask(id, available, {
        detail,
        kind: 'command',
        title: `Run: ${detail.split('\n')[0] ?? ''}`,
      });
    }
    if (method === 'item/fileChange/requestApproval') {
      if (permissionMode === 'plan') return decline();
      const changes = this.fileChanges.get(str(params.itemId) ?? '') ?? [];
      const targets = changes.flatMap((change) =>
        change.movePath ? [change.path, change.movePath] : [change.path],
      );
      if (
        permissionMode === 'acceptEdits' &&
        targets.length > 0 &&
        params.grantRoot == null &&
        targets.every((path) => isRoutineWrite(cwd, path))
      ) {
        return rpc.respond(id, { decision: 'accept' });
      }
      const names = changes.map(
        (change) => toWorkspaceRelative(cwd, change.path) ?? '(outside the workspace)',
      );
      const sensitive = targets.some((path) => {
        const target = resolveWriteTarget(cwd, path);
        return target !== null && isSensitivePath(target);
      });
      return this.ask(id, null, {
        detail: this.redactFull(
          changes.map((change, index) => `${names[index]}\n${change.diff}`).join('\n'),
        ),
        kind: 'file_change',
        title: `Edit ${names.join(', ') || 'files'}${sensitive ? ' (sensitive path)' : ''}`,
      });
    }
    rpc.respondError(id, -32601, `BAIOS does not handle ${method}.`);
  }

  private ask(
    rpcId: RpcId,
    available: unknown[] | null,
    request: { detail: string; kind: RunApprovalKind; title: string },
  ): void {
    const requestId = `codex-${String(rpcId)}`;
    const timer = setTimeout(
      () => this.respondApproval(requestId, 'deny'),
      LOCAL_AGENT_APPROVAL_TIMEOUT_SECONDS * 1_000,
    );
    this.approvals.set(requestId, { available, rpcId, timer });
    const cut = request.detail.length > MAX_DETAIL ? ' (truncated)' : '';
    this.emit({
      data: {
        detail: truncate(request.detail, MAX_DETAIL),
        kind: request.kind,
        requestId,
        title: truncate(`${request.title || 'Approval needed'}${cut}`, 200),
      },
      type: 'approval.request',
    });
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    log.debug(`codex exited code=${code} signal=${signal}`);
    if (this.finished) return;
    if (this.interruptRequested) return this.finish({ status: 'interrupted' });
    const tail = this.stderr.text();
    this.fail(
      'crash',
      `${NAME} exited unexpectedly (${signal ?? `code ${code}`}).${tail ? `\n${tail}` : ''}`,
    );
  }

  private fail(failureClass: FailureClass, message: string): void {
    this.finish({
      failure: {
        class: failureClass,
        message: truncate(this.redact(scrub(message.trim())), 4_000),
      },
      status: 'failed',
    });
  }

  private finish(data: TerminalData): void {
    if (this.finished) return;
    this.events.push({ data, type: 'terminal' });
    this.finished = true;
    this.events.end();
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    for (const pending of this.approvals.values()) clearTimeout(pending.timer);
    this.approvals.clear();
  }

  private sendInterrupt(): void {
    if (!this.rpc || !this.threadId || !this.turnId) return;
    this.rpc
      .request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, this.graceMs)
      .catch(() => undefined);
  }

  input(text: string): void {
    if (this.finished || !this.rpc || !this.threadId || !this.turnId) return;
    this.rpc
      .request('turn/steer', {
        expectedTurnId: this.turnId,
        input: [{ text, text_elements: [], type: 'text' }],
        threadId: this.threadId,
      })
      .catch((error: unknown) => log.warn(`Codex did not take the extra input: ${String(error)}`));
  }

  interrupt(): void {
    if (this.finished || this.interruptRequested) return;
    const child = this.child;
    if (!child) return this.finish({ status: 'interrupted' });
    this.interruptRequested = true;
    for (const requestId of [...this.approvals.keys()]) this.respondApproval(requestId, 'deny');
    this.sendInterrupt();
    this.interruptTimer = setTimeout(() => {
      log.warn('Codex did not stop after an interrupt; killing it.');
      void killTree(child);
      this.finish({ status: 'interrupted' });
    }, this.graceMs);
  }

  respondApproval(requestId: string, decision: RunApprovalDecision): void {
    const pending = this.approvals.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.approvals.delete(requestId);
    this.rpc?.respond(pending.rpcId, { decision: codexDecision(decision, pending.available) });
  }

  /** Sandbox tool calls never start here (see `launch`). */
  resolveToolCall(): void {
    return;
  }

  dispose(): Promise<void> {
    this.disposing ??= (async () => {
      this.finish({ status: 'interrupted' });
      if (this.child) await shutdownChild(this.child, this.graceMs);
    })();
    return this.disposing;
  }
}

async function probeAppServer(
  binary: NonNullable<ReturnType<typeof resolveBinary>>,
): Promise<Pick<ProviderProbe, 'auth' | 'models'>> {
  const child = spawnBinary(binary, ['app-server']);
  child.stderr?.resume();
  child.once('error', () => undefined);
  const rpc = new CodexRpc(child, {
    onNotification: () => undefined,
    onRequest: (id) => rpc.respondError(id, -32601, 'Not handled while probing.'),
  });
  try {
    await initializeCodex(rpc, COMPANION_VERSION);
    const auth = codexAuth(await rpc.request('account/read', { refreshToken: false }, 15_000));
    const models = await rpc
      .request('model/list', {}, 15_000)
      .then(codexModels)
      .catch(() => []);
    return { auth, models };
  } finally {
    await shutdownChild(child, 2_000);
  }
}

const redactHome = redactPaths(null, Infinity);

export function createCodexAdapter(ctx: AdapterContext): ProviderAdapter {
  return {
    id: 'codex',
    async probe() {
      const binary = resolveBinary('codex', ctx.binary);
      if (!binary) return notInstalled(NAME, 'codex');
      let version: string | null;
      try {
        const result = await runCapture(binary, ['--version']);
        version = /(\d+\.\d+\.\d+\S*)/.exec(result.stdout)?.[1] ?? null;
      } catch (error) {
        return {
          ...notInstalled(NAME, 'codex'),
          message: truncate(
            `${NAME} could not be started: ${redactHome(scrub(String(error)))}`,
            500,
          ),
        };
      }
      let found: Pick<ProviderProbe, 'auth' | 'models'> = {
        auth: { method: null, plan: null, status: 'unknown' },
        models: [],
      };
      let message: string | null = null;
      try {
        found = await probeAppServer(binary);
      } catch (error) {
        message = truncate(
          `Could not read the sign-in state: ${redactHome(scrub(String(error)))}`,
          500,
        );
      }
      if (found.auth.status === 'unauthenticated') {
        message = 'Not signed in. Run `baios-companion login codex`.';
      }
      return { ...found, installed: true, message, version };
    },
    startRun: (options) => new CodexRun(ctx, options),
  };
}
