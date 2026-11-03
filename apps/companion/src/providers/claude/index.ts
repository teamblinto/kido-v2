import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import {
  LOCAL_AGENT_MAX_TOOL_INPUT_CHARS,
  localAgentModelSchema,
  localAgentProviderSessionIdSchema,
  localAgentSandboxToolSchema,
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
import { AsyncQueue, isRecord, redactPaths, str, truncate } from '../../util.ts';
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
import { TOOLSET_FILE_ENV } from './mcp-tools.ts';
import { claudeDetails, planLabel } from './subscription.ts';
import {
  openToolBridge,
  TOOL_ENDPOINT_ENV,
  TOOL_TOKEN_ENV,
  type ToolBridge,
} from './tool-bridge.ts';

/**
 * Claude Code (`claude -p`, stream-json in and out). One run is one prompt; the process is fed
 * the prompt as a stream-json user line and its stdin is closed after the final `result`. Its own
 * file and shell tools are off; the run's BAIOS tools come from the `baios` MCP server.
 */

const NAME = 'Claude Code';
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 180_000;
/** Claude's own wait for an MCP call; longer than ours, so ours always answers first. */
const MCP_TIMEOUT_MS = 600_000;
/** Sandbox tool calls one run may have waiting on BAIOS at once. */
export const MAX_PENDING_TOOL_CALLS = 8;
const STREAM_JSON_ARGS = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
];
type TerminalData = Extract<RunEventBody, { type: 'terminal' }>['data'];

/**
 * Sandbox tool mode (verified live against Claude Code 2.1.316): `--tools` is an allowlist of
 * built-ins, so every file/shell/search tool is gone from the model's list ("Agent" shows as
 * "Task"; WebFetch is left out because it could reach internal addresses from where the CLI
 * runs). The `baios` MCP tools and WebSearch are pre-approved and `dontAsk` refuses everything
 * else without asking; `--restricted` also refuses bypassPermissions. No setting sources,
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

/** The CLI's environment, beside `sandboxModeArgs()`. */
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
  switch (method) {
    case 'claude.ai':
    case 'oauth_token':
      return {
        method: 'subscription',
        plan: planLabel(str(status.subscriptionType)),
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

/** A result's `total_cost_usd` in micro-USD, if it is a usable number. */
export function costMicrosOf(usd: unknown): number | undefined {
  return typeof usd === 'number' && Number.isFinite(usd) && usd >= 0
    ? Math.round(usd * 1_000_000)
    : undefined;
}

/**
 * This turn's cost from the CLI's running session total (cumulative across turns, and across a
 * resume): the rise since `previous`. A total below it means the CLI started counting afresh
 * (no saved total, a crash's zeroed result), so all of it is new.
 */
export function costRise(total: number, previous: number): number {
  return total >= previous ? total - previous : total;
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

class ClaudeRun implements RunHandle {
  readonly events = new AsyncQueue<RunEventBody>();
  private apiError: string | null = null;
  private bridge: ToolBridge | null = null;
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
  sessionCostMicros: number | undefined;
  private sessionId: string | null = null;
  private settleTimer: NodeJS.Timeout | null = null;
  private readonly stderr = new StderrTail();
  private tempDir: string | null = null;
  private readonly toolCalls = new Map<string, PendingToolCall>();
  /** Tool use id → tool name. */
  private readonly tools = new Map<string, string>();

  constructor(ctx: AdapterContext, options: StartRunOptions) {
    this.ctx = ctx;
    this.options = options;
    this.sessionCostMicros = options.sessionCostMicros;
    this.redact = redactPaths();
    this.redactFull = redactPaths(Infinity);
    this.launch().catch((error: unknown) =>
      this.fail('crash', `${NAME} could not be started: ${String(error)}`),
    );
  }

  private get graceMs(): number {
    return this.ctx.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS;
  }

  private async launch(): Promise<void> {
    const binary = resolveBinary('claude', this.ctx.binary);
    if (!binary) return this.fail('provider', notInstalled(NAME).message ?? NAME);
    const { model, prompt, resume, toolset } = this.options;
    // The contract checked these on receipt; they reach argv, so never trust one layer alone.
    if (model !== null && !localAgentModelSchema.safeParse(model).success) {
      return this.fail('provider', 'The requested model name is not valid.');
    }
    if (resume !== null && !localAgentProviderSessionIdSchema.safeParse(resume).success) {
      return this.fail('provider', 'The session to resume is not a valid session id.');
    }
    // mkdtemp creates the directory 0700, so the socket and MCP config inside are private.
    this.tempDir = await mkdtemp(join(tmpdir(), 'baios-run-'));
    this.bridge = await openToolBridge(this.tempDir, (name, input) => this.onToolCall(name, input));
    const toolsetFile = join(this.tempDir, 'toolset.json');
    // A file rather than env or argv: schemas can outgrow either.
    await writeFile(toolsetFile, JSON.stringify(toolset), { mode: 0o600 });
    const mcpConfig = join(this.tempDir, 'mcp.json');
    await writeFile(
      mcpConfig,
      JSON.stringify({
        mcpServers: {
          baios: {
            args: [this.ctx.selfScript, 'mcp-tools'],
            command: process.execPath,
            env: {
              [TOOL_ENDPOINT_ENV]: this.bridge.endpoint,
              [TOOL_TOKEN_ENV]: this.bridge.token,
              [TOOLSET_FILE_ENV]: toolsetFile,
            },
            timeout: MCP_TIMEOUT_MS,
            type: 'stdio',
          },
        },
      }),
      { mode: 0o600 },
    );
    // Interrupted (maybe already disposed) while setting up: nothing else will clean these up.
    if (this.finished) return this.cleanup();

    const args = [...STREAM_JSON_ARGS, '--include-partial-messages'];
    // `--flag=value` keeps each value bound to its flag (`--resume` takes an *optional* value).
    if (model) args.push(`--model=${model}`);
    if (resume) args.push(`--resume=${resume}`);
    args.push('--mcp-config', mcpConfig, '--strict-mcp-config', ...sandboxModeArgs());

    const child = spawnBinary(binary, args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...SANDBOX_ENV },
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
      this.tools.set(id, name);
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
    for (const block of body.content as unknown[]) {
      if (!isRecord(block) || block.type !== 'tool_result') continue;
      const id = str(block.tool_use_id);
      if (!id) continue;
      const name = this.tools.get(id);
      if (name && sandboxToolOf(name)) continue;
      const ok = block.is_error !== true;
      const summary = this.redact(truncate(toolResultText(block.content), 2_000));
      this.emit({
        data: { ok, summary: summary || null, toolId: truncate(id, 128) },
        type: 'tool.end',
      });
    }
  }

  private onResult(message: Record<string, unknown>): void {
    const usage = isRecord(message.usage) ? message.usage : {};
    const count = (key: string) => (typeof usage[key] === 'number' ? usage[key] : 0);
    const total = costMicrosOf(message.total_cost_usd);
    const costMicros =
      total === undefined ? undefined : costRise(total, this.sessionCostMicros ?? 0);
    // A zeroed total (a crash or start-up error result) says nothing about the session's spend.
    if (total !== undefined && total > 0) this.sessionCostMicros = total;
    this.emit({
      data: {
        ...(costMicros === undefined ? {} : { costMicros }),
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
        `${NAME} is not signed in, or its sign-in expired. Sign in again from BAIOS. ${text}`,
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
    this.failToolCalls('The run ended before BAIOS returned the tool result.');
    this.child?.stdin?.end();
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
    if (this.finished || this.interruptRequested) {
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
      if (!binary) return notInstalled(NAME);
      let version: string | null;
      try {
        const result = await runCapture(binary, ['--version']);
        version = /(\d+\.\d+\.\d+\S*)/.exec(result.stdout)?.[1] ?? null;
      } catch (error) {
        return {
          ...notInstalled(NAME),
          message: truncate(
            `${NAME} could not be started: ${redactPaths(Infinity)(scrub(String(error)))}`,
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
          ? 'Not signed in. Sign in to Claude from BAIOS.'
          : auth.status === 'unknown'
            ? 'Could not read the sign-in state from `claude auth status`.'
            : null;
      // The models are the CLI's own list, asked by `details()` for a status report.
      return { auth, installed: true, message, models: [], version };
    },
    details() {
      const binary = resolveBinary('claude', ctx.binary);
      if (!binary) return Promise.resolve(null);
      // A run's flags and environment, no MCP servers, and no prompt is ever written.
      return claudeDetails(binary, {
        args: [...STREAM_JSON_ARGS, '--strict-mcp-config', ...sandboxModeArgs()],
        env: { ...process.env, ...SANDBOX_ENV },
      });
    },
    startRun: (options) => new ClaudeRun(ctx, options),
  };
}
