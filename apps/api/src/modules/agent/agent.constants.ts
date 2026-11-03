/**
 * The module's injection tokens and the timings its worker runs on (spec 008).
 *
 * `RUN_EXECUTOR` is the port the consumer calls (contracts/executor-port.md); this spec binds the
 * scripted fake, 011 binds the real one. `AGENT_TIMINGS` is a provider rather than a constant so
 * the fencing suite can shorten every interval at once without a per-field env variable.
 */
export const RUN_EXECUTOR = Symbol('forge.agent.run-executor');

export const AGENT_TIMINGS = Symbol('forge.agent.timings');

/** The queue `AgentRunConsumer` drains; the relay routes `agent-run.requested` to it. */
export const AGENT_QUEUE = 'agent.run';

/** The port `AgentModule` binds the real `LlmProvider` under (011). */
export const LLM_PROVIDER = Symbol('forge.agent.llm-provider');

/**
 * T030: the per-run tool allowlist, `@Optional()` on `AgentExecutor` so production keeps the
 * default (every tool) and the e2e suite can `overrideProvider` a narrower set.
 */
export const AGENT_ALLOWED_TOOLS = Symbol('forge.agent.allowed-tools');

/**
 * The transport `AnthropicProvider` builds every SDK client on (011 R1): `fetch` and `baseURL`
 * injectable so the adapter spec drives a loopback fake, as `DaytonaAdapter` takes its transport.
 */
export const ANTHROPIC_TRANSPORT = Symbol('forge.agent.anthropic-transport');

export interface AnthropicTransport {
  /** Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Defaults to the SDK's own (`https://api.anthropic.com`). */
  readonly baseURL?: string;
}

/** The same shape for `OpenAiProvider` (020 R3): `fetch` and `baseURL`, nothing else. */
export const OPENAI_TRANSPORT = Symbol('forge.agent.openai-transport');

export interface OpenAiTransport {
  /** Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Defaults to `https://api.openai.com/v1`. */
  readonly baseURL?: string;
}

/**
 * The advisory lock the reaper takes per sweep (`pg_try_advisory_xact_lock`, spec 013 R4): the
 * relay's shape with its own key, distinct from `OUTBOX_RELAY_LOCK = 7_301_005n`, so the two
 * never serialise against each other.
 */
export const RUN_REAPER_LOCK = 7_301_008n;

/** Per-run step ceiling (spec Assumptions); beyond it the run fails `executor`/`step-limit`. */
export const MAX_TOOL_CALLS = 50;

/** `max_tokens` on every model request — room for a whole-file `fs_edit`, not configuration. */
export const MAX_OUTPUT_TOKENS = 16_000;

export interface AgentTimings {
  /** Milestones are flushed at most this many at a time. */
  readonly batchSize: number;
  /** ...and at most this long after the first one was pushed. */
  readonly batchMs: number;
  /** The worker renews its lease this often. */
  readonly heartbeatMs: number;
  /** A lease lasts this long past its last renewal: three heartbeats, so one missed beat is not a stall. */
  readonly leaseTtlMs: number;
  /** The reaper runs this often, in every process. */
  readonly reaperMs: number;
  /** A leased run untouched for this long is `failed`/`stalled` — longer than BullMQ's stall budget. */
  readonly staleAfterMs: number;
  /** Transient provider failures are retried up to this many attempts total (R3). */
  readonly providerAttempts: number;
  /** Full-jitter backoff base between provider retries. */
  readonly providerBackoffBaseMs: number;
  /** Full-jitter backoff cap between provider retries. */
  readonly providerBackoffCapMs: number;
  /** `cancelled()` is polled at most this often while a model call streams (R9). */
  readonly cancelPollMs: number;
  /** The running-summary model call is abandoned after this long; the turn proceeds unsummarised (021 R8). */
  readonly summaryMs: number;
}

export const DEFAULT_AGENT_TIMINGS: AgentTimings = Object.freeze({
  batchMs: 250,
  batchSize: 32,
  heartbeatMs: 15_000,
  leaseTtlMs: 45_000,
  reaperMs: 30_000,
  staleAfterMs: 120_000,
  providerAttempts: 3,
  providerBackoffBaseMs: 1_000,
  providerBackoffCapMs: 10_000,
  cancelPollMs: 500,
  summaryMs: 30_000,
});

/** The repository map is truncated to this many bytes in the system prompt (021 FR-003). */
export const MAP_BUDGET_BYTES = 6_144;
/** The sandbox's map export is refused past this many bytes (021 R3). */
export const MAP_EXPORT_CAP_BYTES = 65_536;
/** A running summary is (re)built once the transcript exceeds this many tokens (021 FR-006). */
export const SUMMARY_THRESHOLD_TOKENS = 60_000;
/** The most recent turns kept verbatim after the summary (021 FR-007). */
export const SUMMARY_TAIL_TURNS = 6;

/** The provider the `PLATFORM` credential (`ANTHROPIC_API_KEY`) belongs to (020 T007). */
export const PLATFORM_PROVIDER = 'anthropic' as const;

/**
 * The most runs that may wait behind a project's holder (spec 031, research R3). A fixed number,
 * not a dial or a per-org limit: both were rejected as configuration nobody asked for. A start
 * beyond it is `409 conflict`, `reason: 'queue-full'`. Declared in `@repo/contracts`, because the
 * line's response schema bounds `waiting` by it; re-exported here so the module reads one name.
 */
export { RUN_LINE_LIMIT } from '@repo/contracts';

/**
 * The reaper re-requests the head of an unheld line that has waited this long (spec 031, R3) — the
 * backstop for a lost `agent-run.finished`. A tunable dial was rejected; one reaper tick is enough.
 */
export const RUN_LINE_SWEEP_AFTER_MS = 30_000;

/**
 * Spec 032 R3/R4: a BYOS access token with less than this left is refreshed before use — by the
 * token service at the start of an attempt and by the executor between turns (R10).
 */
export const REFRESH_FLOOR_MS = 300_000;
