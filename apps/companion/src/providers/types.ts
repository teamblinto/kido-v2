import type {
  CompanionRunEvent,
  CompanionToolDefinition,
  LocalAgentProvider,
  LocalAgentProviderStatus,
} from '@repo/contracts';

/** The one interface a CLI implements (spec 040 § 7). Transport code only sees this. */

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A run event before the uplink numbers it. */
export type RunEventBody = DistributiveOmit<CompanionRunEvent, 'seq'>;

/** What a probe finds; the server fills in `policy`, the runner adds `provider`/`checkedAt`. */
export type ProviderProbe = Pick<
  LocalAgentProviderStatus,
  'auth' | 'installed' | 'message' | 'models' | 'version'
>;

export interface StartRunOptions {
  /** The CLI's cwd: an empty private directory, the same for every turn of a conversation. */
  cwd: string;
  model: string | null;
  prompt: string;
  /** Provider session id to continue. */
  resume: string | null;
  /**
   * The CLI's own file and shell tools are off and only these BAIOS tools exist, each call
   * relayed as a `tool.call` event (spec 041 sandbox tool mode).
   */
  toolset: CompanionToolDefinition[];
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
  /** The runner's own entry script, re-run as `mcp-tools`. */
  selfScript: string;
  /** How long a sandbox tool call waits for BAIOS before failing (default 180 s). */
  toolCallTimeoutMs?: number;
}

export const DEFAULT_INTERRUPT_GRACE_MS = 5_000;

export function notInstalled(name: string): ProviderProbe {
  return {
    auth: { method: null, plan: null, status: 'unknown' },
    installed: false,
    message: `${name} isn't installed in this agent home (or not on PATH).`,
    models: [],
    version: null,
  };
}
