import type {
  CompanionRunEvent,
  CompanionToolDefinition,
  LocalAgentPermissionMode,
  LocalAgentProvider,
  LocalAgentProviderStatus,
  RunApprovalDecision,
} from '@repo/contracts';

/**
 * The one interface every CLI implements (spec 040 § 7). Transport code only sees this, so a new
 * provider is a new folder plus one line in `registry.ts`.
 */

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A run event before the uplink numbers it. */
export type RunEventBody = DistributiveOmit<CompanionRunEvent, 'seq'>;

/** What a probe finds; the server fills in `policy`, the companion adds `provider`/`checkedAt`. */
export type ProviderProbe = Pick<
  LocalAgentProviderStatus,
  'auth' | 'installed' | 'message' | 'models' | 'version'
>;

export interface StartRunOptions {
  /** Absolute workspace path (realpath); the CLI's cwd. Never sent to the server. */
  cwd: string;
  model: string | null;
  /** Already clamped to the local ceiling. */
  permissionMode: LocalAgentPermissionMode;
  prompt: string;
  /** Provider session/thread id to continue. */
  resume: string | null;
  /**
   * Sandbox tool mode: the CLI's own tools are off and only these BAIOS tools exist, each call
   * relayed as a `tool.call` event. `cwd` is then an empty temp dir. Null in workspace mode.
   */
  toolset: CompanionToolDefinition[] | null;
}

/** BAIOS's answer to a `tool.call`. */
export interface ToolCallResult {
  isError: boolean;
  output: string;
}

export interface RunHandle {
  /** Normalized events, ending with exactly one `terminal`, then the iterator completes. */
  events: AsyncIterable<RunEventBody>;
  input(text: string): void;
  interrupt(): void;
  respondApproval(requestId: string, decision: RunApprovalDecision, message?: string): void;
  /** Answers a pending `tool.call`; an unknown or settled `callId` is ignored. */
  resolveToolCall(callId: string, result: ToolCallResult): void;
  /** Stops the CLI (gracefully, then the process tree) and removes temp files. Idempotent. */
  dispose(): Promise<void>;
}

export interface ProviderAdapter {
  readonly id: LocalAgentProvider;
  probe(): Promise<ProviderProbe>;
  startRun(options: StartRunOptions): RunHandle;
}

export interface AdapterContext {
  /** Config override for the CLI binary. */
  binary?: string;
  /** How long `interrupt()` waits for the CLI before killing the process tree. */
  interruptGraceMs?: number;
  /** The companion's own entry script, re-run as `mcp-approval`. */
  selfScript: string;
  /** Claude `--setting-sources`; unset keeps the person's normal settings. */
  settingSources?: string;
  /** How long a sandbox tool call waits for BAIOS before failing (default 180 s). */
  toolCallTimeoutMs?: number;
}

export const DEFAULT_INTERRUPT_GRACE_MS = 5_000;

export function notInstalled(name: string, provider: LocalAgentProvider): ProviderProbe {
  return {
    auth: { method: null, plan: null, status: 'unknown' },
    installed: false,
    message: `${name} isn't installed on this computer (or not on PATH). Install it, then run \`baios-companion login ${provider}\`.`,
    models: [],
    version: null,
  };
}
