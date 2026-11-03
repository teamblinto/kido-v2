/**
 * The run event stream's knobs (spec 009). A provider like `AGENT_TIMINGS`, so the e2e suite can
 * shorten a heartbeat or a cap on one application without a per-field env variable.
 */
export const STREAM_TIMINGS = Symbol('forge.agent.stream-timings');

export interface StreamTimings {
  /** `XREAD BLOCK`: how long one read waits before the reader gets its turn to heartbeat (§04). */
  readonly blockMs: number;
  /** A connection without a frame for this long gets `:heartbeat` — under every proxy's idle cut (§03). */
  readonly heartbeatMs: number;
  /** `MAXLEN ~` on every append: a run's stream holds its tail, Postgres holds its history (§04). */
  readonly maxLen: number;
  /** The Postgres page for a reset snapshot, a gap fill and the terminal drain. */
  readonly pageSize: number;
  /** The `retry:` hint the stream opens with (§03: the browser reconnects itself). */
  readonly retryMs: number;
  /** `EXPIRE` after every append: six hours past the last event the key is gone, the stream instance keeps no history (§09). */
  readonly ttlSeconds: number;
}

export const DEFAULT_STREAM_TIMINGS: StreamTimings = Object.freeze({
  blockMs: 15_000,
  heartbeatMs: 15_000,
  maxLen: 5_000,
  pageSize: 500,
  retryMs: 2_000,
  ttlSeconds: 21_600,
});

/** One key per run; the entry id is the seq (ADR 033). */
export function streamKey(runId: string): string {
  return `run:${runId}:events`;
}
