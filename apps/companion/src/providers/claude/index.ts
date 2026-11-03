import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

import {
  LOCAL_AGENT_APPROVAL_TIMEOUT_SECONDS,
  LOCAL_AGENT_MAX_TOOL_INPUT_CHARS,
  type LocalAgentPermissionMode,
  localAgentModelSchema,
  localAgentProviderSessionIdSchema,
  localAgentSandboxToolSchema,
  type RunApprovalDecision,
  type RunApprovalKind,
  sandboxToolOf,
  truncateToolOutput,
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
import {
  type AdapterContext,
  DEFAULT_INTERRUPT_GRACE_MS,
  notInstalled,
  type ProviderAdapter,
  type ProviderProbe,
  type RunEventBody,
  type RunHandle,
  type StartRunOptions,
  type ToolCallResult,
} from '../types.ts';
import {
  APPROVAL_ENDPOINT_ENV,
  APPROVAL_TOKEN_ENV,
  type ApprovalBridge,
  type ApprovalRequest,
  type ApprovalResult,
  openApprovalBridge,
} from './approval-bridge.ts';
import { TOOLSET_FILE_ENV } from './mcp-approval.ts';

/**
 * Claude Code (`claude -p`, stream-json in and out). One run is one prompt; the process is fed
 * the prompt as a stream-json user line and its stdin is closed after the final `result`.
 * Approvals arrive through `--permission-prompt-tool mcp__baios__approve`.
 */

const NAME = 'Claude Code';
const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit', 'Write']);
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);
/** In `plan` these may still be asked about; anything else is denied here, never sent to BAIOS. */
const PLAN_TOOLS = new Set(['Glob', 'Grep', 'LS', 'Read', 'TodoWrite']);
/** Longer than this cannot be shown whole for approval, so a command is denied rather than cut. */
const MAX_DETAIL = 8_000;
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 180_000;
/** Claude's own wait for an MCP call; longer than ours, so ours always answers first. */
const MCP_TIMEOUT_MS = 600_000;
/** Sandbox tool calls one run may have waiting on BAIOS at once. */
export const MAX_PENDING_TOOL_CALLS = 8;
const MODELS = [
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'opus', label: 'Opus' },
  { id: 'fable', label: 'Fable' },
];
/**
 * 2.1.x names the ask-for-everything mode `manual` (shown as `default` in `system/init`). Our
 * `acceptEdits` runs the CLI in `manual` too: the CLI's own `acceptEdits` accepts edits without
 * consulting the prompt tool, so the companion accepts routine edits itself and still asks for
 * sensitive or outside-the-workspace ones.
 */
const PERMISSION_FLAG: Record<LocalAgentPermissionMode, string> = {
  acceptEdits: 'manual',
  default: 'manual',
  plan: 'plan',
};

type TerminalData = Extract<RunEventBody, { type: 'terminal' }>['data'];

/**
 * Sandbox tool mode (verified live against Claude Code 2.1.316): `--tools` is an allowlist of
 * built-ins, so every file/shell/search tool is gone from the model's list ("Agent" shows as
 * "Task"; WebFetch is left out because it could reach internal addresses from where the CLI
 * runs). The `baios` MCP tools and WebSearch are pre-approved and `dontAsk` refuses everything
 * else without a prompt tool; `--restricted` also refuses bypassPermissions. No setting sources,
 * slash commands, memory, attachments or CLAUDE.md files. Never add a bypass/"dangerously" flag.
 */
export function sandboxModeArgs(): string[] {
  return [
    '--tools',
    'Agent,WebSearch,TaskCreate,TaskGet,TaskList,TaskUpdate',
    '--allowedTools',
    'mcp__baios,WebSearch',
    '--permission-mode',
    'dontAsk',
    '--restricted',
    '--setting-sources',
    '',
    '--disable-slash-commands',
  ];
}

/** The CLI's environment in sandbox mode, beside `sandboxModeArgs()`. */
export const SANDBOX_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_ATTACHMENTS: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  // Otherwise a call over 2 minutes is moved to a background task.
  CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0',
  MCP_TOOL_TIMEOUT: String(MCP_TIMEOUT_MS),
};

/** `claude auth status` JSON → method/plan. Never keeps email or org fields. */
export function claudeAuth(status: unknown): ProviderProbe['auth'] {
  if (!isRecord(status)) return { method: null, plan: null, status: 'unknown' };
  const method = str(status.authMethod);
  if (status.loggedIn === false || method === 'none') {
    return { method: null, plan: null, status: 'unauthenticated' };
  }
  const plan = str(status.subscriptionType);
  switch (method) {
    case 'claude.ai':
    case 'oauth_token':
      return {
        method: 'subscription',
        plan: plan ? truncate(plan.charAt(0).toUpperCase() + plan.slice(1), 100) : null,
        status: 'authenticated',
      };
    case 'api_key':
    case 'api_key_helper':
      return { method: 'api_key', plan: null, status: 'authenticated' };
    case 'third_party':
      return { method: 'cloud_provider', plan: null, status: 'authenticated' };
    default:
      return {
        method: status.loggedIn === true ? 'unknown' : null,
        plan: null,
        status: status.loggedIn === true ? 'authenticated' : 'unknown',
      };
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim()) as unknown;
  } catch {
    return undefined;
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (isRecord(block) && block.type === 'text' ? (str(block.text) ?? '') : ''))
    .join('\n');
}

interface PendingToolCall {
  resolve: (result: ToolCallResult) => void;
  timer: NodeJS.Timeout;
}

interface PendingApproval {
  input: Record<string, unknown>;
  resolve: (result: ApprovalResult) => void;
  timer: NodeJS.Timeout;
}

class ClaudeRun implements RunHandle {
  readonly events = new AsyncQueue<RunEventBody>();
  private readonly approvals = new Map<string, PendingApproval>();
  private apiError: string | null = null;
  private bridge: ApprovalBridge | null = null;
  private child: ChildProcess | null = null;
  private readonly ctx: AdapterContext;
  private disposing: Promise<void> | null = null;
  private finished = false;
  /** Input written since the current turn's `system/init`, so its `result` may not be the last. */
  private inputSinceTurnStart = false;
  private interruptRequested = false;
  private interruptTimer: NodeJS.Timeout | null = null;
  private limitResetsAt: string | undefined;
  private readonly options: StartRunOptions;
  private readonly redact: <T>(value: T) => T;
  /** The same rewriting without the length cut, for streamed text. */
  private readonly redactFull: <T>(value: T) => T;
  private sessionId: string | null = null;
  private settleTimer: NodeJS.Timeout | null = null;
  private readonly stderr = new StderrTail();
  private tempDir: string | null = null;
  private readonly toolCalls = new Map<string, PendingToolCall>();
  private readonly tools = new Map<string, { input: Record<string, unknown>; name: string }>();

  constructor(ctx: AdapterContext, options: StartRunOptions) {
    this.ctx = ctx;
    this.options = options;
    this.redact = redactPaths(options.cwd);
    this.redactFull = redactPaths(options.cwd, Infinity);
    this.launch().catch((error: unknown) =>
      this.fail('crash', `${NAME} could not be started: ${String(error)}`),
    );
  }

  private get graceMs(): number {
    return this.ctx.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS;
  }

  private async launch(): Promise<void> {
    const binary = resolveBinary('claude', this.ctx.binary);
    if (!binary) return this.fail('provider', notInstalled(NAME, 'claude').message ?? NAME);
    const { model, permissionMode, prompt, resume } = this.options;
    // The contract checked these on receipt; they reach argv, so never trust one layer alone.
    if (model !== null && !localAgentModelSchema.safeParse(model).success) {
      return this.fail('provider', 'The requested model name is not valid.');
    }
    if (resume !== null && !localAgentProviderSessionIdSchema.safeParse(resume).success) {
      return this.fail('provider', 'The session to resume is not a valid session id.');
    }
    // mkdtemp creates the directory 0700, so the socket and MCP config inside are private.
    this.tempDir = await mkdtemp(join(tmpdir(), 'baios-run-'));
    this.bridge = await openApprovalBridge(
      this.tempDir,
      (request) => this.onApproval(request),
      (name, input) => this.onToolCall(name, input),
    );
    const { toolset } = this.options;
    const toolsetFile = join(this.tempDir, 'toolset.json');
    // A file rather than env or argv: schemas can outgrow either.
    if (toolset) await writeFile(toolsetFile, JSON.stringify(toolset), { mode: 0o600 });
    const mcpConfig = join(this.tempDir, 'mcp.json');
    await writeFile(
      mcpConfig,
      JSON.stringify({
        mcpServers: {
          baios: {
            args: [this.ctx.selfScript, 'mcp-approval'],
            command: process.execPath,
            env: {
              [APPROVAL_ENDPOINT_ENV]: this.bridge.endpoint,
              [APPROVAL_TOKEN_ENV]: this.bridge.token,
              ...(toolset ? { [TOOLSET_FILE_ENV]: toolsetFile } : {}),
            },
            ...(toolset ? { timeout: MCP_TIMEOUT_MS } : {}),
            type: 'stdio',
          },
        },
      }),
      { mode: 0o600 },
    );
    // Interrupted (maybe already disposed) while setting up: nothing else will clean these up.
    if (this.finished) return this.cleanup();

    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json'];
    args.push('--verbose', '--include-partial-messages');
    // `--flag=value` keeps each value bound to its flag (`--resume` takes an *optional* value).
    if (model) args.push(`--model=${model}`);
    if (resume) args.push(`--resume=${resume}`);
    args.push('--mcp-config', mcpConfig, '--strict-mcp-config');
    if (toolset) {
      args.push(...sandboxModeArgs());
    } else {
      args.push(`--permission-mode=${PERMISSION_FLAG[permissionMode]}`);
      if (this.ctx.settingSources) args.push(`--setting-sources=${this.ctx.settingSources}`);
      args.push('--permission-prompt-tool', 'mcp__baios__approve');
    }

    const child = spawnBinary(binary, args, {
      cwd: this.options.cwd,
      ...(toolset ? { env: { ...process.env, ...SANDBOX_ENV } } : {}),
    });
    this.child = child;
    child.stdin?.on('error', () => undefined);
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr.push(chunk);
      log.debug(`claude stderr: ${chunk.toString().trimEnd()}`);
    });
    child.once('error', (error) =>
      this.fail('crash', `${NAME} could not be started: ${error.message}`),
    );
    child.once('exit', (code, signal) => this.onExit(code, signal));
    if (child.stdout) {
      createInterface({ crlfDelay: Infinity, input: child.stdout }).on('line', (line) =>
        this.onLine(line),
      );
    }
    this.write({
      message: { content: prompt, role: 'user' },
      parent_tool_use_id: null,
      type: 'user',
    });
  }

  private write(message: Record<string, unknown>): void {
    const stdin = this.child?.stdin;
    if (stdin?.writable) stdin.write(`${JSON.stringify(message)}\n`);
  }

  private emit(event: RunEventBody): void {
    if (!this.finished) this.events.push(event);
  }

  private onLine(line: string): void {
    const message = parseJson(line);
    if (!isRecord(message)) return;
    log.debug(`claude ${str(message.type) ?? '?'} ${str(message.subtype) ?? ''}`);
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          // `system/init` starts every turn; only a new session id is news.
          this.inputSinceTurnStart = false;
          this.clearSettle();
          const id = str(message.session_id);
          if (id && id !== this.sessionId) {
            this.sessionId = id;
            this.emit({ data: { providerSessionId: id }, type: 'session' });
          }
        } else if (message.subtype === 'api_retry') {
          this.apiError = str(message.error) ?? this.apiError;
        }
        return;
      case 'stream_event':
        return this.onStreamEvent(message.event);
      case 'assistant':
        return this.onAssistant(message);
      case 'user':
        return this.onUser(message);
      case 'rate_limit_event': {
        const info = isRecord(message.rate_limit_info) ? message.rate_limit_info : {};
        if (info.status === 'rejected') {
          this.apiError ??= 'rate_limit';
          if (typeof info.resetsAt === 'number') {
            this.limitResetsAt = new Date(info.resetsAt * 1_000).toISOString();
          }
        }
        return;
      }
      case 'result':
        return this.onResult(message);
      default:
        return;
    }
  }

  private onStreamEvent(event: unknown): void {
    if (!isRecord(event) || event.type !== 'content_block_delta' || !isRecord(event.delta)) return;
    const delta = event.delta;
    // shortcut: a secret split across two deltas is not caught; scrub whole blocks if that matters.
    if (delta.type === 'text_delta' && str(delta.text)) {
      this.emit({ data: { text: this.redactFull(str(delta.text) ?? '') }, type: 'text.delta' });
    } else if (delta.type === 'thinking_delta' && str(delta.thinking)) {
      this.emit({
        data: { text: this.redactFull(str(delta.thinking) ?? '') },
        type: 'reasoning.delta',
      });
    }
  }

  private onAssistant(message: Record<string, unknown>): void {
    this.apiError = str(message.error) ?? this.apiError;
    const body = isRecord(message.message) ? message.message : {};
    if (!Array.isArray(body.content)) return;
    for (const block of body.content as unknown[]) {
      if (!isRecord(block) || block.type !== 'tool_use') continue;
      const id = str(block.id);
      const name = str(block.name);
      if (!id || !name || this.tools.has(id)) continue;
      const input = isRecord(block.input) ? block.input : {};
      this.tools.set(id, { input, name });
      // A sandbox tool: the server reports its start and end itself.
      if (sandboxToolOf(name)) continue;
      this.emit({
        data: { input: this.redact(input), name: truncate(name, 200), toolId: truncate(id, 128) },
        type: 'tool.start',
      });
    }
  }

  private onUser(message: Record<string, unknown>): void {
    const body = isRecord(message.message) ? message.message : {};
    if (!Array.isArray(body.content)) return;
    const meta = isRecord(message.tool_use_result) ? message.tool_use_result : {};
    for (const block of body.content as unknown[]) {
      if (!isRecord(block) || block.type !== 'tool_result') continue;
      const id = str(block.tool_use_id);
      if (!id) continue;
      const tool = this.tools.get(id);
      if (tool && sandboxToolOf(tool.name)) continue;
      const ok = block.is_error !== true;
      const summary = this.redact(truncate(toolResultText(block.content), 2_000));
      this.emit({
        data: { ok, summary: summary || null, toolId: truncate(id, 128) },
        type: 'tool.end',
      });
      if (!ok || !tool || !FILE_TOOLS.has(tool.name)) continue;
      const path = str(tool.input.file_path) ?? str(tool.input.notebook_path);
      const relative = path ? toWorkspaceRelative(this.options.cwd, path) : null;
      if (!relative) continue;
      const kind = tool.name === 'Write' && meta.type === 'create' ? 'created' : 'modified';
      this.emit({ data: { kind, path: relative }, type: 'file.change' });
    }
  }

  private onResult(message: Record<string, unknown>): void {
    const usage = isRecord(message.usage) ? message.usage : {};
    const count = (key: string) => (typeof usage[key] === 'number' ? usage[key] : 0);
    this.emit({
      data: {
        inputTokens:
          count('input_tokens') +
          count('cache_creation_input_tokens') +
          count('cache_read_input_tokens'),
        outputTokens: count('output_tokens'),
      },
      type: 'usage',
    });
    const failed = message.is_error === true || (str(message.subtype) ?? 'success') !== 'success';
    if (failed && this.interruptRequested) return this.finish({ status: 'interrupted' });
    if (failed) return this.failFromResult(message);
    // More turns follow when the CLI says so. Input sent mid-turn may have been folded into this
    // turn or may start the next one, so then wait briefly for a next `system/init`.
    if (typeof message.queued_turn_count === 'number' && message.queued_turn_count > 0) return;
    if (!this.inputSinceTurnStart) return this.finish({ status: 'completed' });
    this.clearSettle();
    this.settleTimer = setTimeout(() => this.finish({ status: 'completed' }), this.graceMs);
  }

  private clearSettle(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  private failFromResult(message: Record<string, unknown>): void {
    const errors = Array.isArray(message.errors)
      ? (message.errors as unknown[]).filter((item) => typeof item === 'string')
      : [];
    const text = [str(message.result), ...errors].filter(Boolean).join('\n');
    const status = typeof message.api_error_status === 'number' ? message.api_error_status : null;
    const error = this.apiError;
    if (
      error === 'authentication_failed' ||
      error === 'oauth_org_not_allowed' ||
      status === 401 ||
      /not logged in|\/login|invalid api key|authentication|oauth token/i.test(text)
    ) {
      return this.fail(
        'auth',
        `${NAME} is not signed in, or its sign-in expired. Run \`baios-companion login claude\`. ${text}`,
      );
    }
    if (
      error === 'rate_limit' ||
      error === 'billing_error' ||
      status === 429 ||
      this.limitResetsAt !== undefined ||
      /usage limit|rate limit|limit reached|credits/i.test(text)
    ) {
      return this.fail('usage_limit', text || `${NAME} usage limit reached.`, this.limitResetsAt);
    }
    this.fail('provider', text || `${NAME} ended with ${str(message.subtype) ?? 'an error'}.`);
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    log.debug(`claude exited code=${code} signal=${signal}`);
    if (this.finished) return; // e.g. exit 1 after closing stdin following an error result
    if (this.interruptRequested) return this.finish({ status: 'interrupted' });
    const tail = this.stderr.text();
    this.fail(
      'crash',
      `${NAME} exited unexpectedly (${signal ?? `code ${code}`}).${tail ? `\n${tail}` : ''}`,
    );
  }

  private fail(
    failureClass: NonNullable<TerminalData['failure']>['class'],
    message: string,
    resetsAt?: string,
  ): void {
    const failure = {
      class: failureClass,
      message: truncate(this.redact(scrub(message.trim())), 4_000),
      ...(resetsAt ? { resetsAt } : {}),
    };
    this.finish({ failure, status: 'failed' });
  }

  private finish(data: TerminalData): void {
    if (this.finished) return;
    this.events.push({ data, type: 'terminal' });
    this.finished = true;
    this.events.end();
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    this.clearSettle();
    this.denyPending('The run ended before an answer.');
    this.failToolCalls('The run ended before BAIOS returned the tool result.');
    this.child?.stdin?.end();
  }

  private denyPending(message: string, interrupt = false): void {
    for (const [id, pending] of this.approvals) {
      clearTimeout(pending.timer);
      pending.resolve({ behavior: 'deny', message, ...(interrupt ? { interrupt } : {}) });
      this.approvals.delete(id);
    }
  }

  private failToolCalls(output: string): void {
    for (const [callId, pending] of this.toolCalls) {
      clearTimeout(pending.timer);
      pending.resolve({ isError: true, output });
      this.toolCalls.delete(callId);
    }
  }

  private onToolCall(name: string, input: Record<string, unknown>): Promise<ToolCallResult> {
    const refuse = (output: string) => Promise.resolve({ isError: true, output });
    if (this.finished || this.interruptRequested || !this.options.toolset) {
      return refuse('The run has ended.');
    }
    const tool = localAgentSandboxToolSchema.safeParse(name);
    if (!tool.success) return refuse(`${name} is not a BAIOS sandbox tool.`);
    if (this.toolCalls.size >= MAX_PENDING_TOOL_CALLS)
      return refuse('Too many concurrent tool calls');
    // The uplink would drop a larger call, leaving the CLI waiting for the timeout.
    if (JSON.stringify(input).length > LOCAL_AGENT_MAX_TOOL_INPUT_CHARS) {
      return refuse('The tool input is too large to send to BAIOS.');
    }
    const callId = `call-${randomUUID()}`;
    // Exact input (it came off JSON, so it is JSON): BAIOS runs it, so nothing is redacted.
    this.emit({
      data: { callId, input, name: tool.data },
      type: 'tool.call',
    });
    const timeoutMs = this.ctx.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.toolCalls.delete(callId);
        resolve({
          isError: true,
          output: `BAIOS did not return the ${name} result within ${Math.ceil(timeoutMs / 1_000)} s.`,
        });
      }, timeoutMs);
      this.toolCalls.set(callId, { resolve, timer });
    });
  }

  resolveToolCall(callId: string, result: ToolCallResult): void {
    const pending = this.toolCalls.get(callId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.toolCalls.delete(callId);
    // Claude saves a longer MCP result to a local file the model cannot read.
    pending.resolve({ ...result, output: truncateToolOutput(result.output) });
  }

  private onApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    const deny = (message: string) =>
      Promise.resolve<ApprovalResult>({ behavior: 'deny', message });
    if (this.finished) return deny('The run has ended.');
    const { input, toolName } = request;
    // Sandbox mode pre-approves its own tools; nothing else may run on this machine.
    if (this.options.toolset)
      return deny(`Only BAIOS sandbox tools are available; ${toolName} was not run.`);
    const { cwd, permissionMode } = this.options;
    // The local ceiling (ADR decision 6): plan is read-only whatever BAIOS would answer.
    if (permissionMode === 'plan' && !PLAN_TOOLS.has(toolName)) {
      return deny(
        `Plan mode on this computer allows read-only tools only; ${toolName} was not run.`,
      );
    }
    if (COMMAND_TOOLS.has(toolName) && (str(input.command) ?? '').length > MAX_DETAIL) {
      return deny('The command is too long to show in BAIOS for approval, so it was not run.');
    }
    const target = str(input.file_path) ?? str(input.notebook_path);
    if (
      permissionMode === 'acceptEdits' &&
      FILE_TOOLS.has(toolName) &&
      target !== undefined &&
      isRoutineWrite(cwd, target)
    ) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }
    const requestId =
      request.toolUseId && request.toolUseId.length <= 128 && !this.approvals.has(request.toolUseId)
        ? request.toolUseId
        : `approval-${randomUUID()}`;
    this.emit({ data: { ...this.describe(request), requestId }, type: 'approval.request' });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.approvals.delete(requestId);
        resolve({ behavior: 'deny', message: 'No answer from BAIOS in time.' });
      }, LOCAL_AGENT_APPROVAL_TIMEOUT_SECONDS * 1_000);
      this.approvals.set(requestId, { input: request.input, resolve, timer });
    });
  }

  private describe(request: ApprovalRequest): {
    detail: string;
    kind: RunApprovalKind;
    title: string;
  } {
    const { toolName } = request;
    // Cut only at the end, so "(truncated)" in the title reflects what the person cannot see.
    const input = this.redactFull(request.input);
    const shown = (detail: string, title: string) => ({
      detail: truncate(detail, MAX_DETAIL),
      title: truncate(detail.length > MAX_DETAIL ? `${title} (truncated)` : title, 200),
    });
    const json = () => JSON.stringify(input, null, 2);
    if (COMMAND_TOOLS.has(toolName)) {
      const command = str(input.command) ?? json();
      const firstLine = command.split('\n')[0] ?? '';
      return { ...shown(command, `${toolName}: ${firstLine}`), kind: 'command' };
    }
    if (FILE_TOOLS.has(toolName)) {
      const raw = str(request.input.file_path) ?? str(request.input.notebook_path);
      const resolved = raw ? resolveWriteTarget(this.options.cwd, raw) : null;
      const target = raw
        ? (toWorkspaceRelative(this.options.cwd, raw) ?? `${basename(raw)} (outside the workspace)`)
        : 'a file';
      const flag = resolved !== null && isSensitivePath(resolved) ? ' (sensitive path)' : '';
      const detail =
        str(input.content) ??
        (str(input.new_string) !== undefined
          ? `- ${str(input.old_string) ?? ''}\n+ ${str(input.new_string) ?? ''}`
          : json());
      return { ...shown(detail, `${toolName} ${target}${flag}`), kind: 'file_change' };
    }
    return { ...shown(json(), `Use ${toolName}`), kind: 'tool' };
  }

  input(text: string): void {
    if (this.finished || !this.child) return;
    this.inputSinceTurnStart = true;
    this.clearSettle();
    this.write({
      message: { content: text, role: 'user' },
      parent_tool_use_id: null,
      type: 'user',
    });
  }

  interrupt(): void {
    if (this.finished) return;
    const child = this.child;
    if (!child) return this.finish({ status: 'interrupted' });
    if (this.interruptRequested) return;
    this.interruptRequested = true;
    this.denyPending('Interrupted in BAIOS.', true);
    this.failToolCalls('Interrupted in BAIOS.');
    this.write({
      request: { subtype: 'interrupt' },
      request_id: `interrupt-${randomUUID()}`,
      type: 'control_request',
    });
    this.interruptTimer = setTimeout(() => {
      log.warn('Claude Code did not stop after an interrupt; killing it.');
      void killTree(child);
      this.finish({ status: 'interrupted' });
    }, this.graceMs);
  }

  respondApproval(requestId: string, decision: RunApprovalDecision, message?: string): void {
    const pending = this.approvals.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.approvals.delete(requestId);
    pending.resolve(
      decision === 'allow'
        ? { behavior: 'allow', updatedInput: pending.input }
        : { behavior: 'deny', message: message ?? 'Denied in BAIOS.' },
    );
  }

  private async cleanup(): Promise<void> {
    const { bridge, tempDir } = this;
    this.bridge = null;
    this.tempDir = null;
    await bridge?.close();
    if (tempDir) await rm(tempDir, { force: true, recursive: true });
  }

  dispose(): Promise<void> {
    this.disposing ??= (async () => {
      this.finish({ status: 'interrupted' });
      if (this.child) await shutdownChild(this.child, this.graceMs);
      await this.cleanup();
    })();
    return this.disposing;
  }
}

export function createClaudeAdapter(ctx: AdapterContext): ProviderAdapter {
  return {
    id: 'claude',
    async probe() {
      const binary = resolveBinary('claude', ctx.binary);
      if (!binary) return notInstalled(NAME, 'claude');
      let version: string | null;
      try {
        const result = await runCapture(binary, ['--version']);
        version = /(\d+\.\d+\.\d+\S*)/.exec(result.stdout)?.[1] ?? null;
      } catch (error) {
        return {
          ...notInstalled(NAME, 'claude'),
          message: truncate(
            `${NAME} could not be started: ${redactPaths(null, Infinity)(scrub(String(error)))}`,
            500,
          ),
        };
      }
      let auth: ProviderProbe['auth'] = { method: null, plan: null, status: 'unknown' };
      try {
        // Exit code is 1 when signed out; the JSON on stdout says so either way.
        auth = claudeAuth(parseJson((await runCapture(binary, ['auth', 'status'])).stdout));
      } catch {
        // stays unknown
      }
      const message =
        auth.status === 'unauthenticated'
          ? 'Not signed in. Run `baios-companion login claude`.'
          : auth.status === 'unknown'
            ? 'Could not read the sign-in state from `claude auth status`.'
            : null;
      return { auth, installed: true, message, models: MODELS, version };
    },
    startRun: (options) => new ClaudeRun(ctx, options),
  };
}
