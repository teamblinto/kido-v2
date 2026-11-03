import type {
  CompanionFailureClass,
  LocalAgentProvider,
  RunEvent,
  RunFailureClass,
  RunStatus,
} from '@repo/contracts';
import type { RunMessage } from '@repo/db';

/**
 * The boundary 011 implements (spec 008 contracts/executor-port.md). Bound by `AgentModule`
 * under `RUN_EXECUTOR`; the only implementation here is `ScriptedExecutor`.
 *
 * The consumer, not the executor, owns transitions: `starting → running` before `execute`, the
 * `tool_error` dance on a failed `tool.end`, and the outcome's transition after `execute`
 * returns. The executor only emits milestones and says how it ended.
 */
export interface RunSnapshot {
  readonly id: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly model: string;
  /** The person who started the run: only their own subscription may pay for it (032 R7). */
  readonly userId: string;
  /** 032 A3: `organisation` when the starter asked for the organisation's credential. */
  readonly credentialChoice?: 'organisation' | null;
  /** The claim's lease epoch (011): what the broker's `MutationContext.leaseEpoch` carries. */
  readonly epoch: number;
  /** The state the run was claimed in. */
  readonly status: RunStatus;
  /** Highest committed seq; 1 on a fresh run. */
  readonly lastSeq: number;
  readonly messages: readonly RunMessage[];
  readonly committed: {
    /** How many `tool.end` rows exist — the resume index. */
    readonly toolEnds: number;
    /** A `tool.start` with no `tool.end` — the step whose batch was lost (FR-019). */
    readonly openStepId: string | null;
    /** How many `paused` state events exist — the pause steps already taken. */
    readonly pauses: number;
  };
}

/**
 * What the executor may emit; `seq`, `run` and `at` are stamped by the batcher, not the executor.
 * Distributed over the union, so `event.type` still narrows `event.data`.
 */
export type EmittedEvent = RunEvent extends infer Event
  ? Event extends RunEvent
    ? Omit<Event, 'seq' | 'run' | 'at'>
    : never
  : never;

export interface ExecutionContext {
  readonly run: RunSnapshot;
  /** Fired on fence or shutdown. */
  readonly signal: AbortSignal;
  /** Throws `FencedError`; non-durable types are dropped here. */
  emit(event: EmittedEvent): Promise<void>;
  /**
   * 040: writes what `emit` has batched, under the fence (throws `FencedError` on a stale
   * attempt) — for an effect outside the database that must follow a durable event.
   */
  flush(): Promise<void>;
  /** Control channel OR row flag (research R7). */
  cancelled(): Promise<boolean>;
  // 011 — `ScriptedExecutor` ignores `persist`, `dispatch` and `run.epoch`.
  /** Fenced insert into run_messages; throws FencedError under a stale epoch (R4). */
  persist(message: {
    role: 'assistant' | 'tool';
    content: string;
    toolCalls?: unknown[];
  }): Promise<void>;
  /** Runs fn inside a tenant scope after a fenced heartbeat, so the sandbox port sees a tenant
   *  transaction and a stale worker never reaches Daytona (R5). */
  dispatch<T>(fn: () => Promise<T>): Promise<T>;
}

export type RunOutcome =
  | { kind: 'succeeded' }
  | { kind: 'awaiting_input' }
  | { kind: 'paused'; reason: string }
  | {
      kind: 'failed';
      failureClass: RunFailureClass;
      reason: string;
      /** 032 T046: when a subscription's limit resets; the `state` event carries it. */
      resetsAt?: Date;
      /** A subscription run's failure in the runner's vocabulary; the `state` event carries it. */
      localAgentFailure?: {
        class: CompanionFailureClass;
        origin?: 'device' | 'subscription';
        provider: LocalAgentProvider;
      };
    }
  /** Returned after `cancelled()` was true. */
  | { kind: 'stopped' };

export interface RunExecutor {
  /** Runs (or resumes) one run until it reaches an outcome, `cancelled()` is true, or `signal` fires. */
  execute(context: ExecutionContext): Promise<RunOutcome>;
}
