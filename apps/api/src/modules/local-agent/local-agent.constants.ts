import {
  LOCAL_AGENT_APPROVAL_TIMEOUT_SECONDS,
  LOCAL_AGENT_HEARTBEAT_SECONDS,
  LOCAL_AGENT_PAIRING_POLL_INTERVAL_SECONDS,
  LOCAL_AGENT_PAIRING_TTL_SECONDS,
  LOCAL_AGENT_PRESENCE_TTL_SECONDS,
  LOCAL_AGENT_RUN_IDLE_TIMEOUT_SECONDS,
} from '@repo/contracts';

/**
 * The bridge's timings (spec 040 § 5, § 6). A provider, as `AGENT_TIMINGS` is, so a suite can
 * shorten every interval at once without a per-field env variable.
 */
export const LOCAL_AGENT_TIMINGS = Symbol('forge.local-agent.timings');

export interface LocalAgentTimings {
  /** `:heartbeat` on the command stream, and the presence refresh with it. */
  readonly heartbeatMs: number;
  readonly presenceTtlSeconds: number;
  /** No companion event and no presence for this long fails a run `transport`. */
  readonly runIdleMs: number;
  /** A pending approval past this is denied `by: 'timeout'`. */
  readonly approvalTimeoutMs: number;
  readonly pairingTtlSeconds: number;
  readonly pairingIntervalSeconds: number;
  /** How long a run waits for its device to come online before failing offline. */
  readonly offlineGraceMs: number;
  /** After `run.interrupt`, how long the executor waits for the companion's terminal. */
  readonly interruptWaitMs: number;
  /** One `XREAD BLOCK` in the executor: the cadence of its timeout and cancel checks. */
  readonly readBlockMs: number;
  /** `cancelled()` is asked at most this often. */
  readonly cancelPollMs: number;
  /** After `run.start`, the companion's first event must arrive within this, or `transport`. */
  readonly startAckMs: number;
  /** One turn's ceiling, however busy the device (`LOCAL_AGENT_MAX_RUN_SECONDS`). */
  readonly maxRunMs: number;
  /** What one turn may upload, in bytes of event JSON; past it the run is failed. */
  readonly runEventBudgetBytes: number;
}

export const DEFAULT_LOCAL_AGENT_TIMINGS: LocalAgentTimings = Object.freeze({
  approvalTimeoutMs: LOCAL_AGENT_APPROVAL_TIMEOUT_SECONDS * 1_000,
  cancelPollMs: 1_000,
  heartbeatMs: LOCAL_AGENT_HEARTBEAT_SECONDS * 1_000,
  interruptWaitMs: 10_000,
  maxRunMs: 21_600_000,
  offlineGraceMs: 10_000,
  pairingIntervalSeconds: LOCAL_AGENT_PAIRING_POLL_INTERVAL_SECONDS,
  pairingTtlSeconds: LOCAL_AGENT_PAIRING_TTL_SECONDS,
  presenceTtlSeconds: LOCAL_AGENT_PRESENCE_TTL_SECONDS,
  readBlockMs: 1_000,
  runEventBudgetBytes: 32 * 1_024 * 1_024,
  runIdleMs: LOCAL_AGENT_RUN_IDLE_TIMEOUT_SECONDS * 1_000,
  startAckMs: 30_000,
});

/** Every key the bridge writes, in one place. Ids are server-minted uuids, never caller text. */
export const keys = {
  /** Session Redis: one pending pairing, under the digest of its device code. */
  pairing: (deviceCodeHash: string) => `local-agent:pairing:${deviceCodeHash}`,
  /** Session Redis: the user code's pointer to the pairing above. */
  pairingCode: (userCode: string) => `local-agent:pairing-code:${userCode}`,
  /** Stream Redis: the id of the device's live connection, TTL'd. Its existence is "online". */
  presence: (deviceId: string) => `local-agent:presence:${deviceId}`,
  /** Stream Redis: the device's last status report, policy recomputed. */
  status: (deviceId: string) => `local-agent:status:${deviceId}`,
  /** Stream Redis: the device's command stream, the SSE `id:` its entry id. */
  commands: (deviceId: string) => `local-agent:cmd:${deviceId}`,
  /**
   * Stream Redis: the companion's events for one turn of a run, entry id `<seq>-0` (the dedupe).
   * Per turn, so a late retry of turn 1 never lands in, or is deduped against, turn 2.
   */
  runEvents: (runId: string, turn: number) => `local-agent:run:${runId}:events:${String(turn)}`,
  /** Stream Redis: bytes of event JSON one turn has uploaded (the budget). */
  runBytes: (runId: string, turn: number) => `local-agent:run:${runId}:bytes:${String(turn)}`,
  /**
   * Stream Redis: the turn the executor is running (`turn`, `startedAt` ms). Set before
   * `run.start` and dropped when the turn ends; the uplink accepts only this turn's events.
   */
  runTurn: (runId: string) => `local-agent:run:${runId}:turn`,
  /** Stream Redis: approval decisions (and aborts: revoked, over budget) on their way to the executor. */
  runControl: (runId: string) => `local-agent:run:${runId}:control`,
  /** Stream Redis: requestId → deadline (ms) of every approval still waiting. */
  runApprovals: (runId: string) => `local-agent:run:${runId}:approvals`,
  /** Stream Redis: how far the executor has read both run streams. */
  runCursor: (runId: string) => `local-agent:run:${runId}:cursor`,
  /**
   * Stream Redis pub/sub channel (spec 041): a cloud device's sign-in commands, delivered live to
   * its open command stream and never stored — the one-time code travels only here.
   */
  auth: (deviceId: string) => `local-agent:auth:${deviceId}`,
  /** Stream Redis: a home's sign-in in progress (phase, the Anthropic URL, its expiry). TTL'd. */
  signIn: (deviceId: string) => `local-agent:sign-in:${deviceId}`,
  /** Stream Redis: a home's last `claude auth status` verdict (no identifiers), kept past restarts. */
  homeAuth: (deviceId: string) => `local-agent:home-auth:${deviceId}`,
  /** Stream Redis: one home start at a time across processes. */
  homeStart: (homeId: string) => `local-agent:home-start:${homeId}`,
  /** Stream Redis: the egress allowlist last applied to a home's sandbox (comma-joined CIDRs). */
  homeEgress: (deviceId: string) => `local-agent:home-egress:${deviceId}`,
  /** Stream Redis: a person's fixed-window count of one subscription action (connect, code, cancel). */
  homeThrottle: (action: string, userId: string) => `local-agent:home-throttle:${action}:${userId}`,
  /** Stream Redis: what the person is told after a disconnect that could not sign the CLI out. */
  homeNote: (userId: string) => `local-agent:home-note:${userId}`,
} as const;

export const COMMAND_STREAM_MAXLEN = 1_000;
export const RUN_STREAM_MAXLEN = 10_000;
/** Command and run streams outlive a day of quiet by nothing. */
export const STREAM_TTL_SECONDS = 86_400;
/** A status report kept this long; every heartbeat of a live connection extends it. */
export const STATUS_TTL_SECONDS = 86_400;
/** A device id's uplink budget, beside the per-address one (spec 040 § 5): requests per minute. */
export const DEVICE_EVENTS_PER_MINUTE = 1_200;
/** A home's sign-in verdict outlives its archive (7 days) by a margin; refreshed on every report. */
export const HOME_AUTH_TTL_SECONDS = 30 * 86_400;
/** `last_seen_at` is written at most this often per device. */
export const LAST_SEEN_EVERY_MS = 60_000;
