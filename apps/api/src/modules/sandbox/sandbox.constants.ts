import type { TenantTransaction } from '../../database/database.types';

/**
 * The sandbox module's injection token and the bounds its guards enforce (spec 010, research
 * R9). A provider like `AGENT_TIMINGS` rather than a constant, so the e2e can shorten the wall
 * clock and the unit tests can lower every cap without editing this file.
 */
export const DAYTONA_TIMINGS = Symbol('forge.sandbox.daytona-timings');

export interface DaytonaTimings {
  /** A bundle (`download`, spec 016) over this is refused before it is fetched. */
  readonly bundleCapBytes: number;
  /** The programs `exec` may name as its first token, by base name (§04). */
  readonly execAllowlist: readonly string[];
  /** Added to the wall clock on the `fetch` abort, so a dead proxy cannot hold the worker. */
  readonly execAbortMarginMs: number;
  /** The daemon's `timeout`, after which it kills the process group and answers `408`. */
  readonly execWallClockMs: number;
  /** A file over this is neither read nor edited. */
  readonly fileCapBytes: number;
  /** How long a `GET /sandbox/{id}` answer is trusted before it is asked again. */
  readonly lookupTtlMs: number;
  /** Command output over this keeps its head and tail, halves, with a marker between. */
  readonly outputCapBytes: number;
  /** `AbortSignal.timeout` on every request except `process/execute`. */
  readonly requestTimeoutMs: number;
  /** `search` and `find` return at most this many results. */
  readonly searchCap: number;
  /** Path prefixes dropped from `search` and `find` results; the daemon has no exclusions of its own. */
  readonly searchExcludes: readonly string[];
}

export const DEFAULT_DAYTONA_TIMINGS: DaytonaTimings = Object.freeze({
  bundleCapBytes: 256 * 1024 * 1024,
  execAbortMarginMs: 5_000,
  execAllowlist: Object.freeze([
    'cat',
    'cp',
    'echo',
    'git',
    'grep',
    'head',
    'ls',
    'mkdir',
    'mv',
    'node',
    'npm',
    'npx',
    'pnpm',
    'pwd',
    'python3',
    'pip',
    'rg',
    'rm',
    'sed',
    'tail',
    'touch',
    'wc',
  ]),
  execWallClockMs: 120_000,
  fileCapBytes: 2 * 1024 * 1024,
  lookupTtlMs: 30_000,
  outputCapBytes: 64 * 1024,
  requestTimeoutMs: 10_000,
  searchCap: 200,
  searchExcludes: Object.freeze(['node_modules/', '.git/', 'dist/']),
});

/**
 * The lifecycle's clocks and caps (spec 014, research R12): one injectable like `DAYTONA_TIMINGS`,
 * overridden per suite by `overrideProvider` so a test never waits a real minute.
 */
export const SANDBOX_TIMINGS = Symbol('forge.sandbox.timings');

export interface SandboxTimings {
  /** `hibernated` with `state_entered_at` older than this is archived by the sweep. */
  readonly archiveAfterMs: number;
  /** A template build (create, upload, install, stop, capture) is failed after this (spec 015). */
  readonly buildTimeoutMs: number;
  /** `idle` with `state_entered_at` older than this is hibernated by the sweep. */
  readonly hibernateAfterMs: number;
  /** `active` with `last_seen_at` older than this is idle. */
  readonly idleAfterMs: number;
  /** A Daytona sandbox carrying our owner label but no row is released after this. */
  readonly orphanGraceMs: number;
  /** Total wait for a sandbox to answer `started` before the op fails. */
  readonly readyBudgetMs: number;
  /** How often the op polls Daytona for readiness. */
  readonly readyPollMs: number;
  /** How many pool rows one refill tick creates at most. */
  readonly refillBatch: number;
  /** How often the executor re-asks `ensureReady` while a run waits. */
  readonly runWaitPollMs: number;
  /** How long a run waits for its sandbox before failing `sandbox unavailable`. */
  readonly runWaitMs: number;
  /** The scheduler's `setInterval`. */
  readonly schedulerTickMs: number;
  /** How often the publisher polls a captured snapshot for `active` (spec 015). */
  readonly snapshotPollMs: number;
  /** A `transition` older than this is presumed lost and reconciled. */
  readonly staleTransitionMs: number;
  /** `last_seen_at` is written at most once per this window. */
  readonly touchCoalesceMs: number;
}

export const DEFAULT_SANDBOX_TIMINGS: SandboxTimings = Object.freeze({
  archiveAfterMs: 14 * 24 * 60 * 60_000,
  buildTimeoutMs: 900_000,
  hibernateAfterMs: 60 * 60_000,
  idleAfterMs: 20 * 60_000,
  orphanGraceMs: 15 * 60_000,
  readyBudgetMs: 120_000,
  readyPollMs: 2_000,
  refillBatch: 8,
  runWaitMs: 180_000,
  runWaitPollMs: 2_000,
  schedulerTickMs: 30_000,
  snapshotPollMs: 2_000,
  staleTransitionMs: 10 * 60_000,
  touchCoalesceMs: 60_000,
});

/**
 * The dev server supervisor's clocks and caps (spec 023, data-model §5): a third injectable beside
 * `DAYTONA_TIMINGS` and `SANDBOX_TIMINGS`, delivered into the sandbox as compact JSON on the
 * `FORGE_DEV_TIMINGS` line of the env file, so the supervisor and the tests read the same numbers.
 */
export const DEV_SERVER_TIMINGS = Symbol('forge.sandbox.dev-server-timings');

export interface DevServerTimings {
  /** Doubles per attempt: 1, 2, 4, 8, 16 s. */
  readonly backoffBaseMs: number;
  /** After `failed`; no CPU between attempts (research R5). */
  readonly coldRetryMs: number;
  /** Truncate, do not rotate — there is no reader (research R7). */
  readonly logCapBytes: number;
  /** SC-005's ten seconds with room to spare. */
  readonly probeIntervalMs: number;
  /** A child that survives this long earns a fresh budget. */
  readonly stableResetMs: number;
  /** With the backoff above, 31 s of waiting — inside SC-004's two minutes. */
  readonly startAttempts: number;
}

export const DEFAULT_DEV_SERVER_TIMINGS: DevServerTimings = Object.freeze({
  backoffBaseMs: 1_000,
  coldRetryMs: 300_000,
  logCapBytes: 1_048_576,
  probeIntervalMs: 500,
  stableResetMs: 60_000,
  startAttempts: 5,
});

/** `pg_try_advisory_xact_lock` key, one per scheduler tick (research R7). */
export const MAINTENANCE_LOCK = 7_301_014n;

export type MaintenanceJob =
  | 'sandbox.sweep'
  | 'sandbox.refill'
  | 'sandbox.reconcile'
  | 'connector.verify'
  | 'connector.sync-reconcile'
  | 'connector.ops-timeout'
  | 'byok.verify'
  | 'byos.verify'
  | 'webhook.retention'
  | 'deploy.sweep'
  | 'domain.check'
  | 'webhook.redeliver';

/**
 * The scheduler's catalogue: `periodStart = floor(now / periodMs) × periodMs` per job.
 * `connector.verify` is spec 018's daily health sweep (research R9), consumed by `connectors`;
 * `connector.sync-reconcile` spec 044's auto-sync backstop, every 5 min, consumed by `connectors`;
 * `connector.ops-timeout` spec 030's stale connector-operation sweep, every 5 min, consumed by
 * `connectors`;
 * `byok.verify` spec 020's daily provider-key check (US4), consumed by `agent/byok`;
 * `webhook.retention` the daily retention sweep (spec 026 R15, spec 029 R12, ADR 051) — bodies
 * nulled at seven days, rows deleted at thirty, over `webhook_deliveries` and, per org, the
 * outbound log — consumed by `webhooks`;
 * `deploy.sweep` spec 027's stuck-deployment sweep (R8), consumed by `deploy`;
 * `domain.check` spec 028's custom-domain check routine, every 60 s, consumed by `deploy`;
 * `webhook.redeliver` spec 029's outbound redelivery sweep (R6), every 60 s, consumed by
 * `webhooks`: it finds pending sends whose `next_attempt_at` has passed and re-appends their
 * `webhook.attempt-due`.
 */
// ponytail: job catalogue lives in sandbox; move to outbox when a third module needs it
export const MAINTENANCE_JOBS: readonly {
  readonly job: MaintenanceJob;
  readonly periodMs: number;
}[] = Object.freeze([
  { job: 'sandbox.sweep', periodMs: 60_000 },
  { job: 'sandbox.refill', periodMs: 60_000 },
  { job: 'sandbox.reconcile', periodMs: 300_000 },
  { job: 'connector.verify', periodMs: 86_400_000 },
  { job: 'connector.sync-reconcile', periodMs: 300_000 },
  { job: 'connector.ops-timeout', periodMs: 300_000 },
  { job: 'byok.verify', periodMs: 86_400_000 },
  { job: 'byos.verify', periodMs: 86_400_000 },
  { job: 'webhook.retention', periodMs: 86_400_000 },
  { job: 'deploy.sweep', periodMs: 300_000 },
  { job: 'domain.check', periodMs: 60_000 },
  { job: 'webhook.redeliver', periodMs: 60_000 },
] as const);

export const SANDBOX_OPS_QUEUE = 'sandbox.ops';
export const MAINTENANCE_QUEUE = 'maintenance';

/** The Redis list of `sandbox_pool.id`s ready to hand out, one per template. */
export const poolFrontKey = (template: string): string => `sandbox-pool:${template}`;

/**
 * Mints the sandbox callback token (spec 017 R11) — the signer lives in `preview`, which this
 * module may not import, so `PreviewModule` binds it under this symbol. `leaseEpoch` is `0`
 * until `sandboxes` carries a lease counter (the guard's `SANDBOX_LEASE_EPOCH` floor).
 */
export const SANDBOX_CALLBACK_MINTER = Symbol('forge.sandbox.callback-minter');

export type SandboxCallbackMinter = (claims: {
  readonly leaseEpoch: number;
  readonly org: string;
  readonly project: string;
  readonly sandbox: string;
}) => Promise<string>;

/**
 * Where the token lands inside the sandbox: a dotenv file, not a container env, because a pool
 * sandbox is created before its project exists and a resume cannot change a running env. `/tmp`
 * because every path that writes it (create, the pool claim's label, resume) runs against a
 * started sandbox and rewrites it whole.
 */
export const SANDBOX_CALLBACK_ENV_PATH = '/tmp/forge-callback.env';

/**
 * The supervisor, uploaded verbatim from the API image on every delivery (spec 023,
 * contracts/dev-supervisor §1), so a fix reaches a sandbox at its next claim or resume with no
 * rebuild. `/tmp` for the same reason as the env file, and so it is in no checkpoint or bundle.
 */
export const SANDBOX_DEV_SUPERVISOR_PATH = '/tmp/forge-devserver.mjs';

/** The supervisor's own pid; a live pid here refuses a second start (contracts §3). */
export const SANDBOX_DEV_PID_PATH = '/tmp/forge-devserver.pid';

/** The child's merged stdout/stderr, truncated past `logCapBytes`. */
export const SANDBOX_DEV_LOG_PATH = '/tmp/forge-devserver.log';

/**
 * The project's connector values (spec 030, contracts/preview-env.md § 1): written by the same
 * delivery as the callback file, for project sandboxes only, and handed by the supervisor to the
 * dev server child alone. Rewritten whole each time, empty when the project contributes nothing.
 */
export const SANDBOX_PROJECT_ENV_PATH = '/tmp/forge-project.env';

/**
 * The only keys the project file may carry (contracts/preview-env.md § 2). A constant, so the
 * source cannot emit another; none begins with `FORGE_`.
 */
export const PREVIEW_ENV_KEYS = [
  'DATABASE_URL',
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  'RESEND_API_KEY',
  'RESEND_FROM_DOMAIN',
] as const;

export type PreviewEnvKey = (typeof PREVIEW_ENV_KEYS)[number];

/**
 * The project's preview values, read from its bindings' live resources (contracts/preview-env.md
 * § 3). Provided by `connectors` under {@link PREVIEW_ENV_SOURCE} — this module may not import it.
 * Never throws and never calls a provider: any failure is `{}` for that binding.
 */
export type PreviewEnvSource = (
  tx: TenantTransaction,
  orgId: string,
  projectId: string,
) => Promise<Readonly<Partial<Record<PreviewEnvKey, string>>>>;

export const PREVIEW_ENV_SOURCE = Symbol('forge.sandbox.preview-env-source');
